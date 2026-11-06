import { describe, expect, it, vi } from 'vitest';
import {
  createMemoryPluginLockStore,
  createPluginLockStoreFromEnv,
  createRedisPluginLockStore,
  describeLockBackend,
  ensureLockHolderInStore,
  normalizeRedisUrl,
  releaseUserLocksInStore,
  transferPluginLockInStore,
  withMemoryFallback,
  DEFAULT_PLUGIN_LOCK_KEY_PREFIX,
  type LockRedisClient,
  type PluginLockStore,
} from '../server/lockStore';
import { AuthoritativeSession } from '../src/core/session/authoritativeSession';

/**
 * AUDIT-2026-10-30 P1-007 · Plugin-Lock-Speicher
 * =====================================================================
 * Vorher lagen die Locks in der Map EINER Session (= eines Prozesses). Diese
 * Datei prueft den Vertrag, den beide Implementierungen erfuellen muessen, und
 * zwar ohne echten Redis:
 *
 *   - Fremde Loesung ist unmoeglich (nur der Halter gibt frei).
 *   - Die Lease laeuft ab und gibt den Lock wieder frei.
 *   - Zwei "Instanzen" (zwei Stores) auf DEMSELBEN Client sehen denselben Lock.
 *   - Ein kaputter Redis-Client wirft nicht, sondern faellt sichtbar auf Memory.
 */

/** Redis-Ersatz mit echtem SET-NX/XX/PX-Verhalten und steuerbarer Uhr. */
function fakeRedis(clock = { now: 1_000_000 }) {
  const raw = new Map<string, { value: string; expiresAt: number | null }>();
  const alive = (entry: { expiresAt: number | null } | undefined): boolean =>
    Boolean(entry) && (entry!.expiresAt === null || entry!.expiresAt > clock.now);
  const read = (key: string) => {
    const entry = raw.get(key);
    if (!entry) return null;
    if (!alive(entry)) {
      raw.delete(key);
      return null;
    }
    return entry;
  };
  const client: LockRedisClient & {
    raw: Map<string, { value: string; expiresAt: number | null }>;
    clock: { now: number };
    connect: () => Promise<void>;
    ping: () => Promise<void>;
  } = {
    raw,
    clock,
    connect: async () => {},
    ping: async () => {},
    get: (key: string) => read(key)?.value ?? null,
    set: (key: string, value: string, options: { NX?: boolean; XX?: boolean; PX?: number } = {}) => {
      const existing = read(key);
      if (options.NX && existing) return null;
      if (options.XX && !existing) return null;
      raw.set(key, {
        value,
        expiresAt: typeof options.PX === 'number' ? clock.now + options.PX : null,
      });
      return 'OK';
    },
    del: (...keys: string[]) => {
      let removed = 0;
      for (const key of keys) if (raw.delete(key)) removed += 1;
      return removed;
    },
    keys: (pattern: string) => {
      const prefix = pattern.replace(/\*$/, '');
      return [...raw.keys()].filter((key) => key.startsWith(prefix) && read(key));
    },
    quit: () => 'OK',
  };
  return client;
}

const TTL = 60_000;

// ---------------------------------------------------------------------------
// Beide Implementierungen gegen denselben Vertrag
// ---------------------------------------------------------------------------

const implementations: Array<{ name: string; make: () => { store: PluginLockStore; clock: { now: number } } }> = [
  {
    name: 'Memory',
    make: () => ({ store: createMemoryPluginLockStore(), clock: { now: 1_000_000 } }),
  },
  {
    name: 'Redis (Fake)',
    make: () => {
      const client = fakeRedis();
      return { store: createRedisPluginLockStore(client), clock: client.clock };
    },
  },
];

