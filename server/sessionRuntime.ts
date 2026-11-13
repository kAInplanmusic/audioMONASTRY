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
 * Wichtig fuer den Betrieb (PERSIST-P1-003): `restoreFromRedis` und (seit
 * RT-AUDIT-P1-008) `restoreFromPersistence` sind die einzigen Stellen, die
 * `session` austauschen - ein weiterer Pfad würde die Wiederherstellung wieder
 * verstreuen. Und `stop()` existiert, weil Intervalle ohne Haltepunkt in
 * Tests und bei sauberem Shutdown weiterlaufen würden.
 */
import { PluginDelegationAuthority } from './pluginDelegation';
import { AuthoritativeSession, MemorySessionPersistence, type AuthoritativeSessionPersistence, type SerializedAuthoritativeSession } from '../src/core/session/authoritativeSession';
import { SnapshotStore, createMemoryKeyValueStore, type KeyValueStore } from '../src/core/persistence/snapshotStore';
import {
  createMemoryPluginLockStore,
  describeLockBackend,
  ensureLockHolderInStore,
  releaseUserLocksInStore,
  transferPluginLockInStore,
  type LockStoreMode,
  type PluginLockRecord,
  type PluginLockStore,
  type TransferLockResult,
} from './lockStore';

export const DEFAULT_PLUGIN_LOCK_TTL_MS = 60_000;
export const DEFAULT_PLUGIN_LOCK_SWEEP_MS = 15_000;
export const DEFAULT_SNAPSHOT_INTERVAL_MS = 60_000;
export const SESSION_STATE_REDIS_KEY = 'audiomonastry:session-state';

export interface SessionRuntimeOptions {
  lockTtlMs?: number;
  /**
   * AUDIT-2026-10-30 P1-007: Lock-Speicher. Ohne Angabe ein Memory-Store - der
   * Single-Instance-Pfad bleibt damit unveraendert (die Session haelt die Locks,
   * der Store wird nicht angefasst). Erst ein Store mit `kind === 'redis'`
   * macht die Locks instanzuebergreifend.
   */
  lockStore?: PluginLockStore;
  lockSweepMs?: number;
  snapshotIntervalMs?: number;
  snapshotMaxSnapshots?: number;
  snapshotMaxAgeMs?: number;
  checksum?: (input: string) => string;
  log?: (message: string) => void;
}

/**
 * Minimale Redis-Sicht (node-redis erfuellt sie).
 *
 * Rueckgaben bewusst `unknown`: `@socket.io/redis-adapter`-Clients und
 * Test-Doubles liefern je nach Aufruf Promise oder Wert; `await` normalisiert
 * beides. Nur die Methoden, die hier wirklich gebraucht werden.
 */
export interface RedisLikeClient {
  get(key: string): unknown;
  set(key: string, value: string): unknown;
}

export interface SessionRuntime {
  readonly delegations: PluginDelegationAuthority;
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
  // -----------------------------------------------------------------------
  // P1-007: Locks ueber einen (optional geteilten) Speicher
  // -----------------------------------------------------------------------
  /** Wo liegen die Locks gerade wirklich? (memory | redis | redis-degraded) */
  lockBackend(): LockStoreMode;
  getLockStore(): PluginLockStore;
  /** Wird beim Start gesetzt (realtime.ts, nur mit REDIS_URL). */
  setLockStore(store: PluginLockStore): void;
  /**
   * Sperren. Ohne geteilten Store exakt `session.acquireLock` (unveraendert);
   * mit Redis entscheidet der Store, das Ergebnis wird lokal gespiegelt, damit
   * die synchronen Leser (Main-Out, Ops-Routen, dropAudio) weiter stimmen.
   */
  acquirePluginLock(pluginId: string, userId: string): Promise<{ ok: boolean; lockedBy?: string }>;
  releasePluginLock(pluginId: string, userId: string): Promise<boolean>;
  transferPluginLock(pluginId: string, fromUserId: string, toUserId: string): Promise<TransferLockResult>;
  /** mixerMONK-Halter neu vergeben (nur bei geteiltem Store aus dem Store). */
  ensureLockHolder(pluginId: string, memberIdsInJoinOrder: readonly string[]): Promise<string | null>;
  releaseUserLocks(userId: string): Promise<string[]>;
  /** Frischer Halter aus dem geteilten Store (fuer Autorisierungspruefungen). */
  resolveLockOwner(pluginId: string): Promise<string | null>;
  /** Lokale Lock-Sicht gegen den geteilten Store nachziehen. */
  refreshLocks(): Promise<void>;
  /** Sweep mit geteiltem Store: was dort verschwunden ist, gilt als abgelaufen. */
  sweepExpiredLocksAsync(): Promise<string[]>;
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
  /**
   * RT-AUDIT-P1-008: Wiederherstellung aus einer beliebigen Persistenz (z. B.
   * Datei-Rückfall ohne Redis). Setzt sie danach als aktive Persistenz.
   */
  restoreFromPersistence(next: AuthoritativeSessionPersistence): Promise<{ restored: boolean }>;
  /**
   * RT-AUDIT-P1-008: ausstehenden (entprellten) Save SOFORT schreiben – für den
   * Shutdown (SIGTERM), damit die letzten 250 ms nicht verloren gehen.
   */
  flush(): Promise<void>;
  /**
   * FLEET-P1-012: Checkpoint VOR dem Auto-Stop der Pods. Schreibt den
   * vollständigen Session-Zustand (inkl. Studio-Store und Plugin-Settings)
   * in die aktive Persistenz UND als Snapshot mit Prüfsumme, liest den
   * Snapshot zurück und prüft ihn. Anders als `flush()` wirft er bei einem
   * Fehler (der Aufrufer meldet/alarmiert) und liefert einen Nachweis.
   */
  checkpoint(): Promise<SessionCheckpoint>;
  /** Laufenden (debounced) Save abbrechen - z. B. beim Session-Reset. */
  stopSaveTimer(): void;
  /** Intervalle starten (idempotent). */
  start(): void;
  /** Intervalle stoppen (Shutdown/Tests). */
  stop(): void;
}

