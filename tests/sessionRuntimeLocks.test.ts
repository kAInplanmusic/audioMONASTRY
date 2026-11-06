import { describe, expect, it, vi } from 'vitest';
import { createSessionRuntime } from '../server/sessionRuntime';
import {
  createMemoryPluginLockStore,
  createRedisPluginLockStore,
  withMemoryFallback,
  type LockRedisClient,
  type PluginLockStore,
} from '../server/lockStore';

/**
 * AUDIT-2026-10-30 P1-007 · Session-Laufzeit mit geteiltem Lock-Speicher
 * =====================================================================
 * Zwei Dinge muessen gleichzeitig gelten:
 *
 *   1. OHNE geteilten Store ist alles wie heute - die Session haelt die Locks,
 *      der Store wird nicht einmal angefasst (Single-Instance-Default).
 *   2. MIT Redis-Store sehen zwei Laufzeiten ("zwei Instanzen") denselben Lock;
 *      ein kaputter Store wirft nicht, sondern faellt sichtbar auf Memory.
 */

/** Redis-Ersatz mit SET NX/XX/PX; die Uhr ist die echte (die Laufzeit nutzt Date.now). */
function fakeRedis() {
  const raw = new Map<string, { value: string; expiresAt: number | null }>();
  const client: LockRedisClient & { raw: Map<string, { value: string; expiresAt: number | null }> } = {
    raw,
    get: (key: string) => {
      const entry = raw.get(key);
      if (!entry) return null;
      if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
        raw.delete(key);
        return null;
      }
      return entry.value;
    },
    set: (key: string, value: string, options: { NX?: boolean; XX?: boolean; PX?: number } = {}) => {
      const entry = raw.get(key);
      const alive = entry && (entry.expiresAt === null || entry.expiresAt > Date.now());
      if (options.NX && alive) return null;
      if (options.XX && !alive) return null;
      raw.set(key, {
        value,
        expiresAt: typeof options.PX === 'number' ? Date.now() + options.PX : null,
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
      return [...raw.keys()].filter((key) => key.startsWith(prefix));
    },
  };
  return client;
}

function brokenRedis(): LockRedisClient {
  const fail = () => { throw new Error('redis down'); };
  return { get: fail, set: fail, del: fail, keys: fail, quit: async () => { throw new Error('redis down'); } };
}

describe('P1-007 · ohne REDIS_URL bleibt alles wie heute (Memory)', () => {
  it('benutzt die Session als Lock-Halter und fasst den Store nicht an', async () => {
    const store = createMemoryPluginLockStore();
    const spy = {
      acquire: vi.spyOn(store, 'acquire'),
      release: vi.spyOn(store, 'release'),
      get: vi.spyOn(store, 'get'),
      list: vi.spyOn(store, 'list'),
    };
    const runtime = createSessionRuntime({ lockStore: store });

    expect(runtime.lockBackend()).toBe('memory');

    const first = await runtime.acquirePluginLock('mixer', 'user-1');
    expect(first).toEqual({ ok: true });
    // Unveraendert: die Session haelt den Lock (synchron lesbar fuer Main-Out/Ops).
    expect(runtime.session.lockOwner('mixer')).toBe('user-1');
    expect(runtime.legacyLockMap().mixer).toMatchObject({ lockedBy: 'user-1' });

    const denied = await runtime.acquirePluginLock('mixer', 'user-2');
    expect(denied).toEqual({ ok: false, lockedBy: 'user-1' });

    expect(await runtime.transferPluginLock('mixer', 'user-1', 'user-2')).toMatchObject({ ok: true, lockedBy: 'user-2' });
    expect(await runtime.releasePluginLock('mixer', 'user-2')).toBe(true);
    expect(runtime.session.lockOwner('mixer')).toBeNull();

    // Der Kern des Nachweises: kein einziger Store-Aufruf im Memory-Pfad.
    expect(spy.acquire).not.toHaveBeenCalled();
    expect(spy.release).not.toHaveBeenCalled();
    expect(spy.get).not.toHaveBeenCalled();
    expect(spy.list).not.toHaveBeenCalled();
    runtime.stop();
  });

  it('Sweep und Broadcast laufen unveraendert lokal', async () => {
    const runtime = createSessionRuntime({ lockTtlMs: 1_000 });
    const broadcast = vi.fn();
    runtime.setLockExpiryBroadcaster(broadcast);
    // Abgelaufene Lease direkt in die Session legen (wie der alte Testpfad).
    runtime.session.acquireLock('eq', 'user-1', Date.now() - 60_000, 10);

    const expired = await runtime.sweepExpiredLocksAsync();

    expect(expired).toContain('eq');
    expect(broadcast).toHaveBeenCalledWith('eq');
    expect(runtime.session.lockOwner('eq')).toBeNull();
    runtime.stop();
  });
});

describe('P1-007 · zwei Instanzen mit gemeinsamem Redis-Lock-Store', () => {
  const build = () => {
    const client = fakeRedis();
    const store = createRedisPluginLockStore(client);
    const a = createSessionRuntime({ lockStore: store });
    const b = createSessionRuntime({ lockStore: store });
    return { client, store, a, b };
  };

  it('sehen denselben Lock - der zweite Halter wird abgewiesen', async () => {
    const { a, b } = build();

    expect(a.lockBackend()).toBe('redis');
    expect((await a.acquirePluginLock('mixer', 'user-1')).ok).toBe(true);
    const denied = await b.acquirePluginLock('mixer', 'user-2');

    expect(denied).toEqual({ ok: false, lockedBy: 'user-1' });
    // B hat die lokale Sicht auf den ECHTEN Halter nachgezogen.
    expect(await b.resolveLockOwner('mixer')).toBe('user-1');
    expect(b.session.lockOwner('mixer')).toBe('user-1');
    a.stop(); b.stop();
  });

  it('Freigabe auf Instanz A gibt den Lock auf B sofort frei', async () => {
    const { a, b } = build();
    await a.acquirePluginLock('mixer', 'user-1');

    expect(await a.releasePluginLock('mixer', 'user-1')).toBe(true);

    expect(await b.acquirePluginLock('mixer', 'user-2')).toEqual({ ok: true });
    // A sieht den neuen Halter, ohne dass A etwas geschrieben hat.
    expect(await a.resolveLockOwner('mixer')).toBe('user-2');
    a.stop(); b.stop();
  });

  it('Fremdfreigabe ist auch ueber die Laufzeit unmoeglich', async () => {
    const { a, b } = build();
    await a.acquirePluginLock('mixer', 'user-1');

    expect(await b.releasePluginLock('mixer', 'user-2')).toBe(false);
    expect(await a.resolveLockOwner('mixer')).toBe('user-1');
    a.stop(); b.stop();
  });

  it('Uebergabe, Halter-Vergabe und User-Freigabe laufen ueber den Store', async () => {
    const { a, b } = build();
    await a.acquirePluginLock('mixer', 'user-1');
    await a.acquirePluginLock('eq', 'user-1');

    expect(await b.transferPluginLock('mixer', 'user-1', 'user-2')).toEqual({ ok: true, lockedBy: 'user-2' });
    expect(await a.resolveLockOwner('mixer')).toBe('user-2');

    // Halter weg -> naechstes Mitglied bekommt den Lock (auch von der anderen Instanz).
    expect(await a.ensureLockHolder('mixer', ['user-2', 'user-3'])).toBeNull();
    expect(await a.ensureLockHolder('mixer', ['user-3'])).toBe('user-3');

    const released = await b.releaseUserLocks('user-3');
    expect(released).toEqual(['mixer']);
    expect(await a.resolveLockOwner('mixer')).toBeNull();
    // eq gehoert user-1 und bleibt unberuehrt.
    expect(await a.resolveLockOwner('eq')).toBe('user-1');
    a.stop(); b.stop();
  });

  it('refreshLocks zieht die lokale Sicht nach (auch ohne eigene Mutation)', async () => {
    const { a, b } = build();
    await a.acquirePluginLock('stem', 'user-9');
    expect(b.session.lockOwner('stem')).toBeNull();

    await b.refreshLocks();

    expect(b.session.lockOwner('stem')).toBe('user-9');
    a.stop(); b.stop();
  });

  it('Sweep broadcastet einen Lock, der im Store verschwunden ist', async () => {
    const { a, b, store } = build();
    await a.acquirePluginLock('eq', 'user-1');
    await b.refreshLocks();
    const broadcast = vi.fn();
    b.setLockExpiryBroadcaster(broadcast);

    await store.delete('eq');
    const expired = await b.sweepExpiredLocksAsync();

    expect(expired).toEqual(['eq']);
    expect(broadcast).toHaveBeenCalledWith('eq');
    a.stop(); b.stop();
  });
});

describe('P1-007 · kaputter Redis-Store toetet die Laufzeit nicht', () => {
  it('acquire/release/list werfen nicht, sondern arbeiten auf Memory weiter', async () => {
    const log = vi.fn();
    const store: PluginLockStore = withMemoryFallback(createRedisPluginLockStore(brokenRedis()), { log });
    const runtime = createSessionRuntime({ lockStore: store });

    await expect(runtime.acquirePluginLock('mixer', 'user-1')).resolves.toEqual({ ok: true });
    expect(runtime.lockBackend()).toBe('redis-degraded');
    expect(store.degraded).toBe(true);
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][0])).toContain('Fallback auf den Prozess-Speicher');

    await expect(runtime.acquirePluginLock('mixer', 'user-2')).resolves.toEqual({ ok: false, lockedBy: 'user-1' });
    await expect(runtime.resolveLockOwner('mixer')).resolves.toBe('user-1');
    await expect(runtime.sweepExpiredLocksAsync()).resolves.toEqual([]);
    await expect(runtime.releaseUserLocks('user-1')).resolves.toEqual(['mixer']);
    // Kein weiterer Fehler-Log: die Umschaltung ist endgueltig, nicht flatternd.
    expect(log).toHaveBeenCalledTimes(1);
    runtime.stop();
  });
});
