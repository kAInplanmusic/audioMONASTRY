/**
 * audioMONASTRY · Plugin-Lock-Speicher (AUDIT-2026-10-30 P1-007)
 * ==============================================================
 * Die Plugin-Locks lagen bis hier ausschliesslich in der `LockManager`-Map der
 * jeweiligen `AuthoritativeSession` - also im Prozess. Zwei App-Instanzen hinter
 * dem Loadbalancer sahen damit unterschiedliche Locks: Instanz A vergab
 * `mixer` an Nutzer 1, Instanz B vergab denselben Lock parallel an Nutzer 2.
 *
 * Dieses Modul legt den Speicher hinter eine schmale Schnittstelle
 * (`PluginLockStore`): `get`/`set`/`delete`/`list` und `acquire` mit Lease-TTL.
 *
 *   * `createMemoryPluginLockStore()` - Default, delegiert an den vorhandenen
 *     `LockManager` (identische Semantik wie heute, kein Redis noetig).
 *   * `createRedisPluginLockStore(client)` - ein Redis-Schluessel je Plugin mit
 *     PX-TTL; `acquire` nutzt `SET NX PX`, damit zwei Instanzen denselben Lock
 *     nicht doppelt vergeben.
 *
 * Wichtig fuer den Betrieb: ein kaputter Redis darf den Audio-/Signaling-Betrieb
 * nicht toeten. `withMemoryFallback()` legt deshalb einen zweiten Store darunter
 * und schaltet beim ERSTEN Fehler sichtbar und dauerhaft auf den Prozess-Speicher
 * um (mit Logzeile). "Dauerhaft" ist Absicht: ein hin- und herschaltender Store
 * wuerde Locks zwischen zwei Speichern verlieren.
 *
 * Kein `redis`-Import in diesem Modul: der Client kommt als Interface herein
 * (wie `redisKeyValueStore.ts`), damit die Semantik ohne echten Redis pruefbar
 * ist.
 *
 * Grenze der Redis-Implementierung (bewusst, dokumentiert): `release` und
 * `transfer` lesen zuerst und schreiben dann. Zwischen `GET` und `DEL` kann die
 * Lease ablaufen und eine fremde Instanz den Lock uebernehmen; in diesem
 * Mikrosekunden-Fenster wuerde der alte Halter den NEUEN Lock loeschen. Eine
 * echte Compare-and-Delete-Semantik braucht Lua (`EVAL`) - das ist fuer diese
 * Ticketgroesse nicht gerechtfertigt und waere gegen ein Test-Double nicht mehr
 * pruefbar. Der Single-Instance-Pfad (Memory) hat das Fenster nicht.
 */
import { LockManager } from '../src/core/session/locking';

/** Ein gehaltener Plugin-Lock mit Lease. */
export interface PluginLockRecord {
  pluginId: string;
  ownerId: string;
  /** Unix-ms, bis wann die Lease gilt. */
  leaseUntil: number;
  /** Heartbeats seit der Vergabe (Diagnose). */
  renewals: number;
}

export interface LockAcquireResult {
  ok: boolean;
  /** Nur bei `ok === false`: wer den Lock haelt. */
  lockedBy?: string;
  /** Nur bei `ok === true`: der geschriebene Stand (fuer die lokale Spiegelung). */
  record?: PluginLockRecord;
}

export type LockStoreKind = 'memory' | 'redis';

/**
 * Der Vertrag, den Session-Laufzeit und Signaling benutzen. Alle Methoden sind
 * async, weil die Redis-Variante ueber das Netz geht; die Memory-Variante
 * erfuellt ihn sofort.
 */
