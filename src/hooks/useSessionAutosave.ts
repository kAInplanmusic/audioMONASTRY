import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SessionAutosave, retryWithBackoff, type RetryOptions } from '../core/persistence/sessionAutosave';
import { createBestEffortStore, type BestEffortStore } from '../core/persistence/browserStore';
import type { SnapshotEnvelope } from '../core/persistence/snapshotEnvelope';
import { storageGetJson, storageSetJson } from '../utils/storage';

/**
 * audioMONASTRY · App-Wiring für den Session-Autosave (PERSIST-P1-002)
 * =====================================================================
 * Hängt den reinen Persistenz-Kern (`SessionAutosave`) an die React-App:
 *   - lokaler Store: IndexedDB, sonst ehrlicher In-Memory-Fallback
 *   - `schedule(payload)` debounced speichern (schnelle Änderungen coalescen)
 *   - `flush()` bei `pagehide` (Tab zu / Reload) → letzter Stand geht nicht verloren
 *   - Remote-Sync des letzten Umschlags an `/api/session/autosave`
 *     (Idempotenz über den stabilen `idempotencyKey` des Umschlags)
 *
 * AUDIT-2026-10-30-P1-018: Der Remote-Sync ist NICHT mehr „fire and forget“.
 * Der Server bestätigt ausdrücklich (`{ ok: true, idempotent: true, key, url }`)
 * und antwortet im Fehlerfall mit 502/503 + `degraded`/`retryable`/`attempts`
 * (`server/routes/sessionRoutes.ts`). Der Client:
 *   1. liest die Antwort (`res.ok`, `ok === true` und den R2-`key`),
 *   2. wiederholt 5xx/429/Netzfehler mit exponentiellem Backoff – 4xx nicht,
 *   3. legt den Umschlag VOR dem Senden in eine persistente Outbox
 *      (`src/utils/storage.ts`, dieselbe Schicht wie der übrige Studio-Speicher)
 *      und entfernt ihn erst nach Bestätigung,
 *   4. sendet die Outbox beim Mount erneut (Reload/Absturz) und wiederholt
 *      offene Umschläge, solange die Seite lebt,
 *   5. meldet den Zustand sichtbar (`sync` → Statuszeile im Footer).
 *
 * Der Umschlag bleibt über alle Versuche identisch: derselbe
 * `idempotencyKey` schreibt serverseitig denselben R2-Key, nie eine neue
 * Revision – mehrfaches Senden ist deshalb gefahrlos.
 */

/** Outbox-Schlüssel im Studio-Speicher (Server-vorgeladen, überlebt Reload). */
export const AUTOSAVE_OUTBOX_KEY = 'audiomonastry_autosave_outbox';

/** Zweitablage im lokalen Store des Autosave-Kerns (IndexedDB, falls vorhanden). */
const OUTBOX_STORE_KEY = 'session-autosave-outbox';

/**
 * Deckel gegen unbegrenztes Wachstum, wenn der Server lange nicht bestätigt.
 * Bewusst klein: der Studio-Speicher nimmt je Wert höchstens 512 KB
 * (`MAX_STORE_VALUE_CHARS`), und jeder Eintrag trägt den vollen Umschlag.
 */
const MAX_OUTBOX_ENTRIES = 5;

/** Wartezeit zwischen zwei Hintergrund-Versuchen für offene Umschläge. */
export const OUTBOX_RETRY_INTERVAL_MS = 30_000;

const AUTOSAVE_ENDPOINT = '/api/session/autosave';

const DEFAULT_RETRY: RetryOptions = { attempts: 3, baseDelayMs: 250, maxDelayMs: 5_000 };

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * `idle`    = nichts zu senden (noch keine Änderung)
 * `pending` = Umschläge offen, letzter Versuch ohne Fehler
 * `failed`  = Umschläge offen, letzter Versuch mit Fehler (Grund in `lastError`)
 * `sending` = Übertragung läuft
 * `synced`  = alles bestätigt
 */
export type AutosaveSyncState = 'idle' | 'sending' | 'synced' | 'pending' | 'failed';

export interface AutosaveSyncStatus {
  state: AutosaveSyncState;
  /** Anzahl unbestätigter Umschläge (Outbox). */
  pending: number;
  /** Versuche für den zuletzt gesendeten Umschlag. */
  attempts: number;
  /** Vom Server bestätigter Ablage-Schlüssel (`autosaves/<key>.json`). */
  lastKey: string | null;
  /** Kurzgrund des letzten Fehlschlags, ohne Zugangsdaten. */
  lastError: string | null;
  lastConfirmedAt: number | null;
}

