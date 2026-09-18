/**
 * audioMONASTRY · Session-Laufzeit (ARCH-P2-002, Schritt Socket-/Session-Schicht)
 * =====================================================================
 * Bis hierher lagen der autoritative Session-Zustand und seine Persistenz als
 * modulweiter Zustand in `server.ts` - über 1 000 Zeilen von den Handlern
 * entfernt, die ihn benutzen. Genau das war der letzte offene Punkt der
 * Zerlegung: nicht ein Route-Handler, sondern **geteilter Zustand**.
 *
 * Dieses Modul kapselt ihn:
 *
 *   - `session`            - der autoritative Zustand (Locks, Module, Navigation)
 *   - `persistence`        - Speicherweg (In-Memory oder Redis)
 *   - `snapshotStore`      - Snapshots mit Prüfsumme/Retention (Datei/Redis)
 *   - Lock-Sweep           - abgelaufene Locks werden aktiv broadcastet
 *
 * Bewusst NICHT nebenlaeufig gedacht: der Prozess ist single-threaded, es gibt
 * höchstens EINEN Schreibvorgang gleichzeitig. Die Laufzeit ist deshalb kein
 * Nebenläufigkeitskonstrukt, sondern der Ort, an dem diese eine Wahrheit liegt.
 *
 * Wichtig fuer den Betrieb (PERSIST-P1-003): `restoreFromRedis` ist die einzige
 * Stelle, die `session` austauscht - ein zweiter Pfad würde die Wiederherstellung
 * wieder verstreuen. Und `stop()` existiert, weil Intervalle ohne Haltepunkt in
 * Tests und bei sauberem Shutdown weiterlaufen würden.
 */
import { AuthoritativeSession, MemorySessionPersistence, type AuthoritativeSessionPersistence, type SerializedAuthoritativeSession } from '../src/core/session/authoritativeSession';
import { SnapshotStore, createMemoryKeyValueStore, type KeyValueStore } from '../src/core/persistence/snapshotStore';

export const DEFAULT_PLUGIN_LOCK_TTL_MS = 60_000;
export const DEFAULT_PLUGIN_LOCK_SWEEP_MS = 15_000;
export const DEFAULT_SNAPSHOT_INTERVAL_MS = 60_000;
export const SESSION_STATE_REDIS_KEY = 'audiomonastry:session-state';

export interface SessionRuntimeOptions {
  lockTtlMs?: number;
  lockSweepMs?: number;
  snapshotIntervalMs?: number;
  snapshotMaxSnapshots?: number;
  snapshotMaxAgeMs?: number;
  checksum?: (input: string) => string;
  log?: (message: string) => void;
}

/** Minimale Redis-Sicht (node-redis erfuellt sie). */
export interface RedisLikeClient {
  get(key: string): Promise<unknown>;
  set(key: string, value: string): Promise<unknown>;
}

export interface SessionRuntime {
  get session(): AuthoritativeSession;
  /** Austausch des Zustands - NUR fuer die Wiederherstellung (Redis/Snapshot). */
  setSession(session: AuthoritativeSession): void;
  getPersistence(): AuthoritativeSessionPersistence;
  setPersistence(persistence: AuthoritativeSessionPersistence): void;
  getSnapshotStore(): SnapshotStore<SerializedAuthoritativeSession>;
  setSnapshotStore(store: SnapshotStore<SerializedAuthoritativeSession>): void;
  createSnapshotStore(kv: KeyValueStore): SnapshotStore<SerializedAuthoritativeSession>;
  /** Debounced Persistenz (Zustand + Snapshot). */
  persist(): void;
  /** Sofortiger Snapshot inkl. Retention (best effort). */
  persistSnapshotNow(): void;
  /** Legacy-Sicht der Locks (Client-Format von `plugin-locks-sync`). */
  legacyLockMap(): Record<string, { lockedBy: string; timestamp: number; ttl: number }>;
  /** Abgelaufene Locks einsammeln und (falls verdrahtet) broadcasten. */
  sweepExpiredLocks(): string[];
  /** Callback aus dem Socket-Setup, der Locks-Ablauf an alle broadcastet. */
  setLockExpiryBroadcaster(fn: ((pluginId: string) => void) | null): void;
  /**
   * Wiederherstellung aus Redis: erst der Session-State-Key, sonst der neueste
   * gueltige Snapshot. `snapshotKv` ist der Redis-gestuetzte Key-Value-Store -
   * ohne ihn wuerden Snapshots weiter nur im Speicher landen (PERSIST-P1-003
   * waere still verloren).
   */
  restoreFromRedis(client: RedisLikeClient, snapshotKv: KeyValueStore):
    Promise<{ restored: boolean; snapshotRestored: boolean }>;
  /** Laufenden (debounced) Save abbrechen - z. B. beim Session-Reset. */
  stopSaveTimer(): void;
  /** Intervalle starten (idempotent). */
  start(): void;
  /** Intervalle stoppen (Shutdown/Tests). */
  stop(): void;
}

