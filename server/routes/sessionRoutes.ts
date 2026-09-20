/**
 * audioMONASTRY · Session-Routen (ARCH-P2-002, Extraktion aus server.ts)
 * =======================================================================
 *   POST /api/session/reset    → autoritativen Session-State zurücksetzen
 *                                (E2E/Dev-Hook; Production: 404)
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
 * FIX F2 (c) – Log-Flut und Stille:
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
import { AuthoritativeSession } from '../../src/core/session/authoritativeSession';
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
  studioAccessToken: string;
  tokenFromRequest(req: unknown): string;
  safeTokenEqual(a: string, b: string): boolean;
  newSession(): AuthoritativeSession;
  replaceSession(session: AuthoritativeSession): void;
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

export function registerSessionRoutes(app: Express, deps: SessionRoutesDeps): void {
  app.post('/api/session/reset', (req, res) => {
    if (deps.isProductionEnv) {
      res.status(404).end();
      return;
    }
    const token = deps.tokenFromRequest(req);
    if (!token || !deps.safeTokenEqual(token, deps.studioAccessToken)) {
      res.status(401).json({ error: 'unauthorized', code: 'STUDIO_TOKEN_REQUIRED' });
      return;
    }
    deps.replaceSession(deps.newSession());
    deps.clearSaveTimer();
    deps.serverIo?.to('session:studio-session').emit('session-reset', { ts: Date.now() });
    res.json({ status: 'reset' });
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
