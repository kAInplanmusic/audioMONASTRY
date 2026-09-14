// P1-2: SnapshotStore — automatische Snapshots mit Checksumme, Retention,
// Restore und trockenem Cleanup. Reiner Kern, deterministisch testbar.
import { describe, it, expect, vi } from 'vitest';
import {
  SnapshotStore,
  createMemoryKeyValueStore,
  fnv1aHex,
} from '../src/core/persistence/snapshotStore';

describe('SnapshotStore: write/list/restore', () => {
  it('schreibt einen Snapshot mit Checksumme und stellt ihn wieder her', async () => {
    const store = new SnapshotStore(createMemoryKeyValueStore(), { now: () => 1700000000000 });
    const written = await store.write({ mixer: { gain: 0.8 } }, 1);
    expect(written.checksum).toBe(fnv1aHex(JSON.stringify({ mixer: { gain: 0.8 } })));

    const restored = await store.restore(written.id);
    expect(restored?.payload).toEqual({ mixer: { gain: 0.8 } });

    const latest = await store.restore('latest');
    expect(latest?.id).toBe(written.id);
  });

  it('erkennt korrupte Payload über die Checksumme', async () => {
    const kv = createMemoryKeyValueStore();
    const store = new SnapshotStore(kv, { now: () => 1700000000000 });
    const written = await store.write({ ok: true }, 1);
    // Payload manipulieren, ohne die Checksumme anzupassen: Datensatz neu bauen.
    const raw = await kv.get(`snapshot:${written.id}`);
    const record = JSON.parse(raw!);
    record.payloadJson = '{"ok":false}';
    await kv.set(`snapshot:${written.id}`, JSON.stringify(record));
    expect(await store.restore(written.id)).toBeNull();
  });

  it('list() sortiert neueste zuerst und ignoriert fremde Keys', async () => {
    const kv = createMemoryKeyValueStore({ 'other:1': '{kaputt', 'snapshot:zz': 'kein json' });
    const store = new SnapshotStore(kv, { now: vi.fn()
      .mockReturnValueOnce(1700000001000)
      .mockReturnValueOnce(1700000002000) });
    await store.write({ a: 1 }, 1);
    await store.write({ a: 2 }, 2);
    const list = await store.list();
    expect(list.map((r) => r.revision)).toEqual([2, 1]);
  });
});

describe('SnapshotStore: Retention/Prune', () => {
  it('behält maxSnapshots und löscht ältere (nie den neuesten)', async () => {
    const kv = createMemoryKeyValueStore();
    let t = 1700000000000;
    const store = new SnapshotStore(kv, { maxSnapshots: 3, maxAgeMs: 0, now: () => t += 1000 });
    const ids: string[] = [];
    for (let i = 1; i <= 5; i += 1) ids.push((await store.write({ rev: i }, i)).id);
    const { deleted, kept } = await store.prune();
    expect(deleted).toHaveLength(2);
    expect(deleted).not.toContain(ids[4]);       // neuester bleibt
    expect(kept).toContain(ids[4]);
    expect(await store.restore(ids[4])).not.toBeNull();
    expect(await store.restore(deleted[0])).toBeNull();
  });

  it('maxAgeMs entfernt alte Snapshots, neuesten behält es immer', async () => {
    const kv = createMemoryKeyValueStore();
    let t = 1700000000000;
    const store = new SnapshotStore(kv, { maxSnapshots: 99, maxAgeMs: 2000, now: () => t += 1000 });
    const ids: string[] = [];
    for (let i = 1; i <= 4; i += 1) ids.push((await store.write({ rev: i }, i)).id);
    // Jahre später: alle außer dem neuesten sind zu alt.
    t = 1800000000000;
    const { deleted } = await store.prune({ now: t });
    expect(deleted).toHaveLength(3);
    expect(deleted).not.toContain(ids[3]);
  });

  it('dryRun löscht nichts, liefert aber dieselbe Löschliste', async () => {
    const kv = createMemoryKeyValueStore();
    let t = 1700000000000;
    const store = new SnapshotStore(kv, { maxSnapshots: 2, maxAgeMs: 0, now: () => t += 1000 });
    const ids: string[] = [];
    for (let i = 1; i <= 4; i += 1) ids.push((await store.write({ rev: i }, i)).id);
    const dry = await store.prune({ dryRun: true });
    expect(dry.deleted).toHaveLength(2);
    for (const id of ids) expect(await store.restore(id)).not.toBeNull(); // nichts gelöscht
    const real = await store.prune();
    expect(real.deleted).toEqual(dry.deleted);
    for (const id of real.deleted) expect(await store.restore(id)).toBeNull();
  });

  it('auch bei korruptem neuesten Record wird der neueste Count-basierte gehalten', async () => {
    const kv = createMemoryKeyValueStore();
    let t = 1700000000000;
    const store = new SnapshotStore(kv, { maxSnapshots: 1, maxAgeMs: 0, now: () => t += 1000 });
    const a = await store.write({ rev: 1 }, 1);
    const b = await store.write({ rev: 2 }, 2);
    // b korrumpieren → der neueste „gültige“ ist a, aber der Datensatz b bleibt der neueste Count-basiert.
    const raw = await kv.get(`snapshot:${b.id}`);
    await kv.set(`snapshot:${b.id}`, raw!.replace('"rev":2', '"rev":99'));
    const { deleted, kept } = await store.prune();
    expect(kept).toContain(b.id);
    expect(deleted).toContain(a.id);
  });
});

describe('SnapshotStore: Default-Checksumme', () => {
  it('fnv1aHex ist stabil und hex-formatig', () => {
    expect(fnv1aHex('abc')).toBe(fnv1aHex('abc'));
    expect(fnv1aHex('abc')).not.toBe(fnv1aHex('abd'));
    expect(fnv1aHex('x')).toMatch(/^fnv-[0-9a-f]{8}$/);
  });
});