describe.each(implementations)('P1-007 · Lock-Store-Vertrag (%s)', ({ make }) => {
  it('vergibt einen freien Lock und verweigert ihn einem zweiten Halter', async () => {
    const { store, clock } = make();

    const first = await store.acquire('mixer', 'user-1', TTL, clock.now);
    expect(first.ok).toBe(true);
    expect(first.record?.ownerId).toBe('user-1');

    const second = await store.acquire('mixer', 'user-2', TTL, clock.now);
    expect(second.ok).toBe(false);
    expect(second.lockedBy).toBe('user-1');

    expect(await store.get('mixer', clock.now)).toMatchObject({ pluginId: 'mixer', ownerId: 'user-1' });
    expect(await store.get('eq', clock.now)).toBeNull();
  });

  it('Fremdfreigabe ist unmoeglich', async () => {
    const { store, clock } = make();
    await store.acquire('mixer', 'user-1', TTL, clock.now);

    expect(await store.release('mixer', 'user-2', clock.now)).toBe(false);
    // Der Lock lebt weiter und gehoert weiter user-1.
    expect((await store.get('mixer', clock.now))?.ownerId).toBe('user-1');

    expect(await store.release('mixer', 'user-1', clock.now)).toBe(true);
    expect(await store.get('mixer', clock.now)).toBeNull();
    // Doppelte Freigabe ist kein Fehler (bereits frei).
    expect(await store.release('mixer', 'user-1', clock.now)).toBe(true);
  });

  it('die Lease laeuft ab und gibt den Lock fuer andere frei', async () => {
    const { store, clock } = make();
    await store.acquire('mixer', 'user-1', 1_000, clock.now);

    expect(await store.get('mixer', clock.now + 999)).not.toBeNull();
    clock.now += 1_000;

    expect(await store.get('mixer', clock.now)).toBeNull();
    expect(await store.list(clock.now)).toEqual([]);
    const takeover = await store.acquire('mixer', 'user-2', TTL, clock.now);
    expect(takeover.ok).toBe(true);
    expect(takeover.record?.ownerId).toBe('user-2');
  });

  it('gleicher Halter verlaengert die Lease (Heartbeat), ohne den Halter zu wechseln', async () => {
    const { store, clock } = make();
    const first = await store.acquire('eq', 'user-1', 1_000, clock.now);
    expect(first.record?.renewals).toBe(0);

    clock.now += 500;
    const renewed = await store.acquire('eq', 'user-1', 1_000, clock.now);

    expect(renewed.ok).toBe(true);
    expect(renewed.record?.ownerId).toBe('user-1');
    expect(renewed.record?.renewals).toBe(1);
    // Lease reicht jetzt bis now+1000, nicht mehr bis start+1000.
    expect(await store.get('eq', clock.now + 900)).not.toBeNull();
  });

  it('list und delete arbeiten ueber alle Plugins', async () => {
    const { store, clock } = make();
    await store.acquire('mixer', 'user-1', TTL, clock.now);
    await store.acquire('eq', 'user-2', TTL, clock.now);

    const all = await store.list(clock.now);
    expect(all.map((lock) => lock.pluginId).sort()).toEqual(['eq', 'mixer']);

    expect(await store.delete('eq')).toBe(true);
    expect(await store.delete('eq')).toBe(false);
    expect((await store.list(clock.now)).map((lock) => lock.pluginId)).toEqual(['mixer']);
  });

  it('leere Plugin-/Nutzer-IDs werden nicht gesperrt', async () => {
    const { store, clock } = make();
    expect((await store.acquire('', 'user-1', TTL, clock.now)).ok).toBe(false);
    expect((await store.acquire('mixer', '', TTL, clock.now)).ok).toBe(false);
    expect(await store.list(clock.now)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Mehrinstanzfaehigkeit: zwei Stores, ein Redis
// ---------------------------------------------------------------------------

describe('P1-007 · zwei Instanzen auf demselben Redis', () => {
  it('sehen denselben Lock und koennen ihn nicht doppelt vergeben', async () => {
    const client = fakeRedis();
    const instanzA = createRedisPluginLockStore(client);
    const instanzB = createRedisPluginLockStore(client);

    expect((await instanzA.acquire('mixer', 'user-1', TTL, client.clock.now)).ok).toBe(true);

    // B sieht den Lock von A, ohne dass A etwas nachsynchronisieren muss.
    expect((await instanzB.get('mixer', client.clock.now))?.ownerId).toBe('user-1');
    const denied = await instanzB.acquire('mixer', 'user-2', TTL, client.clock.now);
    expect(denied).toMatchObject({ ok: false, lockedBy: 'user-1' });
    expect((await instanzB.list(client.clock.now)).map((l) => l.pluginId)).toEqual(['mixer']);
  });

  it('eine Uebergabe auf Instanz B ist fuer Instanz A sofort sichtbar', async () => {
    const client = fakeRedis();
    const instanzA = createRedisPluginLockStore(client);
    const instanzB = createRedisPluginLockStore(client);
    await instanzA.acquire('mixer', 'user-1', TTL, client.clock.now);

    const result = await transferPluginLockInStore(instanzB, 'mixer', 'user-1', 'user-2', TTL, client.clock.now);

    expect(result).toEqual({ ok: true, lockedBy: 'user-2' });
    expect((await instanzA.get('mixer', client.clock.now))?.ownerId).toBe('user-2');
    // Der alte Halter kann danach nicht mehr freigeben.
    expect(await instanzA.release('mixer', 'user-1', client.clock.now)).toBe(false);
  });

  it('Traegt Locks unter eigenem Praefix und ignoriert fremde Schluessel', async () => {
    const client = fakeRedis();
    const store = createRedisPluginLockStore(client);
    await store.acquire('mixer', 'user-1', TTL, client.clock.now);
    client.raw.set('audiomonastry:kv:snapshot:1', { value: '{}', expiresAt: null });
    client.raw.set('fremd:key', { value: 'x', expiresAt: null });

    expect([...client.raw.keys()]).toContain(`${DEFAULT_PLUGIN_LOCK_KEY_PREFIX}mixer`);
    expect((await store.list(client.clock.now)).map((l) => l.pluginId)).toEqual(['mixer']);
  });
});

// ---------------------------------------------------------------------------
// Semantik ueber dem Store: Paritaet zur AuthoritativeSession
// ---------------------------------------------------------------------------

describe('P1-007 · Halter-/Uebergabe-Regeln wie in der Session', () => {
  it('Uebergabe: nur der Halter, kein Selbstwechsel, keine leeren IDs', async () => {
    const store = createMemoryPluginLockStore();
    const now = 1_000_000;
    await store.acquire('mixer', 'user-a', TTL, now);

    expect(await transferPluginLockInStore(store, 'mixer', 'user-b', 'user-c', TTL, now))
      .toEqual({ ok: false, reason: 'not-owner', lockedBy: 'user-a' });
    expect(await transferPluginLockInStore(store, 'mixer', 'user-a', 'user-a', TTL, now))
      .toEqual({ ok: false, reason: 'same-owner', lockedBy: 'user-a' });
    expect(await transferPluginLockInStore(store, 'mixer', '', 'user-c', TTL, now))
      .toMatchObject({ ok: false, reason: 'invalid' });
    expect(await transferPluginLockInStore(store, 'mixer', 'user-a', '  ', TTL, now))
      .toMatchObject({ ok: false, reason: 'invalid' });
    // Nichts davon hat den Halter verschoben.
    expect((await store.get('mixer', now))?.ownerId).toBe('user-a');

    expect(await transferPluginLockInStore(store, 'mixer', 'user-a', 'user-b', TTL, now))
      .toEqual({ ok: true, lockedBy: 'user-b' });
  });

  it('verhaelt sich wie AuthoritativeSession.transferLock (gleiche Gruende)', async () => {
    const now = 1_000_000;
    const store = createMemoryPluginLockStore();
    const session = new AuthoritativeSession({ lockTtlMs: TTL });
    await store.acquire('mixer', 'user-a', TTL, now);
    session.acquireLock('mixer', 'user-a', now, TTL);

    const faelle: Array<[string, string]> = [
      ['user-b', 'user-c'], // not-owner
      ['user-a', 'user-a'], // same-owner
      ['', 'user-c'], // invalid
      ['user-a', 'user-b'], // ok
      ['user-b', 'user-c'], // nach der Uebergabe ist b nicht mehr Halter
    ];
    for (const [from, to] of faelle) {
      const expected = session.transferLock('mixer', from, to, now, TTL);
      const actual = await transferPluginLockInStore(store, 'mixer', from, to, TTL, now);
      expect({ ok: actual.ok, reason: actual.reason, lockedBy: actual.lockedBy }).toEqual({
        ok: expected.ok, reason: expected.reason, lockedBy: expected.lockedBy,
      });
    }
    // Der letzte Fall hat den Lock weitergegeben (b war da schon Halter).
    expect((await store.get('mixer', now))?.ownerId).toBe('user-c');
  });

  it('ensureHolder gibt den Lock an das aelteste Mitglied, wenn der Halter weg ist', async () => {
    const store = createMemoryPluginLockStore();
    const now = 1_000_000;
    expect(await ensureLockHolderInStore(store, 'mixer', ['user-a', 'user-b'], TTL, now)).toBe('user-a');
    // Halter ist noch da -> keine Aenderung.
    expect(await ensureLockHolderInStore(store, 'mixer', ['user-a', 'user-b'], TTL, now)).toBeNull();
    // Halter verlaesst den Raum -> naechstes Mitglied.
    expect(await ensureLockHolderInStore(store, 'mixer', ['user-b'], TTL, now)).toBe('user-b');
    // Leerer Raum -> kein Halter (aber auch kein Fehler).
    expect(await ensureLockHolderInStore(store, 'mixer', [], TTL, now)).toBeNull();
  });

  it('releaseUserLocks gibt nur die Locks DIESES Users frei', async () => {
    const store = createMemoryPluginLockStore();
    const now = 1_000_000;
    await store.acquire('mixer', 'user-a', TTL, now);
    await store.acquire('eq', 'user-a', TTL, now);
    await store.acquire('stem', 'user-b', TTL, now);

    const released = await releaseUserLocksInStore(store, 'user-a', now);

    expect(released.sort()).toEqual(['eq', 'mixer']);
    expect((await store.list(now)).map((l) => l.pluginId)).toEqual(['stem']);
  });
});

// ---------------------------------------------------------------------------
// Fallback: ein kaputter Redis toetet den Betrieb nicht
// ---------------------------------------------------------------------------

function brokenClient(message = 'ECONNREFUSED'): LockRedisClient {
  const fail = () => { throw new Error(message); };
  return {
    get: fail,
    set: fail,
    del: fail,
    keys: fail,
    quit: async () => { throw new Error(message); },
  } as unknown as LockRedisClient;
}

describe('P1-007 · Redis-Ausfall faellt sichtbar auf Memory zurueck', () => {
  it('wirft nicht, sondern liefert Memory-Antworten und schaltet dauerhaft um', async () => {
    const log = vi.fn();
    const store = withMemoryFallback(createRedisPluginLockStore(brokenClient()), { log });
    expect(describeLockBackend(store)).toBe('redis');

    const acquired = await store.acquire('mixer', 'user-1', TTL, 1_000_000);

    expect(acquired.ok).toBe(true);
    expect(store.degraded).toBe(true);
    expect(describeLockBackend(store)).toBe('redis-degraded');
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain('Fallback auf den Prozess-Speicher');
    expect(log.mock.calls[0][0]).toContain('ECONNREFUSED');

    // Ab jetzt ohne weiteren Redis-Zugriff: der zweite Halter wird abgewiesen.
    expect((await store.acquire('mixer', 'user-2', TTL, 1_000_000)).ok).toBe(false);
    // Einmal umgeschaltet, bleibt es umgeschaltet (kein Hin und Her).
    expect(log).toHaveBeenCalledTimes(1);
    expect((await store.list(1_000_000)).map((l) => l.pluginId)).toEqual(['mixer']);
    expect(await store.get('mixer', 1_000_000)).toMatchObject({ ownerId: 'user-1' });
  });

  it('ein kaputter Client beim AUFBAU fuehrt zu Memory statt zu einem Startfehler', async () => {
    const warn = vi.fn();
    const handle = await createPluginLockStoreFromEnv({
      env: { REDIS_URL: 'redis://127.0.0.1:6399' },
      log: vi.fn(),
      warn,
      createClient: async () => {
        const client = fakeRedis();
        client.connect = async () => { throw new Error('ECONNREFUSED'); };
        return client;
      },
    });

    expect(describeLockBackend(handle.store)).toBe('memory');
    expect(handle.client).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0][0])).toContain('Memory');
    // Betrieb laeuft weiter.
    expect((await handle.store.acquire('mixer', 'user-1', TTL)).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Default: ohne REDIS_URL alles wie heute
// ---------------------------------------------------------------------------

describe('P1-007 · Default ohne REDIS_URL ist Memory', () => {
  it('liefert einen Memory-Store ohne Redis-Zugriff und ohne Logzeile', async () => {
    const log = vi.fn();
    const warn = vi.fn();
    const handle = await createPluginLockStoreFromEnv({ env: {}, log, warn });

    expect(handle.store.kind).toBe('memory');
    expect(describeLockBackend(handle.store)).toBe('memory');
    expect(handle.client).toBeUndefined();
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    await expect(handle.close()).resolves.toBeUndefined();
  });

  it('akzeptiert nur redis:// und rediss://', async () => {
    expect(normalizeRedisUrl('redis://redis:6379')).toBe('redis://redis:6379');
    expect(normalizeRedisUrl(' rediss://redis:6379 ')).toBe('rediss://redis:6379');
    expect(normalizeRedisUrl('http://redis:6379')).toBe('');
    expect(normalizeRedisUrl('')).toBe('');

    const warn = vi.fn();
    const handle = await createPluginLockStoreFromEnv({ env: { REDIS_URL: 'http://redis:6379' }, warn, log: vi.fn() });
    expect(handle.store.kind).toBe('memory');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('mit erreichbarem Redis ist der Store geteilt und nutzt den Client weiter', async () => {
    const client = fakeRedis();
    const handle = await createPluginLockStoreFromEnv({
      env: { REDIS_URL: 'redis://redis:6379' },
      log: vi.fn(),
      warn: vi.fn(),
      createClient: async () => client,
    });

    expect(describeLockBackend(handle.store)).toBe('redis');
    expect(handle.client).toBe(client);
    expect((await handle.store.acquire('mixer', 'user-1', TTL, client.clock.now)).ok).toBe(true);
    await expect(handle.close()).resolves.toBeUndefined();
  });
});