/** Nachweis eines Checkpoints (FLEET-P1-012). */
export interface SessionCheckpoint {
  ok: true;
  revision: number;
  snapshotId: string;
  checksum: string;
  savedAt: number;
  /** Snapshot zurückgelesen, Prüfsumme gültig, gleiche Revision. */
  verified: boolean;
  /** Klassenname der aktiven Persistenz (Redis/Datei/Speicher). */
  persistence: string;
  studioStoreKeys: number;
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

  // -------------------------------------------------------------------------
  // P1-007: Lock-Speicher
  // -------------------------------------------------------------------------
  // Ohne REDIS_URL ist der Store ein Memory-Store und wird von den Mutatoren
  // NICHT benutzt - die Session bleibt wie bisher der autoritative Halter
  // (`sharedLocks()` ist dann false). Nur ein Store mit `kind === 'redis'`
  // entscheidet ueber Vergabe/Freigabe, und die Session spiegelt das Ergebnis.
  let lockStore: PluginLockStore = options.lockStore ?? createMemoryPluginLockStore();
  const sharedLocks = (): boolean => lockStore.kind === 'redis';
  const delegations = new PluginDelegationAuthority(() => session, () => lockStore.kind === 'memory');

  /** Uebernimmt einen Store-Stand in die lokale Session-Sicht (nur Leser). */
  const mirrorLock = (record: PluginLockRecord, now = Date.now()): void => {
    const localOwner = session.lockOwner(record.pluginId, now);
    if (localOwner && localOwner !== record.ownerId) session.releaseLock(record.pluginId, localOwner, now);
    const remaining = Math.max(1, record.leaseUntil - now);
    session.acquireLock(record.pluginId, record.ownerId, now, remaining);
  };

