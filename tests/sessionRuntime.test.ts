import { describe, expect, it, vi } from 'vitest';
import { createSessionRuntime, SESSION_STATE_REDIS_KEY } from '../server/sessionRuntime';
import { AuthoritativeSession } from '../src/core/session/authoritativeSession';
import { SnapshotStore, createMemoryKeyValueStore } from '../src/core/persistence/snapshotStore';

/**
 * ARCH-P2-002 · Session-Laufzeit
 * =====================================================================
 * Der autoritative Zustand lag vorher als modulweiter Zustand in server.ts.
 * Beim Verschieben sind zwei Fehler real passiert (und hier abgesichert):
 * Snapshots wären in den Speicher statt nach Redis geschrieben worden, und der
 * Save-Timer hätte beim Session-Reset weiterlaufen können.
 */

/** Minimaler Redis-Ersatz für den Persistenz-Pfad. */
function fakeRedis(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => { store.set(key, value); return 'OK'; }),
  };
}


describe('ARCH-P2-002 · Session-Laufzeit', () => {
  it('stellt den Zustand aus dem Redis-Schluessel wieder her und wechselt die Persistenz', async () => {
    const source = new AuthoritativeSession({ lockTtlMs: 60_000 });
    source.acquireLock('mixer', 'user-7');
    const serialized = source.serialize();
    const redis = fakeRedis({ [SESSION_STATE_REDIS_KEY]: JSON.stringify(serialized) });

    const runtime = createSessionRuntime();
    const result = await runtime.restoreFromRedis(redis, createMemoryKeyValueStore());

    expect(result).toEqual({ restored: true, snapshotRestored: false });
    expect(runtime.session.lockOwner('mixer')).toBe('user-7');
    // Persistenz ist jetzt Redis: ein save() landet dort.
    await runtime.getPersistence().save(runtime.session.serialize());
    expect(redis.set).toHaveBeenCalledWith(SESSION_STATE_REDIS_KEY, expect.any(String));
  });

  it('stellt ohne State-Key den neuesten GUELTIGEN Snapshot wieder her', async () => {
    const source = new AuthoritativeSession({ lockTtlMs: 60_000 });
    source.acquireLock('eq', 'user-9');
    const kv = createMemoryKeyValueStore();
    const store = new SnapshotStore<ReturnType<AuthoritativeSession['serialize']>>(kv, {
      checksum: (input) => `sum-${input.length}`,
    });
    const serialized = source.serialize();
    await store.write(serialized, serialized.revision);

    // WICHTIG: die Prüfsummen-Funktion muss zwischen Schreiben und Lesen
    // dieselbe sein - sonst gilt der Snapshot als beschaedigt und wird (richtig)
    // verworfen. In server.ts ist sie an beiden Stellen SHA-256.
    const runtime = createSessionRuntime({ checksum: (input) => `sum-${input.length}` });
    const result = await runtime.restoreFromRedis(fakeRedis(), kv);

    expect(result).toEqual({ restored: false, snapshotRestored: true });
    expect(runtime.session.lockOwner('eq')).toBe('user-9');
  });

  it('liefert ohne Redis-Bestand einen frischen Zustand (kein stiller Fehlschlag)', async () => {
    const runtime = createSessionRuntime();
    const result = await runtime.restoreFromRedis(fakeRedis(), createMemoryKeyValueStore());
    expect(result).toEqual({ restored: false, snapshotRestored: false });
    expect(runtime.session.revision).toBe(0);
  });

  it('sammelt abgelaufene Locks ein und broadcastet sie', () => {
    const runtime = createSessionRuntime({ lockTtlMs: 1_000, lockSweepMs: 1_000 });
    const broadcast = vi.fn();
    runtime.setLockExpiryBroadcaster(broadcast);
    runtime.session.acquireLock('mixer', 'user-1', Date.now() - 60_000, 10);

    const expired = runtime.sweepExpiredLocks();

    expect(expired).toContain('mixer');
    // Der Broadcast ist der Unterschied zwischen "Lock weg" und "Client haelt ihn
    // noch" - ohne ihn erscheint das Plugin fuer andere weiter als gesperrt.
    expect(broadcast).toHaveBeenCalledWith('mixer');
    expect(runtime.session.lockOwner('mixer')).toBeNull();
    runtime.stop();
  });

  it('haelt das Legacy-Lock-Format fuer plugin-locks-sync stabil', () => {
    const runtime = createSessionRuntime();
    runtime.session.acquireLock('mixer', 'user-3');
    const map = runtime.legacyLockMap();
    expect(Object.keys(map)).toContain('mixer');
    expect(map.mixer.lockedBy).toBe('user-3');
    expect(typeof map.mixer.timestamp).toBe('number');
    expect(map.mixer.ttl).toBeGreaterThan(0);
    runtime.stop();
  });

  it('persistiert debounced und ein stop() bricht den ausstehenden Save ab', async () => {
    vi.useFakeTimers();
    try {
      const redis = fakeRedis();
      const runtime = createSessionRuntime();
      runtime.setPersistence({
        load: async () => null,
        save: async (state) => { await redis.set(SESSION_STATE_REDIS_KEY, JSON.stringify(state)); },
      });
      runtime.session.acquireLock('mixer', 'user-1');

      runtime.persist();
      runtime.stop(); // Reset/Shutdown: der ausstehende Save darf nicht mehr laufen
      await vi.advanceTimersByTimeAsync(400);
      expect(redis.set).not.toHaveBeenCalled();

      runtime.persist();
      await vi.advanceTimersByTimeAsync(400);
      expect(redis.set).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('start() ist idempotent und laeuft ohne offene Timer weiter', () => {
    const runtime = createSessionRuntime({ snapshotIntervalMs: 1_000, lockSweepMs: 1_000 });
    runtime.start();
    runtime.start();
    runtime.stop();
    runtime.stop();
    expect(runtime.session.revision).toBe(0);
  });
});