/** Ein unbestätigter Umschlag, wie er in der Outbox liegt. */
export interface OutboxEntry {
  idempotencyKey: string;
  revision: number;
  envelope: SnapshotEnvelope;
  attempts: number;
  lastError: string | null;
  queuedAt: number;
  lastAttemptAt: number | null;
}

const IDLE: AutosaveSyncStatus = {
  state: 'idle',
  pending: 0,
  attempts: 0,
  lastKey: null,
  lastError: null,
  lastConfirmedAt: null,
};

// ---------------------------------------------------------------------------
// Outbox (persistente Ablage)
// ---------------------------------------------------------------------------

function isOutboxEntry(value: unknown): value is OutboxEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  const envelope = entry.envelope as Record<string, unknown> | undefined;
  return typeof entry.idempotencyKey === 'string'
    && entry.idempotencyKey.length > 0
    && !!envelope
    && typeof envelope === 'object'
    && typeof envelope.idempotencyKey === 'string'
    && typeof envelope.revision === 'number'
    && 'payload' in envelope;
}

/** Outbox lesen (nur gültige Umschläge; defekte Einträge werden verworfen). */
export function readAutosaveOutbox(): OutboxEntry[] {
  const raw = storageGetJson<unknown>(AUTOSAVE_OUTBOX_KEY);
  if (!Array.isArray(raw)) return [];
  return raw.filter(isOutboxEntry);
}

/** Outbox schreiben (Studio-Speicher + lokaler Store des Autosave-Kerns). */
function writeAutosaveOutbox(entries: OutboxEntry[], local: BestEffortStore['store']): void {
  storageSetJson(AUTOSAVE_OUTBOX_KEY, entries);
  void local.set(OUTBOX_STORE_KEY, JSON.stringify(entries)).catch(() => {
    /* Best-Effort-Zweitablage; der Studio-Speicher ist die Wahrheit */
  });
}

/** Outbox beider Ablagen zusammenführen (Studio-Speicher gewinnt je Schlüssel). */
async function loadAutosaveOutbox(store: BestEffortStore['store']): Promise<OutboxEntry[]> {
  const fromStorage = readAutosaveOutbox();
  const seen = new Set(fromStorage.map((e) => e.idempotencyKey));
  let fromLocal: OutboxEntry[] = [];
  try {
    const raw = await store.get(OUTBOX_STORE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) fromLocal = parsed.filter(isOutboxEntry);
  } catch {
    /* unlesbar → nur der Studio-Speicher zählt */
  }
  const merged = [...fromStorage];
  for (const entry of fromLocal) {
    if (seen.has(entry.idempotencyKey)) continue;
    seen.add(entry.idempotencyKey);
    merged.push(entry);
  }
  return merged.slice(-MAX_OUTBOX_ENTRIES);
}

/** Neuen Umschlag anhängen; gleicher Schlüssel wird ersetzt (kein Duplikat). */
function enqueue(outbox: OutboxEntry[], envelope: SnapshotEnvelope, now: number): OutboxEntry[] {
  const rest = outbox.filter((e) => e.idempotencyKey !== envelope.idempotencyKey);
  rest.push({
    idempotencyKey: envelope.idempotencyKey,
    revision: envelope.revision,
    envelope,
    attempts: 0,
    lastError: null,
    queuedAt: now,
    lastAttemptAt: null,
  });
  return rest.slice(-MAX_OUTBOX_ENTRIES);
}

// ---------------------------------------------------------------------------
// Übertragung
// ---------------------------------------------------------------------------

/** Fehlschlag einer Übertragung mit der Info, ob Wiederholen sinnvoll ist. */
class AutosaveSyncError extends Error {
  constructor(
    message: string,
    /** HTTP-Status; 0 = Netzfehler (keine Antwort). */
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'AutosaveSyncError';
  }
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Einen Umschlag senden und die Antwort AUSWERTEN.
 * Wirft `AutosaveSyncError`, wenn der Zustand keine Bestätigung ist.
 */
async function postEnvelope(
  envelope: SnapshotEnvelope,
  fetchImpl: FetchLike,
): Promise<{ key: string | null }> {
  let response: Response;
  try {
    response = await fetchImpl(AUTOSAVE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(envelope),
      keepalive: true,
    });
  } catch (error) {
    // Kein Netz/Server weg: der Umschlag bleibt unbestätigt in der Outbox.
    throw new AutosaveSyncError(`Netz: ${errorText(error)}`, 0, true);
  }

