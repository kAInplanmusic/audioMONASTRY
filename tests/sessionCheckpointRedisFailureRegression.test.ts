import { describe, expect, it } from 'vitest';
import { createSessionRuntime, SESSION_STATE_REDIS_KEY } from '../server/sessionRuntime';
import { createMemoryKeyValueStore } from '../src/core/persistence/snapshotStore';
import { FileSessionPersistence } from '../server/fileSessionPersistence';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

describe('Checkpoint Redis write failure', () => {
  it('never treats a memory-only checkpoint as a durable success', async () => {
    const runtime = createSessionRuntime({ log: () => {} });
    expect(runtime.session.storeSet('mixer.settings', '"value"', 'user').ok).toBe(true);
    await expect(runtime.checkpoint()).rejects.toThrow(/durab/i);
    runtime.stop();
  });

  it('keeps flush best-effort but logs Redis write errors', async () => {
    const messages: string[] = [];
    const runtime = createSessionRuntime({ log: (message) => messages.push(message) });
    await runtime.restoreFromRedis({ get: async () => null, set: async () => { throw new Error('redis write failed'); } }, createMemoryKeyValueStore());
    await expect(runtime.flush()).resolves.toBeUndefined();
    expect(messages.join('\n')).toContain('redis write failed');
    runtime.stop();
  });

  it('does not treat a successful Redis acknowledgement and readback as crash durability', async () => {
    const values = new Map<string, string>();
    const client = {
      get: async (key: string) => values.get(key) ?? null,
      set: async (key: string, value: string) => { values.set(key, value); return 'OK'; },
    };
    const first = createSessionRuntime({ log: () => {} });
    await first.restoreFromRedis(client, createMemoryKeyValueStore());
    expect(first.session.storeSet('mixer.settings', '"new"', 'user').ok).toBe(true);
    await expect(first.checkpoint()).rejects.toThrow(/durab/i);
    const restarted = createSessionRuntime({ log: () => {} });
    expect((await restarted.restoreFromRedis(client, createMemoryKeyValueStore())).restored).toBe(true);
    expect(restarted.session.storeAll()['mixer.settings']).toBe('"new"');
    first.stop(); restarted.stop();
  });

  it('reports a snapshot write failure after state write; restart uses the new state', async () => {
    const values = new Map<string, string>();
    const client = {
      get: async (key: string) => values.get(key) ?? null,
      set: async (key: string, value: string) => { values.set(key, value); return 'OK'; },
    };
    const kv = createMemoryKeyValueStore();
    const first = createSessionRuntime({ log: () => {} });
    await first.restoreFromRedis(client, { ...kv, set: () => { throw new Error('snapshot failed'); } });
    expect(first.session.storeSet('mixer.settings', '"new"', 'user').ok).toBe(true);
    await expect(first.checkpoint()).rejects.toThrow('snapshot failed');
    const restarted = createSessionRuntime({ log: () => {} });
    expect((await restarted.restoreFromRedis(client, createMemoryKeyValueStore())).restored).toBe(true);
    expect(restarted.session.storeAll()['mixer.settings']).toBe('"new"');
    first.stop(); restarted.stop();
  });

  it('does not claim file durability from a memory snapshot even when a new runtime can read the file', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'session-checkpoint-'));
    try {
      const file = path.join(dir, 'state.json');
      const first = createSessionRuntime({ log: () => {} });
      await first.restoreFromPersistence(new FileSessionPersistence(file));
      expect(first.session.storeSet('mixer.settings', '"new"', 'user').ok).toBe(true);
      await expect(first.checkpoint()).rejects.toThrow(/durab/i);
      const restarted = createSessionRuntime({ log: () => {} });
      expect((await restarted.restoreFromPersistence(new FileSessionPersistence(file))).restored).toBe(true);
      expect(restarted.session.storeAll()['mixer.settings']).toBe('"new"');
      first.stop(); restarted.stop();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('rejects instead of confirming a RAM snapshot when the state write fails and restart would load the old state', async () => {
    const values = new Map<string, string>();
    let failWrites = false;
    const client = {
      get: async (key: string) => values.get(key) ?? null,
      set: async (key: string, value: string) => {
        if (failWrites) throw new Error('redis write failed');
        values.set(key, value);
        return 'OK';
      },
    };
    const first = createSessionRuntime({ log: () => {} });
    await first.restoreFromRedis(client, createMemoryKeyValueStore());
    expect(first.session.storeSet('mixer.settings', '"old"', 'user').ok).toBe(true);
    await first.flush();
    const old = values.get(SESSION_STATE_REDIS_KEY);
    const revision = first.session.revision;
    expect(first.session.storeSet('mixer.settings', '"new"', 'user').ok).toBe(true);
    expect(first.session.revision).toBe(revision);
    failWrites = true;

    await expect(first.checkpoint()).rejects.toThrow('redis write failed');
    expect(values.get(SESSION_STATE_REDIS_KEY)).toBe(old);
    const restarted = createSessionRuntime({ log: () => {} });
    expect((await restarted.restoreFromRedis(client, createMemoryKeyValueStore())).restored).toBe(true);
    expect(restarted.session.serialize()).toEqual(JSON.parse(old!));
    expect(restarted.session.serialize()).not.toEqual(first.session.serialize());
    first.stop(); restarted.stop();
  });
});
