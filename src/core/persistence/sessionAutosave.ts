/**
 * audioMONASTRY · Persistenz – debounced Autosave + Retry/Backoff (PERSIST-P1-002)
 * ==============================================================================
 * Kapselt drei Dinge, die bisher fehlten:
 *   1. **Debounce**: viele schnelle Zustandsänderungen → EIN Schreibvorgang.
 *   2. **Retry mit exponentiellem Backoff**: Supabase/R2/Storage dürfen kurz
 *      weg sein, ohne den Nutzerzustand zu verlieren.
 *   3. **Idempotenz**: der Umschlag (siehe `snapshotEnvelope`) wird PRO Stand
 *      einmal gebaut und über alle Wiederholungen wiederverwendet – ein Retry
 *      schreibt denselben `idempotencyKey`, nie eine neue Revision.
 *
 * Reiner Kern mit injizierbaren Timern/Sleep + Key-Value-Store; die Browser-
 * Anbindung (IndexedDB via `largeGetJson`/`largeSetJson`) ist ein dünner Adapter.
 */
import {
  deserializeEnvelope,
  nextEnvelope,
  serializeEnvelope,
  type SnapshotEnvelope,
} from './snapshotEnvelope';

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface AsyncKeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove?(key: string): Promise<void>;
}

/** In-Memory-Store (Tests, Fallback wenn IndexedDB fehlt). */
export function createMemoryStore(seed: Record<string, string> = {}): AsyncKeyValueStore {
  const map = new Map<string, string>(Object.entries(seed));
  return {
    async get(key) {
      return map.has(key) ? (map.get(key) as string) : null;
    },
    async set(key, value) {
      map.set(key, value);
    },
    async remove(key) {
      map.delete(key);
    },
  };
}

// ---------------------------------------------------------------------------
// Retry
// ---------------------------------------------------------------------------

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  shouldRetry?: (error: unknown) => boolean;
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
}

/**
 * Führt `fn` aus und wiederholt bei Fehlern mit exponentiellem Backoff
 * (baseDelay, 2×base, 4×base … gedeckelt auf maxDelayMs).
 * Nach `attempts` Fehlschlägen wird der letzte Fehler weitergereicht.
 */
export async function retryWithBackoff<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, Math.floor(options.attempts ?? 3));
  const base = Math.max(0, options.baseDelayMs ?? 250);
  const max = Math.max(base, options.maxDelayMs ?? 5_000);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const shouldRetry = options.shouldRetry ?? (() => true);

  let lastError: unknown = new Error('retry failed');
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !shouldRetry(error)) throw error;
      const delayMs = Math.min(max, base * 2 ** (attempt - 1));
      options.onRetry?.({ attempt, delayMs, error });
      await sleep(delayMs);
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// Debounce
// ---------------------------------------------------------------------------

export interface DebounceOptions {
  delayMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * Coalesct schnelle Aufrufe: nur der LETZTE Payload wird (nach `delayMs`)
 * gespeichert. `flush()` schreibt sofort und wartet auf einen laufenden Save.
 */
export class DebouncedAutosave<T> {
  private handle: unknown = null;
  private pendingPayload: T | undefined;
  private hasPending = false;
  private inFlight: Promise<void> | null = null;

  private readonly delayMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly save: (payload: T) => Promise<void>, options: DebounceOptions = {}) {
    this.delayMs = Math.max(0, options.delayMs ?? 500);
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms) as unknown);
    this.clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  get pending(): boolean {
    return this.hasPending || this.handle !== null;
  }

  schedule(payload: T): void {
    this.pendingPayload = payload;
    this.hasPending = true;
    if (this.handle !== null) this.clearTimer(this.handle);
    this.handle = this.setTimer(() => {
      this.handle = null;
      void this.runPending();
    }, this.delayMs);
  }

  /** Schreibt sofort und wartet auf laufende/neue Schreibvorgänge. */
  async flush(): Promise<void> {
    if (this.handle !== null) {
      this.clearTimer(this.handle);
      this.handle = null;
    }
    await this.runPending();
    if (this.inFlight) await this.inFlight;
  }

  private async runPending(): Promise<void> {
    if (!this.hasPending) return;
    const payload = this.pendingPayload as T;
    this.hasPending = false;
    this.pendingPayload = undefined;
    this.inFlight = this.save(payload).finally(() => {
      this.inFlight = null;
    });
    await this.inFlight;
  }
}

// ---------------------------------------------------------------------------
// Session-Autosave (Store + Umschlag + Retry)
// ---------------------------------------------------------------------------

export interface SessionAutosaveOptions extends DebounceOptions {
  /** Storage-Schlüssel (Default `session-autosave`). */
  key?: string;
  retry?: RetryOptions;
  now?: () => number;
}

export class SessionAutosave {
  private readonly key: string;
  private readonly now: () => number;
  private readonly debounced: DebouncedAutosave<unknown>;
  private lastEnvelope: SnapshotEnvelope | null = null;

  constructor(
    private readonly store: AsyncKeyValueStore,
    private readonly options: SessionAutosaveOptions = {},
  ) {
    this.key = options.key ?? 'session-autosave';
    this.now = options.now ?? (() => Date.now());
    this.debounced = new DebouncedAutosave<unknown>(async (payload) => {
      await this.saveNow(payload);
    }, options);
  }

  /** Lädt den letzten Stand (mit Migration) und setzt die Revisionsbasis. */
  async load(): Promise<SnapshotEnvelope | null> {
    const raw = await this.store.get(this.key);
    if (!raw) return null;
    const envelope = deserializeEnvelope(raw);
    if (envelope) this.lastEnvelope = envelope;
    return envelope;
  }

  /**
   * Schreibt EINEN Stand. Der Umschlag wird einmal gebaut; alle Retry-Versuche
   * nutzen denselben `idempotencyKey` (kein Doppel-Schreiben als neue Revision).
   */
  async saveNow(payload: unknown): Promise<SnapshotEnvelope> {
    const envelope = nextEnvelope(payload, { previous: this.lastEnvelope, savedAt: this.now() });
    await retryWithBackoff(async () => {
      await this.store.set(this.key, serializeEnvelope(envelope));
    }, this.options.retry ?? {});
    this.lastEnvelope = envelope;
    return envelope;
  }

  /** Debounced speichern (schnelle Änderungen werden zusammengefasst). */
  schedule(payload: unknown): void {
    this.debounced.schedule(payload);
  }

  /** Sofort speichern (z. B. vor dem Schließen der Seite). */
  flush(): Promise<void> {
    return this.debounced.flush();
  }

  get hasPending(): boolean {
    return this.debounced.pending;
  }
}
