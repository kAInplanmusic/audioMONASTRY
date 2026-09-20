/**
 * audioMONASTRY · Session-Routen (ARCH-P2-002, Extraktion aus server.ts)
 * =======================================================================
 *   POST /api/session/reset    → autoritativen Session-State zurücksetzen
 *                                (E2E/Dev-Hook; Production: 404)
 *   GET  /api/session/state    → Lesezugriff auf genau diesen Zustand
 *                                (gleiche Schranke; Beleg statt Behauptung)
 *   POST /api/session/autosave → idempotenter Remote-Sink für den
 *                                Session-Autosave (R2, PutObject je Key)
 *
 * Die Routen brauchen server.ts-Modul-Scope (Session, Auth-Helfer, R2) –
 * deshalb als Factory mit explizitem `SessionRoutesDeps`-Kontext.
 *
 * Begruendungen (unveraendert aus server.ts uebernommen):
 * - /reset ist ein E2E/Dev-Hook: die In-Memory-Session lebt ueber einzelne
 *   Browser-Kontexte hinaus, Tests brauchen einen deterministischen Start bei
 *   OFF/Lock-frei. Production bleibt fail-closed (404).
 * - /autosave ist der Remote-Sink fuer den Session-Autosave: der Umschlag
 *   traegt einen stabilen idempotencyKey, wiederholtes Senden schreibt also
 *   DASSELBE R2-Objekt (PutObject ist idempotent je Key), nie eine neue
 *   Revision.
 *
 * ---------------------------------------------------------------------------
 * F8-Fix (docs/FIXPLAN_2026-09-20_externer_apptest.md, F8)
 * ---------------------------------------------------------------------------
 * Befund: „`/api/session/reset` ist in Produktion 404 → E2E-Läufe können den
 * serverautoritativen Zustand nicht isolieren.“ Der Endpunkt war die zahnlose
 * Hälfte davon: er war **ohne expliziten Schalter** aktiv (jeder Nicht-
 * Production-Knoten mit gesetztem Studio-Token hatte ihn offen), und er
 * **behauptete** den Reset, ohne ihn belegbar zu machen — es gab keinen Weg,
 * den Zustand danach zu LESEN.
 *
 * Deshalb jetzt:
 *   * **Zwei Schlösser**: `NODE_ENV !== 'production'` UND der explizite Schalter
 *     `AUDIOMONASTRY_TEST_RESET=1`. Fehlt eines, antwortet die Route wie ein
 *     nicht existierender Pfad (404) — in Produktion wird nicht einmal die
 *     Existenz des Hooks bestätigt.
 *   * **Token bleibt Pflicht**, sobald ein Studio-Token konfiguriert ist (dann
 *     auch im Testmodus, in dem die übrige API offen wäre: der Reset ist der
 *     destruktivste Aufruf, den es gibt).
 *   * **Belegbarer Reset**: Revision, Modul-States und Locks werden ersetzt UND
 *     zurückgelesen (`previous` gegen `revision/moduleStates/locks` NACH dem
 *     Austausch). `GET /api/session/state` macht denselben Zustand lesbar — erst
 *     damit ist „Zustand wirklich zurückgesetzt“ eine Messung statt einer Zusage.
 *   * **Session-Instanz-ID**: neue Instanz = neue ID. Ein E2E-Lauf kann damit
 *     belegen, dass er auf frischem Zustand läuft (und ein Log verrät, ob
 *     zwischendurch jemand resettet hat).
 *
 * ---------------------------------------------------------------------------
 * FIX F2 (c) – Log-Flut und Stille (gleiche Datei, /autosave)
 * ---------------------------------------------------------------------------
 * - Begrenzte Wiederholungen mit exponentiellem Backoff (dieselbe
 *   Implementierung wie beim lokalen Autosave-Kern: `retryWithBackoff`), danach
 *   GENAU EINE Warnung je Fehlerklasse statt einer Zeile pro Anfrage. Der
 *   Live-Befund waren 20 identische `SignatureDoesNotMatch`-Zeilen.
 * - Wiederholt wird nur, was sich durch Wiederholen bessern kann
 *   (Timeout/DNS/5xx). Ein Signatur- oder Rechtefehler ist deterministisch –
 *   ihn N-mal zu wiederholen erzeugt Last und Log, aber keinen Erfolg.
 * - Das Ergebnis wird als Betriebszustand vermerkt (`recordAutosaveOutcome`),
 *   sichtbar als `cloud.writes.autosave` in `/api/metrics`. Vorher meldete die
 *   Route 502 und der Rest des Systems erfuhr nichts davon.
 */
import type { Express } from 'express';
import {
  AuthoritativeSession,
  type AuthoritativeSessionSnapshot,
} from '../../src/core/session/authoritativeSession';
import { retryWithBackoff, type RetryOptions } from '../../src/core/persistence/sessionAutosave';
import { SessionAutosaveEnvelopeSchema } from '../../src/types/zod/schemas';
import {
  isRetryableR2Problem,
  logR2Once,
  r2ProblemHint,
  recordAutosaveOutcome,
  toR2WriteError,
} from '../r2Health';

