/**
 * audioMONASTRY · Serverautoritativer Session-State (COLLAB-P0-001)
 * ================================================================
 * Bisher relaisierte der Server `plugin-state` nur: keine Revision, keine
 * Sequenz, kein Snapshot für Reconnects, kein deterministisches Verwerfen
 * verspäteter/doppelter Events, Locks nur in einer lokalen Map ohne
 * Serialisierung. Dieses Modul ist der **autoritative Kern** dafür – bewusst
 * rein und ohne Socket/Redis/Timer, damit jede Regel ohne Netz testbar ist:
 *
 *   * **Revision**: steigt bei JEDER akzeptierten Mutation (monoton).
 *   * **Sequenz je Sender**: ein Event mit `sequence <= letzter Sequenz` des
 *     Senders ist verspätet → wird verworfen (`stale-sequence`).
 *   * **Event-IDs**: bereits gesehene IDs werden verworfen (`duplicate`).
 *   * **Locks**: atomar (synchrone, nicht unterbrechbare Prüf+Setz-Operation),
 *     lease-basiert über den vorhandenen `LockManager` (Heartbeat, TTL,
 *     Auto-Release). Fremde aktive Locks blockieren `plugin-state`.
 *   * **Snapshot**: `snapshot()` liefert den vollständigen Zustand für
 *     Join/Reconnect; `serialize()`/`restore()` für Redis-Backup.
 *
 * `now` wird überall als Parameter übergeben → deterministisch und testbar.
 */
import { LockManager, type LeaseLock } from './locking';

export interface SessionEventInput {
  /** Eindeutige, client-generierte Event-ID (Pflicht für Dedupe). */
  id: string;
  /** z. B. `plugin-state`. */
  type: string;
  senderUserId: string;
  /** Monotone Sequenz je Sender (optional; fehlt sie, wird nicht dedupliziert). */
  sequence?: number;
  pluginId?: string;
  /** Modul-State (bei `plugin-state`). */
  state?: string;
  timestamp?: number;
}

export type SessionRejectReason = 'invalid' | 'duplicate' | 'stale-sequence' | 'locked-by-other';

export interface SessionEventResult {
  accepted: boolean;
  reason?: SessionRejectReason;
  /** Revision NACH dem Event (bei Ablehnung: unverändert). */
  revision: number;
  /** Bei `locked-by-other`: aktueller Halter. */
  lockedBy?: string;
}

export interface SessionModuleState {
  state: string;
  /** Revision, bei der der State zuletzt gesetzt wurde. */
  revision: number;
  /** Zuletzt bestätigender User. */
  updatedBy: string;
}

export interface AuthoritativeSessionSnapshot {
  revision: number;
  serverTime: number;
  locks: LeaseLock[];
  modules: Record<string, SessionModuleState>;
  sequences: Record<string, number>;
  recentEventCount: number;
}

export interface SerializedAuthoritativeSession {
  version: 1;
  revision: number;
  locks: LeaseLock[];
  modules: Array<[string, SessionModuleState]>;
  sequences: Array<[string, number]>;
  recentEventIds: string[];
}

export interface AuthoritativeSessionOptions {
  lockTtlMs?: number;
  /** Ringpuffergröße der gehaltenen Event-IDs (Duplikaterkennung). */
  maxRecentEvents?: number;
  lockManager?: LockManager;
}

const DEFAULT_LOCK_TTL_MS = 60_000;
const DEFAULT_MAX_RECENT_EVENTS = 512;

export class AuthoritativeSession {
  readonly lockTtlMs: number;
  private readonly maxRecentEvents: number;
  private readonly locks: LockManager;
  private revisionCounter = 0;
  private readonly modules = new Map<string, SessionModuleState>();
  private readonly sequences = new Map<string, number>();
  private readonly recentEventIds: string[] = [];
  private readonly recentEventSet = new Set<string>();