export interface PluginLockStore {
  readonly kind: LockStoreKind;
  /** true, sobald ein Redis-Store dauerhaft auf den Prozess-Speicher gefallen ist. */
  readonly degraded: boolean;
  get(pluginId: string, now?: number): Promise<PluginLockRecord | null>;
  /** Schreibt einen Stand fest (Wiederherstellung/Uebernahme), TTL aus der Lease. */
  set(record: PluginLockRecord, now?: number): Promise<void>;
  /** Bedingungsloses Entfernen (Sweep/Revalidierung). */
  delete(pluginId: string): Promise<boolean>;
  list(now?: number): Promise<PluginLockRecord[]>;
  /** Sperrt mit Lease-TTL. Gleicher Halter = Heartbeat (Lease verlaengert). */
  acquire(pluginId: string, ownerId: string, ttlMs: number, now?: number): Promise<LockAcquireResult>;
  /** Freigabe - nur der aktuelle Halter darf sie loeschen. */
  release(pluginId: string, ownerId: string, now?: number): Promise<boolean>;
  close(): Promise<void>;
}

export type LockStoreMode = 'memory' | 'redis' | 'redis-degraded';

/** Fuer Logs/Ops: welcher Speicher traegt die Locks gerade wirklich? */
export function describeLockBackend(store: PluginLockStore): LockStoreMode {
  if (store.kind === 'memory') return 'memory';
  return store.degraded ? 'redis-degraded' : 'redis';
}

const MIN_TTL_MS = 1;

function normalizeTtl(ttlMs: number): number {
  const ttl = Number(ttlMs);
  return Number.isFinite(ttl) && ttl > 0 ? Math.max(MIN_TTL_MS, Math.floor(ttl)) : MIN_TTL_MS;
}

/** Nur `redis://` und `rediss://` sind erlaubt (S-9: sonst stiller Fehlstart). */
export function normalizeRedisUrl(raw: unknown): string {
  const url = typeof raw === 'string' ? raw.trim() : '';
  if (!url) return '';
  return /^rediss?:\/\//i.test(url) ? url : '';
}

// ---------------------------------------------------------------------------
// Memory (Default, unveraendertes Verhalten)
// ---------------------------------------------------------------------------

/**
 * Prozess-lokaler Store. Delegiert an `LockManager` - also exakt an die Klasse,
 * die die Session heute schon benutzt. Damit ist der Single-Instance-Pfad
 * semantisch unveraendert (Heartbeat, Lease-Ablauf, keine Fremdfreigabe).
 */
export function createMemoryPluginLockStore(): PluginLockStore {
  const locks = new LockManager();

  const current = (pluginId: string, now: number): PluginLockRecord | null => {
    const found = locks.all().find((lock) => lock.objectId === pluginId);
    if (!found) return null;
    if (found.leaseUntil <= now) {
      locks.expireAll(now);
      return null;
    }
    return {
      pluginId: found.objectId,
      ownerId: found.ownerId,
      leaseUntil: found.leaseUntil,
      renewals: found.renewals,
    };
  };

  return {
    kind: 'memory',
    degraded: false,
    async get(pluginId, now = Date.now()) {
      return current(pluginId, now);
    },
    async set(record, now = Date.now()) {
      const ttl = normalizeTtl(record.leaseUntil - now);
      const existing = current(record.pluginId, now);
      if (existing && existing.ownerId !== record.ownerId) locks.release(record.pluginId, existing.ownerId, now);
      locks.acquire(record.pluginId, record.ownerId, ttl, now);
    },
    async delete(pluginId, now = Date.now()) {
      // Bedingungslos: auch eine (fast) abgelaufene Lease wird entfernt -
      // sonst waere `delete` von der Uhr des Aufrufers abhaengig.
      const existing = locks.all().find((lock) => lock.objectId === pluginId);
      if (!existing) return false;
      locks.release(existing.objectId, existing.ownerId, now);
      return true;
    },
    async list(now = Date.now()) {
      locks.expireAll(now);
      return locks.all().map((lock) => ({
        pluginId: lock.objectId,
        ownerId: lock.ownerId,
        leaseUntil: lock.leaseUntil,
        renewals: lock.renewals,
      }));
    },
    async acquire(pluginId, ownerId, ttlMs, now = Date.now()) {
      if (!pluginId || !ownerId) return { ok: false, lockedBy: current(pluginId, now)?.ownerId };
      const ttl = normalizeTtl(ttlMs);
      if (!locks.acquire(pluginId, ownerId, ttl, now)) {
        return { ok: false, lockedBy: current(pluginId, now)?.ownerId };
      }
      const record = current(pluginId, now);
      return record ? { ok: true, record } : { ok: true };
    },
    async release(pluginId, ownerId, now = Date.now()) {
      const existing = current(pluginId, now);
      if (!existing) return true; // bereits frei
      if (existing.ownerId !== ownerId) return false; // Fremdfreigabe ist ausgeschlossen
      locks.release(pluginId, ownerId, now);
      return true;
    },
    async close() { /* nichts zu schliessen */ },
  };
}