export interface SessionRoutesDeps {
  isProductionEnv: boolean;
  /**
   * F8: expliziter Dev-/Test-Schalter (`AUDIOMONASTRY_TEST_RESET=1`). Ohne ihn
   * ist der Hook auch außerhalb der Produktion abwesend (404).
   */
  testResetEnabled: boolean;
  studioAccessToken: string;
  tokenFromRequest(req: unknown): string;
  safeTokenEqual(a: string, b: string): boolean;
  newSession(): AuthoritativeSession;
  /** Live-Sicht auf den autoritativen Zustand (fuer den Rueck-Lesebeleg). */
  getSession(): AuthoritativeSession;
  replaceSession(session: AuthoritativeSession): void;
  /** Frischen Zustand sofort persistieren (sonst laedt ein Neustart den alten). */
  persistSession(): void;
  clearSaveTimer(): void;
  serverIo: { to(room: string): { emit(event: string, payload: unknown): void } } | null;
  uploadToR2(key: string, body: Buffer, contentType: string): Promise<{ url: string }>;
  /** Test-/Ops-Haken für das Retry-Verhalten (Versuche/Backoff). */
  autosaveRetry?: RetryOptions;
}

/**
 * Grenzen des Autosave-Retrys. Env-überschreibbar, aber hart gekappt: der
 * Autosave darf den Client (und den Request) nicht beliebig lange blockieren.
 * Tests setzen `R2_AUTOSAVE_RETRY_BASE_MS=0` und `…_ATTEMPTS=1`, um die
 * SDK-eigene Wiederholung als einzige Variable auszuschließen.
 */
export function autosaveRetryOptions(
  env: Record<string, string | undefined> = process.env,
  override?: RetryOptions,
): RetryOptions {
  const intFromEnv = (name: string, fallback: number, min: number, max: number): number => {
    const raw = (env[name] ?? '').trim();
    const parsed = Number(raw);
    if (!raw || !Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(parsed)));
  };
  return {
    attempts: intFromEnv('R2_AUTOSAVE_RETRY_ATTEMPTS', 3, 1, 5),
    baseDelayMs: intFromEnv('R2_AUTOSAVE_RETRY_BASE_MS', 250, 0, 5_000),
    maxDelayMs: intFromEnv('R2_AUTOSAVE_RETRY_MAX_MS', 2_000, 0, 30_000),
    ...override,
  };
}

/** Zaehlbare Sicht auf einen Snapshot — dieselben Zahlen im Log und im JSON. */
export function summarizeAuthoritativeSession(
  snapshot: AuthoritativeSessionSnapshot,
): { revision: number; moduleStates: number; locks: number } {
  return {
    revision: snapshot.revision,
    moduleStates: Object.keys(snapshot.modules ?? {}).length,
    locks: Array.isArray(snapshot.locks) ? snapshot.locks.length : 0,
  };
}