  constructor(options: AuthoritativeSessionOptions = {}) {
    this.lockTtlMs = Number.isFinite(options.lockTtlMs) && (options.lockTtlMs as number) > 0
      ? (options.lockTtlMs as number)
      : DEFAULT_LOCK_TTL_MS;
    this.maxRecentEvents = Number.isFinite(options.maxRecentEvents) && (options.maxRecentEvents as number) > 0
      ? Math.floor(options.maxRecentEvents as number)
      : DEFAULT_MAX_RECENT_EVENTS;
    this.locks = options.lockManager ?? new LockManager();
  }

  get revision(): number {
    return this.revisionCounter;
  }

  private rememberEvent(id: string): void {
    this.recentEventIds.push(id);
    this.recentEventSet.add(id);
    while (this.recentEventIds.length > this.maxRecentEvents) {
      const oldest = this.recentEventIds.shift();
      if (oldest !== undefined) this.recentEventSet.delete(oldest);
    }
  }

  /**
   * Wendet ein Event an. Synchron und ohne I/O → die Prüf-und-Setz-Folge ist
   * in Node atomar (ein Event wird nie teilweise angewendet).
   */
  applyEvent(event: SessionEventInput, now = Date.now()): SessionEventResult {
    const id = typeof event?.id === 'string' ? event.id.trim() : '';
    const sender = typeof event?.senderUserId === 'string' ? event.senderUserId.trim() : '';
    const type = typeof event?.type === 'string' ? event.type.trim() : '';
    if (!id || !sender || !type) return { accepted: false, reason: 'invalid', revision: this.revisionCounter };

    if (this.recentEventSet.has(id)) return { accepted: false, reason: 'duplicate', revision: this.revisionCounter };

    if (typeof event.sequence === 'number' && Number.isFinite(event.sequence)) {
      const last = this.sequences.get(sender);
      // Gleiche Sequenz erneut oder kleinere Zahl = verspätet/veraltet.
      if (last !== undefined && event.sequence <= last) {
        return { accepted: false, reason: 'stale-sequence', revision: this.revisionCounter };
      }
    }

    // Lock-Durchsetzung: nur der aktive Halter darf `plugin-state` schreiben.
    if (type === 'plugin-state' && event.pluginId) {
      const owner = this.locks.ownerOf(event.pluginId, now);
      if (owner && owner !== sender) {
        return { accepted: false, reason: 'locked-by-other', revision: this.revisionCounter, lockedBy: owner };
      }
    }

    this.revisionCounter += 1;
    if (typeof event.sequence === 'number' && Number.isFinite(event.sequence)) {
      this.sequences.set(sender, event.sequence);
    }
    this.rememberEvent(id);
    if (type === 'plugin-state' && event.pluginId && typeof event.state === 'string') {
      this.modules.set(event.pluginId, { state: event.state, revision: this.revisionCounter, updatedBy: sender });
    }
    return { accepted: true, revision: this.revisionCounter };
  }

  // -------------------------------------------------------------------------
  // Locks (atomar, lease-basiert)
  // -------------------------------------------------------------------------

  /** Sperrt ein Plugin. Gleicher Halter = Heartbeat (Lease verlängert). */
  acquireLock(pluginId: string, userId: string, now = Date.now(), ttlMs = this.lockTtlMs): { ok: boolean; lockedBy?: string } {
    if (!pluginId || !userId) return { ok: false, lockedBy: this.locks.ownerOf(pluginId, now) ?? undefined };
    const ok = this.locks.acquire(pluginId, userId, ttlMs, now);
    return ok ? { ok: true } : { ok: false, lockedBy: this.locks.ownerOf(pluginId, now) ?? undefined };
  }

  renewLock(pluginId: string, userId: string, now = Date.now(), ttlMs = this.lockTtlMs): boolean {
    return this.locks.renew(pluginId, userId, ttlMs, now);
  }

  releaseLock(pluginId: string, userId: string, now = Date.now()): boolean {
    return this.locks.release(pluginId, userId, now);
  }

  lockOwner(pluginId: string, now = Date.now()): string | null {
    return this.locks.ownerOf(pluginId, now);
  }