  let body: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = await response.json();
    body = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    body = null;
  }

  if (!response.ok) {
    const error = typeof body?.error === 'string' ? body.error : response.statusText;
    const reason = typeof body?.reason === 'string' ? body.reason : null;
    const detail = reason ? `${error}/${reason}` : error;
    // 5xx/429 sind vorübergehend (R2 kurz weg, Proxy, Überlast) → wiederholen.
    // 4xx (ungültige Nutzlast) ist durch Wiederholen nicht heilbar.
    const retryable = response.status >= 500 || response.status === 429 || body?.retryable === true;
    throw new AutosaveSyncError(
      `HTTP ${response.status}${detail ? ` (${detail})` : ''}`,
      response.status,
      retryable,
    );
  }

  if (body?.ok !== true) {
    // 2xx ohne ausdrückliche Bestätigung ist KEIN Erfolg. Wiederholen ist
    // gefahrlos (idempotencyKey), deshalb retryable.
    throw new AutosaveSyncError('Antwort ohne ok:true', response.status, true);
  }

  return { key: typeof body.key === 'string' ? body.key : null };
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface SessionAutosaveHookOptions {
  /** Backoff der lokalen UND der Remote-Wiederholungen. */
  retry?: RetryOptions;
  /** Test-/SSR-Injektion; Default: globales `fetch`. */
  fetchImpl?: FetchLike;
  now?: () => number;
  /** Replay der Outbox beim Mount (Default `true`). */
  replayOnMount?: boolean;
}

export interface SessionAutosaveHandle {
  schedule: (payload: unknown) => void;
  flush: () => Promise<void>;
  /** `indexeddb` = persistent · `memory` = nur für die Sitzung. */
  kind: BestEffortStore['kind'];
  /** Sichtbarer Sync-Zustand (Footer-Statuszeile). */
  sync: AutosaveSyncStatus;
}

/** Kurztext für die Statuszeile (ohne Zugangsdaten, ohne R2-URLs). */
export function describeAutosaveSync(sync: AutosaveSyncStatus): string {
  switch (sync.state) {
    case 'sending':
      return 'Sync läuft';
    case 'synced':
      return 'Sync OK';
    case 'failed':
      return `${sync.pending} offen · Fehler`;
    case 'pending':
      return `${sync.pending} offen`;
    default:
      return 'Sync bereit';
  }
}