export function registerSessionRoutes(app: Express, deps: SessionRoutesDeps): void {
  // Session-Instanz: neue ID bei jedem Reset. „Revision 0“ allein waere kein
  // Beweis — ein frisch gestarteter Prozess hat sie auch.
  let instanceSeq = 0;
  const newInstanceId = (): string => `session-${Date.now().toString(36)}-${(instanceSeq += 1).toString(36)}`;
  let instanceId = newInstanceId();
  let instanceStartedAt = Date.now();

  /** Ist der Reset-Hook in DIESEM Prozess aktiv? (F8: zwei Schloesser) */
  const resetHookEnabled = (): boolean => !deps.isProductionEnv && deps.testResetEnabled;

  /**
   * Token-Schranke des Hooks: der Studio-Token, verglichen in konstanter Zeit.
   * Ist KEIN Studio-Token konfiguriert, lehnt der Hook ab (401) — der Reset ist
   * der destruktivste Aufruf, den es gibt; er soll nicht der einzige Endpunkt
   * sein, der sich im offenen Dev-Modus ohne Token bedienen laesst. Genau diese
   * Erwartung haelt auch der Bestandstest in tests/server.test.ts fest.
   */
  const tokenAccepted = (req: unknown): boolean => {
    const token = deps.tokenFromRequest(req);
    return Boolean(token) && Boolean(deps.studioAccessToken) && deps.safeTokenEqual(token, deps.studioAccessToken);
  };

  app.post('/api/session/reset', (req, res) => {
    // F8: Produktion ODER fehlender Schalter → 404 wie ein nicht existierender
    // Pfad. Bewusst kein 403 mit Begruendung: in Produktion soll der Hook nicht
    // einmal in seiner Existenz bestaetigt werden.
    if (!resetHookEnabled()) {
      res.status(404).end();
      return;
    }
    if (!tokenAccepted(req)) {
      res.status(401).json({ error: 'unauthorized', code: 'STUDIO_TOKEN_REQUIRED' });
      return;
    }
    const previous = summarizeAuthoritativeSession(deps.getSession().snapshot());
    deps.replaceSession(deps.newSession());
    // Der Save-Timer trug den ALTEN Zustand — erst abbrechen, dann den frischen
    // Zustand persistieren (sonst koennte ein Neustart die alten Locks laden).
    deps.clearSaveTimer();
    deps.persistSession();
    instanceId = newInstanceId();
    instanceStartedAt = Date.now();
    // Rueckgelesen aus dem AUSGETAUSCHTEN Zustand — nicht behauptet, gemessen.
    const after = summarizeAuthoritativeSession(deps.getSession().snapshot());
    res.setHeader('Cache-Control', 'no-store');
    deps.serverIo?.to('session:studio-session').emit('session-reset', {
      ts: Date.now(),
      sessionInstanceId: instanceId,
      revision: after.revision,
    });
    res.json({
      status: 'reset',
      sessionInstanceId: instanceId,
      sessionStartedAt: new Date(instanceStartedAt).toISOString(),
      previous,
      ...after,
    });
  });

  /**
   * F8: Lesezugriff auf den autoritativen Zustand — dieselbe Schranke wie der
   * Reset (Production 404, Dev ohne Schalter 404, Token Pflicht). Ein E2E-Lauf
   * vergleicht `sessionInstanceId`/`revision` VOR und NACH dem Reset; ohne
   * diesen Pfad bliebe „wirklich zurückgesetzt“ eine Vermutung.
   */
  app.get('/api/session/state', (req, res) => {
    if (!resetHookEnabled()) {
      res.status(404).end();
      return;
    }
    if (!tokenAccepted(req)) {
      res.status(401).json({ error: 'unauthorized', code: 'STUDIO_TOKEN_REQUIRED' });
      return;
    }
    const snapshot = deps.getSession().snapshot();
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      status: 'ok',
      sessionInstanceId: instanceId,
      sessionStartedAt: new Date(instanceStartedAt).toISOString(),
      revision: snapshot.revision,
      modules: snapshot.modules ?? {},
      locks: snapshot.locks ?? [],
      sequences: snapshot.sequences ?? {},
      ts: new Date().toISOString(),
    });
  });

  app.post('/api/session/autosave', async (req, res) => {
    const parsed = SessionAutosaveEnvelopeSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        ok: false,
        error: 'invalid autosave payload',
        details: parsed.error.issues.slice(0, 5),
      });
    }
    const envelope = parsed.data;
    const objectKey = `autosaves/${envelope.idempotencyKey}.json`;
    const body = Buffer.from(JSON.stringify(envelope), 'utf8');

    let usedAttempts = 0;
    try {
      // F2(c): begrenzte Wiederholungen mit Backoff. Umschlag und damit
      // `idempotencyKey` bleiben über alle Versuche identisch – ein Retry
      // schreibt denselben Key, nie eine neue Revision.
      const result = await retryWithBackoff(async () => {
        usedAttempts += 1;
        return deps.uploadToR2(objectKey, body, 'application/json');
      }, {
        ...autosaveRetryOptions(process.env, deps.autosaveRetry),
        // Nicht wiederholbare Klassen sofort durchreichen (siehe Modulkopf).
        shouldRetry: (error) => isRetryableR2Problem(toR2WriteError(error).problem),
      });

      recordAutosaveOutcome({ ok: true, attempts: usedAttempts });
      return res.json({ ok: true, idempotent: true, key: objectKey, url: result.url });
    } catch (error) {
      const writeError = toR2WriteError(error, Math.max(1, usedAttempts));
      const unconfigured = writeError.problem === 'not-configured' || writeError.problem === 'bucket-missing';
      const transient = isRetryableR2Problem(writeError.problem);

      // Betriebszustand statt Stille: `cloud.writes.autosave` in /api/metrics.
      recordAutosaveOutcome({
        ok: false,
        problem: writeError.problem,
        message: writeError.message,
        attempts: Math.max(1, usedAttempts),
      });

      // GENAU EINE Warnung je Fehlerklasse (Wiederholungen werden gezählt,
      // nicht geloggt). Erholt sich R2, setzt der Healthcheck die Signatur
      // zurück – ein erneuter Ausfall warnt dann wieder.
      logR2Once(
        `autosave:${writeError.problem}`,
        `[session] /api/session/autosave fehlgeschlagen [${writeError.problem}] nach ${Math.max(1, usedAttempts)} Versuch(en): `
        + `${writeError.message}. ${r2ProblemHint(writeError.problem)} `
        + (transient
          ? 'Weitere identische Meldungen werden unterdrückt (Zähler: /api/metrics → cloud.writes.autosave).'
          : 'Wiederholen ist hier zwecklos – die Konfiguration muss korrigiert werden (docs/OPS_RUNBOOK.md, „R2 (F2)“).'),
        transient ? 'warn' : 'error',
      );

      return res.status(unconfigured ? 503 : 502).json({
        ok: false,
        error: unconfigured ? 'r2-not-configured' : 'session-autosave-failed',
        reason: writeError.problem,
        degraded: true,
        attempts: Math.max(1, usedAttempts),
        retryable: transient,
        hint: r2ProblemHint(writeError.problem),
      });
    }
  });
}