// ---------------------------------------------------------------------------
// Redis
// ---------------------------------------------------------------------------

/** Der Ausschnitt der Redis-API, den der Store braucht. */
export interface LockRedisClient {
  get(key: string): Promise<unknown> | unknown;
  set(
    key: string,
    value: string,
    options?: { NX?: boolean; XX?: boolean; PX?: number },
  ): Promise<unknown> | unknown;
  del(...keys: string[]): Promise<unknown> | unknown;
  keys(pattern: string): Promise<unknown> | unknown;
  quit?(): Promise<unknown> | unknown;
  disconnect?(): unknown;
  ping?(): Promise<unknown> | unknown;
  on?(event: 'error', listener: (error: unknown) => void): unknown;
}

export const DEFAULT_PLUGIN_LOCK_KEY_PREFIX = 'audiomonastry:plugin-lock:';

export interface RedisLockStoreOptions {
  prefix?: string;
  log?: (message: string) => void;
}

function parseRecord(raw: unknown, fallbackPluginId: string): PluginLockRecord | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PluginLockRecord>;
    if (!parsed || typeof parsed.ownerId !== 'string' || !parsed.ownerId) return null;
    return {
      pluginId: typeof parsed.pluginId === 'string' && parsed.pluginId ? parsed.pluginId : fallbackPluginId,
      ownerId: parsed.ownerId,
      leaseUntil: Number.isFinite(parsed.leaseUntil) ? Number(parsed.leaseUntil) : 0,
      renewals: Number.isFinite(parsed.renewals) ? Number(parsed.renewals) : 0,
    };
  } catch {
    return null;
  }
}

/**
 * Ein Redis-Schluessel je Plugin. Die TTL macht der Redis selbst (PX) - damit
 * ist eine abgelaufene Lease auch fuer andere Instanzen sofort wieder frei,
 * ohne dass jemand sweepen muss.
 */
