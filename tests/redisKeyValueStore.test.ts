import { describe, expect, it } from 'vitest';
import { createRedisKeyValueStore, normalizeRedisKvPrefix, type RedisLikeClient } from '../src/core/persistence/redisKeyValueStore';
import { SnapshotStore } from '../src/core/persistence/snapshotStore';

/**
 * PERSIST-P1-003: Der SnapshotStore lag immer auf `createMemoryKeyValueStore()`
 * - ein Prozess-Neustart verlor die Session. Geprueft wird der Redis-Adapter
 * (Vertrag, Praefix, Fremdschluessel) und der eigentliche Zweck: ein ZWEITER
 * Store ueber DEMSELBEN Client (= neuer Prozess, gleiche Redis-DB) findet die
 * Snapshots wieder.
 */

/** Minimaler Redis-Ersatz mit echtem Key-Value-Verhalten (kein Cache im Adapter). */
function fakeRedis(): RedisLikeClient & { raw: Map<string, string> } {
  const raw = new Map<string, string>();
  return {
    raw,
    get: (key: string) => (raw.has(key) ? (raw.get(key) as string) : null),
    set: (key: string, value: string) => {
      raw.set(key, value);
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
}

describe('PERSIST-P1-003 · Redis-Key-Value-Adapter', () => {
  it('normalisiert das Praefix', () => {
    expect(normalizeRedisKvPrefix()).toBe('audiomonastry:kv:');
    expect(normalizeRedisKvPrefix('custom')).toBe('custom:');
    expect(normalizeRedisKvPrefix('custom:')).toBe('custom:');
    expect(normalizeRedisKvPrefix('')).toBe('');
  });

  it('schreibt mit Praefix und liest ohne Praefix-Wissen', async () => {
    const client = fakeRedis();
    const kv = createRedisKeyValueStore(client);
    await kv.set('snapshot:abc', 'inhalt');
    expect(client.raw.has('audiomonastry:kv:snapshot:abc')).toBe(true);
    expect(await kv.get('snapshot:abc')).toBe('inhalt');
    expect(await kv.get('fehlt')).toBeNull();
    expect(await kv.keys()).toEqual(['snapshot:abc']);
    await kv.remove('snapshot:abc');
    expect(await kv.get('snapshot:abc')).toBeNull();
    expect(await kv.keys()).toEqual([]);
  });

  it('liefert nur eigene Schluessel und wirft bei kaputtem Client-Ergebnis nicht', async () => {
    const client = fakeRedis();
    client.raw.set('fremd:key', 'x');
    client.raw.set('audiomonastry:kv:a', '1');
    client.raw.set('audiomonastry:kv:b', '2');
    const kv = createRedisKeyValueStore(client);
    expect((await kv.keys()).sort()).toEqual(['a', 'b']);

    const broken = { ...fakeRedis(), get: () => ({ kein: 'string' }), keys: () => null } as unknown as RedisLikeClient;
    const kv2 = createRedisKeyValueStore(broken);
    expect(await kv2.get('a')).toBeNull();
    expect(await kv2.keys()).toEqual([]);
  });

  it('unterstuetzt ein leeres Praefix (dedizierte Redis-DB)', async () => {
    const client = fakeRedis();
    const kv = createRedisKeyValueStore(client, { prefix: '' });
    await kv.set('snapshot:1', 'x');
    expect(client.raw.has('snapshot:1')).toBe(true);
    expect(await kv.keys()).toEqual(['snapshot:1']);
  });
});

describe('PERSIST-P1-003 · Prozess-Neustart verliert keine Session', () => {
  const payload = { revision: 4242, moduleStates: { mixer: 'AUTO_AI' }, locks: [] };
  const checksum = (input: string) => `sum-${input.length}`;

  it('zweiter Store (neuer Prozess) findet den Snapshot des ersten', async () => {
    const client = fakeRedis();

    // Prozess 1: schreibt einen Snapshot.
    const processOne = new SnapshotStore<typeof payload>(createRedisKeyValueStore(client), { now: () => 1_700_000_000_000, checksum });
    const written = await processOne.write(payload, 4242);
    expect(await processOne.restore('latest')).toMatchObject({ id: written.id, revision: 4242 });

    // Prozess 2: frischer Store, derselbe Redis-Inhalt (kein gemeinsamer Speicher).
    const processTwo = new SnapshotStore<typeof payload>(createRedisKeyValueStore(client), { now: () => 1_700_000_999_000, checksum });
    const restored = await processTwo.restore('latest');
    expect(restored?.payload).toEqual(payload);
    expect(restored?.revision).toBe(4242);
    expect(restored?.checksum).toBe(checksum(JSON.stringify(payload)));
    // Retention arbeitet auch prozessuebergreifend.
    const pruned = await processTwo.prune();
    expect(pruned.kept).toContain(written.id);
  });

  it('verwirft einen manipulierten Snapshot (Checksumme)', async () => {
    const client = fakeRedis();
    const store = new SnapshotStore<typeof payload>(createRedisKeyValueStore(client), { now: () => 1, checksum });
    await store.write(payload, 1);

    // Angreifer/Fehler aendert die Payload, ohne die Checksumme zu erneuern.
    const [key] = [...client.raw.keys()];
    const record = JSON.parse(client.raw.get(key) as string);
    record.payloadJson = JSON.stringify({ revision: 999, moduleStates: {}, locks: [] });
    client.raw.set(key, JSON.stringify(record));

    expect(await store.restore('latest')).toBeNull();
  });

  it('verliert ohne Redis (In-Memory-Fallback) alles - der Unterschied ist echt', async () => {
    const { createMemoryKeyValueStore } = await import('../src/core/persistence/snapshotStore');
    const processOne = new SnapshotStore<typeof payload>(createMemoryKeyValueStore(), { now: () => 1, checksum });
    await processOne.write(payload, 7);
    // "Neustart": frischer In-Memory-Store = leerer Speicher.
    const processTwo = new SnapshotStore<typeof payload>(createMemoryKeyValueStore(), { now: () => 2, checksum });
    expect(await processTwo.restore('latest')).toBeNull();
  });
});