export function createSessionRuntime(options: SessionRuntimeOptions = {}): SessionRuntime {
  const lockTtlMs = Math.max(1_000, Number(options.lockTtlMs ?? DEFAULT_PLUGIN_LOCK_TTL_MS));
  const lockSweepMs = Math.max(1_000, Number(options.lockSweepMs ?? DEFAULT_PLUGIN_LOCK_SWEEP_MS));
  const snapshotIntervalMs = Math.max(1_000, Number(options.snapshotIntervalMs ?? DEFAULT_SNAPSHOT_INTERVAL_MS));
  const log = options.log ?? ((message: string) => console.log(message));

  let session = new AuthoritativeSession({ lockTtlMs });
  let persistence: AuthoritativeSessionPersistence = new MemorySessionPersistence();
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let lockExpiryBroadcaster: ((pluginId: string) => void) | null = null;
  let snapshotTimer: ReturnType<typeof setInterval> | null = null;
  let sweepTimer: ReturnType<typeof setInterval> | null = null;

  const createSnapshotStore = (kv: KeyValueStore): SnapshotStore<SerializedAuthoritativeSession> =>
    new SnapshotStore<SerializedAuthoritativeSession>(kv, {
      maxSnapshots: Math.max(1, Number(options.snapshotMaxSnapshots ?? process.env.SNAPSHOT_MAX_SNAPSHOTS ?? 20)),
      maxAgeMs: Math.max(0, Number(options.snapshotMaxAgeMs ?? process.env.SNAPSHOT_MAX_AGE_MS ?? 7 * 24 * 60 * 60 * 1000)),
      checksum: options.checksum,
    });

  let snapshotStore = createSnapshotStore(createMemoryKeyValueStore());

  const persistSnapshotNow = (): void => {
    const serialized = session.serialize();
    void snapshotStore.write(serialized, serialized.revision)
      .then(() => snapshotStore.prune())
      .catch((err) => console.warn('[snapshot] persistieren fehlgeschlagen:', (err as Error).message));
  };

  const runtime: SessionRuntime = {
    get session() { return session; },
    setSession(next) { session = next; },
    getPersistence: () => persistence,
    setPersistence(next) { persistence = next; },
    getSnapshotStore: () => snapshotStore,
    setSnapshotStore(store) { snapshotStore = store; },
    createSnapshotStore,
    persist() {
      if (saveTimer) return;
      saveTimer = setTimeout(() => {
        saveTimer = null;
        void persistence.save(session.serialize()).catch(() => { /* best effort */ });
        // P1-2: Snapshot gleich mitziehen (debounced, kein Extra-Timer noetig).
        persistSnapshotNow();
      }, 250);
      saveTimer.unref?.();
    },
    persistSnapshotNow,
    legacyLockMap() {
      const now = Date.now();
      return Object.fromEntries(session.snapshot(now).locks.map((l) => [
        l.objectId,
        { lockedBy: l.ownerId, timestamp: now, ttl: Math.max(0, l.leaseUntil - now) },
      ]));
    },
    sweepExpiredLocks() {
      const expired = session.sweepExpiredLocks();
      for (const pluginId of expired) {
        // ARCH-#2: Ablauf aktiv an ALLE Session-Teilnehmer broadcasten – sonst
        // bleibt der Lock clientseitig hängen und das Plugin erscheint fuer
        // andere weiter als gesperrt.
        lockExpiryBroadcaster?.(pluginId);
      }
      return expired;
    },
    setLockExpiryBroadcaster(fn) { lockExpiryBroadcaster = fn; },
    async restoreFromRedis(client: RedisLikeClient, snapshotKv: KeyValueStore) {
      const redisPersistence: AuthoritativeSessionPersistence = {
        async load(): Promise<SerializedAuthoritativeSession | null> {
          try {
            const raw = await client.get(SESSION_STATE_REDIS_KEY);
            if (typeof raw !== 'string' || raw.length === 0) return null;
            return JSON.parse(raw) as SerializedAuthoritativeSession;
          } catch {
            return null;
          }
        },
        async save(state: SerializedAuthoritativeSession): Promise<void> {
          try {
            await client.set(SESSION_STATE_REDIS_KEY, JSON.stringify(state));
          } catch {
            /* best effort */
          }
        },
      };
      const restoredState = await redisPersistence.load();
      if (restoredState) session = AuthoritativeSession.restore(restoredState, { lockTtlMs });
      persistence = redisPersistence;
      // PERSIST-P1-003: Snapshots ueberleben den Prozess-Neustart, weil der
      // Store jetzt auf Redis schreibt (vorher nur In-Memory).
      snapshotStore = createSnapshotStore(snapshotKv);
      let snapshotRestored = false;
      if (!restoredState) {
        // Zweiter, pruefsummen-gepruefter Pfad: falls der Session-State-Key
        // fehlt, den neuesten GUELTIGEN Snapshot wiederherstellen.
        const snapshot = await snapshotStore.restore('latest');
        if (snapshot) {
          session = AuthoritativeSession.restore(snapshot.payload, { lockTtlMs });
          snapshotRestored = true;
          log(`Session aus Snapshot wiederhergestellt (id=${snapshot.id}, rev=${session.revision}).`);
        }
      }
      return { restored: Boolean(restoredState), snapshotRestored };
    },
    stopSaveTimer() {
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    },
    start() {
      if (!snapshotTimer) {
        snapshotTimer = setInterval(persistSnapshotNow, snapshotIntervalMs);
        snapshotTimer.unref?.();
      }
      if (!sweepTimer) {
        sweepTimer = setInterval(() => { runtime.sweepExpiredLocks(); }, lockSweepMs);
        sweepTimer.unref?.();
      }
    },
    stop() {
      if (snapshotTimer) { clearInterval(snapshotTimer); snapshotTimer = null; }
      if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    },
  };

  return runtime;
}