export function useSessionAutosave(options: SessionAutosaveHookOptions = {}): SessionAutosaveHandle {
  // Einmalige Instanz pro Mount (useState-Lazy-Init, kein Ref-Zugriff im Render).
  const [state] = useState(() => {
    const best = createBestEffortStore();
    return {
      autosave: new SessionAutosave(best.store, { key: 'session-autosave', retry: DEFAULT_RETRY }),
      store: best.store,
      kind: best.kind,
    };
  });
  const { autosave, store, kind } = state;

  // Options einmalig festnageln: der App-Aufruf übergibt keine Optionen, und
  // ein pro Render neues Objekt würde die Effekt-Kette bei jedem Render neu bauen.
  const nowRef = useRef(options.now ?? (() => Date.now()));
  const fetchRef = useRef<FetchLike>(options.fetchImpl ?? ((input, init) => fetch(input, init)));
  const retryRef = useRef<RetryOptions>(options.retry ?? DEFAULT_RETRY);

  const [sync, setSync] = useState<AutosaveSyncStatus>(() => ({
    ...IDLE,
    pending: readAutosaveOutbox().length,
  }));

  const mounted = useRef(true);
  const chain = useRef<Promise<void>>(Promise.resolve());
  const outboxRef = useRef<OutboxEntry[] | null>(null);

  const publish = useCallback((patch: Partial<AutosaveSyncStatus>) => {
    if (!mounted.current) return;
    setSync((prev) => ({ ...prev, ...patch }));
  }, []);

  /** Outbox lesen (einmalig je Mount aus beiden Ablagen, danach aus dem Ref). */
  const loadOutbox = useCallback(async (): Promise<OutboxEntry[]> => {
    if (outboxRef.current === null) outboxRef.current = await loadAutosaveOutbox(store);
    return outboxRef.current;
  }, [store]);

  const persist = useCallback((next: OutboxEntry[]) => {
    outboxRef.current = next;
    writeAutosaveOutbox(next, store);
  }, [store]);

  /** Einen Umschlag mit Backoff senden; Erfolg = Bestätigung durch den Server. */
  const sendEntry = useCallback(async (entry: OutboxEntry): Promise<{ key: string | null; attempts: number }> => {
    let attempts = 0;
    try {
      const { key } = await retryWithBackoff(async () => {
        attempts += 1;
        return postEnvelope(entry.envelope, fetchRef.current);
      }, {
        ...retryRef.current,
        // 4xx nicht wiederholen; Netzfehler/5xx schon.
        shouldRetry: (error) => !(error instanceof AutosaveSyncError) || error.retryable,
      });
      return { key, attempts };
    } catch (error) {
      // Versuchszahl für Status/Outbox mitführen (Backoff kennt sie sonst nicht).
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), { attempts });
    }
  }, []);

  /** Alle offenen Umschläge senden; der erste endgültige Fehler stoppt den Lauf. */
  const drain = useCallback(async () => {
    const outbox = await loadOutbox();
    if (outbox.length === 0) {
      publish({ pending: 0 });
      return;
    }
    publish({ state: 'sending', pending: outbox.length });

    for (const entry of outbox) {
      try {
        const { key, attempts } = await sendEntry(entry);
        const rest = (outboxRef.current ?? []).filter((e) => e.idempotencyKey !== entry.idempotencyKey);
        persist(rest);
        publish({
          state: rest.length > 0 ? 'pending' : 'synced',
          pending: rest.length,
          attempts,
          lastKey: key,
          lastError: null,
          lastConfirmedAt: nowRef.current(),
        });
      } catch (error) {
        const message = errorText(error);
        const attempts = (error as { attempts?: unknown }).attempts;
        const failed: OutboxEntry = {
          ...entry,
          attempts: typeof attempts === 'number' ? attempts : entry.attempts + 1,
          lastError: message,
          lastAttemptAt: nowRef.current(),
        };
        const next = (outboxRef.current ?? []).map((e) => (
          e.idempotencyKey === entry.idempotencyKey ? failed : e
        ));
        persist(next);
        publish({ state: 'failed', pending: next.length, attempts: failed.attempts, lastError: message });
        return; // Server/Netz ist gerade weg – nicht weiter hämmern
      }
    }
  }, [loadOutbox, persist, publish, sendEntry]);

  /** Läufe serialisieren (Mount-Replay, flush, pagehide dürfen sich nicht überholen). */
  const runDrain = useCallback((): Promise<void> => {
    chain.current = chain.current.then(drain, drain);
    return chain.current;
  }, [drain]);

  const schedule = useCallback((payload: unknown) => {
    autosave.schedule(payload);
  }, [autosave]);

  const flush = useCallback(async () => {
    // pagehide: die Seite kann vor dem ersten `await` sterben. Den bereits
    // bekannten Umschlag deshalb SYNCHRON persistent vormerken (storageSetJson
    // ist synchron) – dann geht er beim nächsten Start auch dann nicht verloren,
    // wenn der Tab mitten im lokalen Schreiben geschlossen wird.
    const known = autosave.getLastEnvelope();
    if (known) {
      const merged = enqueue(outboxRef.current ?? readAutosaveOutbox(), known, nowRef.current());
      persist(merged);
      publish({ state: 'pending', pending: merged.length });
    }

    await autosave.flush();
    const envelope = autosave.getLastEnvelope();
    if (!envelope) return;
    // VOR dem Senden persistent vormerken; gleicher Schlüssel ersetzt sich.
    const merged = enqueue(outboxRef.current ?? readAutosaveOutbox(), envelope, nowRef.current());
    persist(merged);
    publish({ state: 'pending', pending: merged.length });
    await runDrain();
  }, [autosave, persist, publish, runDrain]);

  // Mount = „Reload“: unbestätigte Umschläge erneut senden (Durability).
  const replayed = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (options.replayOnMount === false || replayed.current) return;
    replayed.current = true;
    void runDrain();
  }, [options.replayOnMount, runDrain]);

  // Solange Umschläge offen sind, weiter versuchen – der Status bleibt sichtbar.
  useEffect(() => {
    if (sync.pending === 0) return;
    const timer = window.setInterval(() => { void runDrain(); }, OUTBOX_RETRY_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [sync.pending, runDrain]);

  useEffect(() => {
    const onPageHide = () => { void flush(); };
    window.addEventListener('pagehide', onPageHide);
    return () => window.removeEventListener('pagehide', onPageHide);
  }, [flush]);

  return useMemo(() => ({ schedule, flush, kind, sync }), [schedule, flush, kind, sync]);
}