  const dropLocalLock = (pluginId: string, now = Date.now()): void => {
    const localOwner = session.lockOwner(pluginId, now);
    if (localOwner) session.releaseLock(pluginId, localOwner, now);
  };

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
    delegations,
    get session() { return session; },
    setSession(next) { delegations.clear(); session = next; },
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
    lockBackend: () => describeLockBackend(lockStore),
    getLockStore: () => lockStore,
    setLockStore(next) { lockStore = next; },
    async acquirePluginLock(pluginId, userId) {
      if (!sharedLocks()) {
        const result = session.acquireLock(pluginId, userId);
        if (result.ok) delegations.revoke(pluginId, 'new-holder');
        return result;
      }
      const result = await lockStore.acquire(pluginId, userId, lockTtlMs);
      if (result.ok && result.record) {
        mirrorLock(result.record);
        return { ok: true };
      }
      // Verweigert: den ECHTEN Halter aus dem Store uebernehmen, damit die
      // lokale Sicht (Main-Out, Ops) nicht auf einem alten Besitzer steht.
      const current = await lockStore.get(pluginId);
      if (current) mirrorLock(current);
      return { ok: false, lockedBy: result.lockedBy ?? current?.ownerId };
    },
    async releasePluginLock(pluginId, userId) {
      if (!sharedLocks()) return session.releaseLock(pluginId, userId);
      const released = await lockStore.release(pluginId, userId);
      if (released) dropLocalLock(pluginId);
      return released;
    },
    async transferPluginLock(pluginId, fromUserId, toUserId) {
      if (!sharedLocks()) return session.transferLock(pluginId, fromUserId, toUserId);
      const result = await transferPluginLockInStore(lockStore, pluginId, fromUserId, toUserId, lockTtlMs);
      if (result.ok) {
        const current = await lockStore.get(pluginId);
        if (current) mirrorLock(current);
        else dropLocalLock(pluginId);
      }
      return result;
    },
    async ensureLockHolder(pluginId, memberIdsInJoinOrder) {
      if (!sharedLocks()) return session.ensureHolder(pluginId, memberIdsInJoinOrder);
      const assigned = await ensureLockHolderInStore(lockStore, pluginId, memberIdsInJoinOrder, lockTtlMs);
      const current = await lockStore.get(pluginId);
      if (current) mirrorLock(current);
      else dropLocalLock(pluginId);
      return assigned;
    },
    async releaseUserLocks(userId) {
      delegations.revokeUser(userId);
      if (!sharedLocks()) return session.releaseUserLocks(userId);
      const released = await releaseUserLocksInStore(lockStore, userId);
      for (const pluginId of released) dropLocalLock(pluginId);
      return released;
    },
    async resolveLockOwner(pluginId) {
      if (!sharedLocks()) return session.lockOwner(pluginId);
      const current = await lockStore.get(pluginId);
      if (current) {
        mirrorLock(current);
        return current.ownerId;
      }
      dropLocalLock(pluginId);
      return null;
    },
    async refreshLocks() {
      if (!sharedLocks()) return;
      const records = await lockStore.list();
      const present = new Set(records.map((record) => record.pluginId));
      for (const lock of session.snapshot().locks) {
        if (!present.has(lock.objectId)) dropLocalLock(lock.objectId);
      }
      for (const record of records) mirrorLock(record);
    },
    async sweepExpiredLocksAsync() {
      // Ohne geteilten Store bleibt es beim lokalen Sweep (wie bisher).
      if (!sharedLocks()) return runtime.sweepExpiredLocks();
      let records: PluginLockRecord[];
      try {
        records = await lockStore.list();
      } catch (err) {
        // Der Store faellt intern auf Memory zurueck; hier nur nicht sterben.
        log(`[session] Lock-Sweep ohne Store-Liste: ${(err as Error).message}`);
        return runtime.sweepExpiredLocks();
      }
      const present = new Set(records.map((record) => record.pluginId));
      // Alles, was lokal noch als Lock steht, im Store aber nicht mehr existiert,
      // ist abgelaufen oder wurde anderswo freigegeben -> broadcasten.
      const expired = session.snapshot().locks
        .map((lock) => lock.objectId)
        .filter((pluginId) => !present.has(pluginId));
      for (const pluginId of expired) {
        dropLocalLock(pluginId);
        lockExpiryBroadcaster?.(pluginId);
      }
      for (const record of records) mirrorLock(record);
      return expired;
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
    async restoreFromPersistence(next) {
      const state = await next.load().catch(() => null);
      if (state) session = AuthoritativeSession.restore(state, { lockTtlMs });
      persistence = next;
      return { restored: Boolean(state) };
    },
    async flush() {
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
      try {
        await persistence.save(session.serialize());
      } catch (err) {
        log(`[session] Speichern beim Herunterfahren fehlgeschlagen: ${(err as Error).message}`);
      }
    },
    async checkpoint() {
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
      const serialized = session.serialize();
      // 1. aktive Persistenz (Redis bzw. Datei-Rückfall) – Fehler werfen.
      await persistence.save(serialized);
      // 2. Snapshot mit Prüfsumme + Retention.
      const record = await snapshotStore.write(serialized, serialized.revision);
      await snapshotStore.prune().catch(() => ({ deleted: [], kept: [] }));
      // 3. Rücklesen: der Snapshot muss gültig und derselbe sein.
      const back = await snapshotStore.restore(record.id);
      const verified = Boolean(back && back.checksum === record.checksum && back.revision === record.revision);
      if (!verified) throw new Error(`Snapshot ${record.id} nach dem Schreiben nicht lesbar/ungueltig`);
      const proof: SessionCheckpoint = {
        ok: true,
        revision: serialized.revision,
        snapshotId: record.id,
        checksum: record.checksum,
        savedAt: record.savedAt,
        verified,
        persistence: persistence.constructor?.name || 'unknown',
        studioStoreKeys: Array.isArray(serialized.studioStore) ? serialized.studioStore.length : 0,
      };
      log(`[session] Checkpoint geschrieben (snapshot=${proof.snapshotId}, rev=${proof.revision}, persistenz=${proof.persistence}, verified=${proof.verified}).`);
      return proof;
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
        sweepTimer = setInterval(() => {
          // P1-007: mit geteiltem Store muessen fremde Aenderungen einlaufen -
          // der Sweep ist dafuer der Takt (er laeuft ohnehin alle 15 s).
          void runtime.sweepExpiredLocksAsync().catch((err) => {
            log(`[session] Lock-Sweep fehlgeschlagen: ${(err as Error).message}`);
          });
        }, lockSweepMs);
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