export function createRedisPluginLockStore(client: LockRedisClient, options: RedisLockStoreOptions = {}): PluginLockStore {
  const basePrefix = options.prefix ?? DEFAULT_PLUGIN_LOCK_KEY_PREFIX;
  const prefix = basePrefix.endsWith(':') ? basePrefix : `${basePrefix}:`;
  const keyFor = (pluginId: string): string => `${prefix}${pluginId}`;
  const skip = (): void => { /* best effort beim Aufraeumen */ };

  const read = async (pluginId: string, now: number): Promise<PluginLockRecord | null> => {
    const record = parseRecord(await client.get(keyFor(pluginId)), pluginId);
    if (!record) return null;
    if (record.leaseUntil <= now) return null; // TTL ist bereits abgelaufen (Redis raeumt gleich auf)
    return record;
  };

  return {
    kind: 'redis',
    degraded: false,
    async get(pluginId, now = Date.now()) {
      return read(pluginId, now);
    },
    async set(record, now = Date.now()) {
      const ttl = normalizeTtl(record.leaseUntil - now);
      await client.set(keyFor(record.pluginId), JSON.stringify({ ...record, leaseUntil: now + ttl }), { PX: ttl });
    },
    async delete(pluginId) {
      const removed = await client.del(keyFor(pluginId));
      return Number(removed) > 0;
    },
    async list(now = Date.now()) {
      // `KEYS` statt `SCAN`: Es gibt eine Handvoll Plugin-Locks unter eigenem
      // Praefix (max. eine je Plugin), und ein Cursor-Loop waere gegen ein
      // Test-Double nicht mehr ehrlich abbildbar. Bei wachsendem Bestand ist
      // das die Stelle, an der auf SCAN umgestellt wird.
      const found = await client.keys(`${prefix}*`);
      if (!Array.isArray(found)) return [];
      const out: PluginLockRecord[] = [];
      for (const key of found) {
        if (typeof key !== 'string' || !key.startsWith(prefix)) continue;
        const pluginId = key.slice(prefix.length);
        if (!pluginId) continue;
        const record = await read(pluginId, now);
        if (record) out.push(record);
      }
      return out;
    },
    async acquire(pluginId, ownerId, ttlMs, now = Date.now()) {
      if (!pluginId || !ownerId) return { ok: false, lockedBy: (await read(pluginId, now))?.ownerId };
      const ttl = normalizeTtl(ttlMs);
      const leaseUntil = now + ttl;
      const fresh: PluginLockRecord = { pluginId, ownerId, leaseUntil, renewals: 0 };
      const key = keyFor(pluginId);

      // 1. Frei? dann atomar nehmen (SET NX PX).
      if ((await client.set(key, JSON.stringify(fresh), { NX: true, PX: ttl })) === 'OK') {
        return { ok: true, record: fresh };
      }
      const existing = parseRecord(await client.get(key), pluginId);
      if (!existing) {
        // Zwischen NX und GET abgelaufen: ein zweiter Versuch, danach aufgeben.
        const retry = await client.set(key, JSON.stringify(fresh), { NX: true, PX: ttl });
        return retry === 'OK' ? { ok: true, record: fresh } : { ok: false };
      }
      if (existing.ownerId !== ownerId) return { ok: false, lockedBy: existing.ownerId };

      // 2. Gleicher Halter = Heartbeat: Lease verlaengern (SET XX PX).
      const renewed: PluginLockRecord = { ...existing, leaseUntil, renewals: existing.renewals + 1 };
      if ((await client.set(key, JSON.stringify(renewed), { XX: true, PX: ttl })) === 'OK') {
        return { ok: true, record: renewed };
      }
      // Die Lease lief genau zwischen GET und SET ab - als Neuzugriff versuchen.
      const retry = await client.set(key, JSON.stringify(fresh), { NX: true, PX: ttl });
      return retry === 'OK' ? { ok: true, record: fresh } : { ok: false };
    },
    async release(pluginId, ownerId, now = Date.now()) {
      const existing = await read(pluginId, now);
      if (!existing) return true; // bereits frei/abgelaufen
      if (existing.ownerId !== ownerId) return false; // Fremdfreigabe ist ausgeschlossen
      await client.del(keyFor(pluginId));
      return true;
    },
    async close() {
      try {
        await client.quit?.();
      } catch {
        try { client.disconnect?.(); } catch { skip(); }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Semantik ueber dem Store (Spiegel der AuthoritativeSession-Regeln)
// ---------------------------------------------------------------------------

export interface TransferLockResult {
  ok: boolean;
  reason?: 'invalid' | 'not-owner' | 'same-owner';
  lockedBy?: string;
}

/**
 * Uebergabe des Halters - dieselben Regeln wie `AuthoritativeSession.transferLock`
 * (COLLAB-P0-004): nur der AKTUELLE Halter, kein Admin-Fallback, kein Wechsel
 * auf sich selbst, leere/Leerzeichen-IDs sind ungueltig.
 */
export async function transferPluginLockInStore(
  store: PluginLockStore,
  pluginId: string,
  fromUserId: string,
  toUserId: string,
  ttlMs: number,
  now = Date.now(),
): Promise<TransferLockResult> {
  const from = typeof fromUserId === 'string' ? fromUserId.trim() : '';
  const to = typeof toUserId === 'string' ? toUserId.trim() : '';
  const current = pluginId ? await store.get(pluginId, now) : null;
  if (!pluginId || !from || !to) return { ok: false, reason: 'invalid', lockedBy: current?.ownerId };
  if (from === to) return { ok: false, reason: 'same-owner', lockedBy: from };
  if (current?.ownerId !== from) return { ok: false, reason: 'not-owner', lockedBy: current?.ownerId };
  await store.release(pluginId, from, now);
  const acquired = await store.acquire(pluginId, to, ttlMs, now);
  if (!acquired.ok) return { ok: false, reason: 'invalid', lockedBy: acquired.lockedBy };
  return { ok: true, lockedBy: to };
}

/**
 * mixerMONK-Halter (UI2-P0-001): hat das Plugin keinen Halter oder ist der
 * Halter nicht mehr im Raum, bekommt es das am laengsten anwesende Mitglied.
 * Liefert den neuen Halter oder `null`, wenn sich nichts geaendert hat.
 */
export async function ensureLockHolderInStore(
  store: PluginLockStore,
  pluginId: string,
  memberIdsInJoinOrder: readonly string[],
  ttlMs: number,
  now = Date.now(),
): Promise<string | null> {
  const members = memberIdsInJoinOrder.map((m) => (typeof m === 'string' ? m.trim() : '')).filter(Boolean);
  const owner = await store.get(pluginId, now);
  if (owner && members.includes(owner.ownerId)) return null;
  if (owner) await store.release(pluginId, owner.ownerId, now);
  const next = members[0];
  if (!next) return null;
  const acquired = await store.acquire(pluginId, next, ttlMs, now);
  return acquired.ok ? next : null;
}

/** Alle Locks eines Users freigeben (Disconnect/Leave). Liefert die Plugin-IDs. */
export async function releaseUserLocksInStore(
  store: PluginLockStore,
  userId: string,
  now = Date.now(),
): Promise<string[]> {
  if (!userId) return [];
  const held = await store.list(now);
  const released: string[] = [];
  for (const lock of held) {
    if (lock.ownerId !== userId) continue;
    const ok = await store.release(lock.pluginId, userId, now);
    if (ok) released.push(lock.pluginId);
  }
  return released;
}

// ---------------------------------------------------------------------------
// Fallback: Redis darf den Betrieb nicht toeten
// ---------------------------------------------------------------------------

export interface FallbackLockStoreOptions {
  log: (message: string) => void;
  fallback?: PluginLockStore;
}

/**
 * Legt den Prozess-Speicher unter einen (Redis-)Store. Schlaegt der obere Store
 * fehl, wird EINMAL laut geloggt und ab dann nur noch der untere benutzt -
 * kein Werfen, kein Hin- und Herschalten (das wuerde Locks verlieren).
 */
export function withMemoryFallback(primary: PluginLockStore, options: FallbackLockStoreOptions): PluginLockStore {
  const fallback = options.fallback ?? createMemoryPluginLockStore();
  let degraded = false;

  const guard = async <T>(operation: string, primaryCall: () => Promise<T>, fallbackCall: () => Promise<T>): Promise<T> => {
    if (degraded) return fallbackCall();
    try {
      return await primaryCall();
    } catch (error) {
      degraded = true;
      const reason = error instanceof Error ? error.message : String(error);
      options.log(
        `[locks] ${operation} im Redis-Lock-Store fehlgeschlagen (${reason}) – Fallback auf den Prozess-Speicher. `
        + 'Plugin-Locks sind ab jetzt NICHT mehr instanzuebergreifend (Grund im Log oben).',
      );
      return fallbackCall();
    }
  };

  return {
    kind: primary.kind,
    get degraded() { return degraded; },
    get(pluginId, now) {
      return guard('get', () => primary.get(pluginId, now), () => fallback.get(pluginId, now));
    },
    set(record, now) {
      return guard('set', () => primary.set(record, now), () => fallback.set(record, now));
    },
    delete(pluginId) {
      return guard('delete', () => primary.delete(pluginId), () => fallback.delete(pluginId));
    },
    list(now) {
      return guard('list', () => primary.list(now), () => fallback.list(now));
    },
    acquire(pluginId, ownerId, ttlMs, now) {
      return guard(
        'acquire',
        () => primary.acquire(pluginId, ownerId, ttlMs, now),
        () => fallback.acquire(pluginId, ownerId, ttlMs, now),
      );
    },
    release(pluginId, ownerId, now) {
      return guard('release', () => primary.release(pluginId, ownerId, now), () => fallback.release(pluginId, ownerId, now));
    },
    async close() {
      await primary.close().catch(() => { /* best effort */ });
      await fallback.close().catch(() => { /* best effort */ });
    },
  };
}

// ---------------------------------------------------------------------------
// Fabrik: Memory ohne REDIS_URL, Redis nur mit REDIS_URL
// ---------------------------------------------------------------------------

export interface PluginLockStoreHandle {
  store: PluginLockStore;
  /** Nur bei erfolgreichem Redis-Anschluss gesetzt (Wiederverwendung fuer Persistenz). */
  client?: LockRedisClient;
  close(): Promise<void>;
}

export interface PluginLockStoreFromEnvOptions {
  env?: Record<string, string | undefined>;
  log?: (message: string) => void;
  warn?: (message: string, error?: unknown) => void;
  prefix?: string;
  /** Test-Haken: Client-Fabrik statt `redis.createClient`. */
  createClient?: (url: string) => Promise<LockRedisClient>;
}

/**
 * Default (kein `REDIS_URL`): reiner Memory-Store - der Betrieb ist exakt wie
 * vor diesem Ticket, inklusive der Session als autoritativem Lock-Halter.
 *
 * Mit `REDIS_URL`: Redis-Store ueber EINER Verbindung, die auch die
 * Session-Persistenz mitbenutzt. Schlaegt Verbindung/Ping fehl, gibt es eine
 * Warnzeile und Memory - nie einen Startabbruch.
 */
export async function createPluginLockStoreFromEnv(
  options: PluginLockStoreFromEnvOptions = {},
): Promise<PluginLockStoreHandle> {
  const env = options.env ?? process.env;
  const log = options.log ?? ((message: string) => console.log(message));
  const warn = options.warn ?? ((message: string, error?: unknown) => console.warn(message, error ?? ''));
  const rawUrl = typeof env.REDIS_URL === 'string' ? env.REDIS_URL.trim() : '';

  if (!rawUrl) {
    // Single-Instance-Default: keine Zeile, kein Verhalten aendert sich.
    return { store: createMemoryPluginLockStore(), close: async () => {} };
  }

  const url = normalizeRedisUrl(rawUrl);
  if (!url) {
    warn('[locks] REDIS_URL hat kein redis://- oder rediss://-Schema – Lock-Store bleibt pro Prozess (Memory).');
    return { store: createMemoryPluginLockStore(), close: async () => {} };
  }

  let client: LockRedisClient | null = null;
  try {
    if (options.createClient) {
      client = await options.createClient(url);
    } else {
      const mod = (await import('redis')) as unknown as { createClient: (opts: { url: string }) => LockRedisClient };
      client = mod.createClient({ url });
    }
    client.on?.('error', (error: unknown) => {
      warn('[locks] Redis-Client-Fehler:', error instanceof Error ? error.message : error);
    });
    const connect = (client as unknown as { connect?: () => Promise<unknown> }).connect;
    if (typeof connect === 'function') await connect.call(client);
    if (typeof client.ping === 'function') await client.ping();

    const store = withMemoryFallback(createRedisPluginLockStore(client, { prefix: options.prefix }), { log });
    log(`[locks] Redis-Lock-Store aktiv (${url.replace(/\/\/[^@]*@/, '//***@')}) – Plugin-Locks gelten instanzuebergreifend.`);
    const sharedClient = client;
    return {
      store,
      client: sharedClient,
      close: async () => { await store.close().catch(() => { /* best effort */ }); },
    };
  } catch (error) {
    warn('[locks] Redis-Lock-Store nicht erreichbar – Plugin-Locks bleiben pro Prozess (Memory):', error instanceof Error ? error.message : error);
    try { await client?.quit?.(); } catch { try { client?.disconnect?.(); } catch { /* best effort */ } }
    return { store: createMemoryPluginLockStore(), close: async () => {} };
  }
}