  /** Gibt alle Locks eines Users frei (Disconnect/Leave). Liefert die Plugin-IDs. */
  releaseUserLocks(userId: string, now = Date.now()): string[] {
    const released: string[] = [];
    if (!userId) return released;
    // Auch bereits abgelaufene Locks melden (der Server broadcastet dann
    // `plugin-unlock` mit Grund – kein clientseitig hängender Lock).
    for (const lock of this.locks.all()) {
      if (lock.ownerId === userId) {
        this.locks.release(lock.objectId, userId, now);
        released.push(lock.objectId);
      }
    }
    return released;
  }

  /** Räumt abgelaufene Locks ab und liefert deren Plugin-IDs (für Broadcast). */
  sweepExpiredLocks(now = Date.now()): string[] {
    // `all()` liefert die Rohliste ohne Ablauf-Filter – nicht `snapshot(now)`,
    // das die abgelaufenen Locks schon vorher entfernen würde.
    const expired = this.locks.all().filter((l) => l.leaseUntil <= now).map((l) => l.objectId);
    this.locks.expireAll(now);
    return expired;
  }

  // -------------------------------------------------------------------------
  // Snapshot / Persistenz
  // -------------------------------------------------------------------------

  /** Vollständiger Zustand für Join/Reconnect. */
  snapshot(now = Date.now()): AuthoritativeSessionSnapshot {
    return {
      revision: this.revisionCounter,
      serverTime: now,
      locks: this.locks.snapshot(now),
      modules: Object.fromEntries(this.modules),
      sequences: Object.fromEntries(this.sequences),
      recentEventCount: this.recentEventIds.length,
    };
  }

  /** JSON-sicherer Zustand für Redis/Backup. */
  serialize(now = Date.now()): SerializedAuthoritativeSession {
    return {
      version: 1,
      revision: this.revisionCounter,
      locks: this.locks.snapshot(now),
      modules: [...this.modules.entries()],
      sequences: [...this.sequences.entries()],
      recentEventIds: [...this.recentEventIds],
    };
  }

  /** Stellt einen serialisierten Zustand wieder her (Redis-Recovery). */
  static restore(data: SerializedAuthoritativeSession, options: AuthoritativeSessionOptions = {}): AuthoritativeSession {
    const session = new AuthoritativeSession({ ...options, lockManager: new LockManager() });
    if (!data || data.version !== 1) return session;
    session.revisionCounter = Number.isFinite(data.revision) && data.revision > 0 ? Math.floor(data.revision) : 0;
    session.locks.restore(Array.isArray(data.locks) ? data.locks : []);
    for (const [pluginId, moduleState] of Array.isArray(data.modules) ? data.modules : []) {
      if (typeof pluginId === 'string' && moduleState && typeof moduleState.state === 'string') {
        session.modules.set(pluginId, {
          state: moduleState.state,
          revision: Number.isFinite(moduleState.revision) ? moduleState.revision : 0,
          updatedBy: typeof moduleState.updatedBy === 'string' ? moduleState.updatedBy : '',
        });
      }
    }
    for (const [userId, sequence] of Array.isArray(data.sequences) ? data.sequences : []) {
      if (typeof userId === 'string' && Number.isFinite(sequence)) session.sequences.set(userId, sequence);
    }
    for (const id of Array.isArray(data.recentEventIds) ? data.recentEventIds : []) {
      if (typeof id === 'string' && id && !session.recentEventSet.has(id)) session.rememberEvent(id);
    }
    return session;
  }
}

/** Persistenz-Schnittstelle (Redis im Betrieb, In-Memory in Tests). */
export interface AuthoritativeSessionPersistence {
  load(): Promise<SerializedAuthoritativeSession | null>;
  save(state: SerializedAuthoritativeSession): Promise<void>;
}

export class MemorySessionPersistence implements AuthoritativeSessionPersistence {
  private state: SerializedAuthoritativeSession | null = null;
  async load(): Promise<SerializedAuthoritativeSession | null> {
    return this.state ? JSON.parse(JSON.stringify(this.state)) as SerializedAuthoritativeSession : null;
  }
  async save(state: SerializedAuthoritativeSession): Promise<void> {
    this.state = JSON.parse(JSON.stringify(state)) as SerializedAuthoritativeSession;
  }
}
