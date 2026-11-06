/**
 * AUDIT-2026-10-30-P0-002 · ehemaliger IndexedDB-Bestand
 * ====================================================
 * Vor dem Fix: `takeLegacyIndexedDb` gab im catch still `{kv:{}}` zurueck und
 * loeschte die Datenbank im finally – also auch nach einem gescheiterten Read.
 * `deleteDeviceDatabases()` loeschte ALLE Datenbanken der Origin statt nur
 * AudioMonastryDB.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const state: { onSession?: () => void; purge: ReturnType<typeof vi.fn> } = {
    purge: vi.fn(async () => 0),
  };
  const wrtc = {
    onSessionState: (cb: () => void) => {
      state.onSession = cb;
      return () => { state.onSession = undefined; };
    },
    onStoreUpdate: () => () => undefined,
    sendStoreSet: vi.fn(),
    sendStoreRemove: vi.fn(),
  };
  return { state, wrtc };
});

vi.mock('../src/utils/WebRTCManager', () => ({ webRTCManager: h.wrtc }));
vi.mock('../src/utils/opfs', () => ({ purgeDeviceFiles: h.state.purge }));

import {
  LEGACY_DATABASE_NAME,
  deleteLegacyIndexedDb,
  readLegacyIndexedDb,
} from '../src/utils/indexedDB';
import { resetStorageForTests, storageGet } from '../src/utils/storage';
import { resetStudioStoreSyncForTests, startStudioStoreSync } from '../src/utils/studioStoreSync';

type FakeData = Record<string, { kv: unknown[]; scratchpad: unknown[] }>;

function fakeIndexedDb(opts: { names?: string[]; data?: FakeData; failOpen?: boolean; failRead?: boolean } = {}) {
  const deleted: string[] = [];
  const names = opts.names ?? [];
  const data = opts.data ?? {};
  return {
    deleted,
    databases: async () => names.map((name) => ({ name, version: 1 })),
    open: (name: string) => {
      const req: Record<string, unknown> = {};
      queueMicrotask(() => {
        if (opts.failOpen) {
          req.error = new Error('open kaputt');
          (req.onerror as (() => void) | undefined)?.();
          return;
        }
        const entry = data[name] ?? { kv: [], scratchpad: [] };
        req.result = {
          objectStoreNames: { contains: (s: string) => s === 'kv' || s === 'scratchpad' },
          transaction: () => ({
            objectStore: (store: string) => ({
              getAll: () => {
                const r: Record<string, unknown> = {};
                queueMicrotask(() => {
                  if (opts.failRead) {
                    r.error = new Error('read kaputt');
                    (r.onerror as (() => void) | undefined)?.();
                    return;
                  }
                  r.result = store === 'kv' ? entry.kv : entry.scratchpad;
                  (r.onsuccess as (() => void) | undefined)?.();
                });
                return r;
              },
            }),
          }),
          close: () => undefined,
        };
        (req.onsuccess as (() => void) | undefined)?.();
      });
      return req;
    },
    deleteDatabase: (name: string) => {
      deleted.push(name);
      const req: Record<string, unknown> = {};
      queueMicrotask(() => (req.onsuccess as (() => void) | undefined)?.());
      return req;
    },
  };
}

function installDb(db: unknown): void {
  Object.defineProperty(globalThis, 'indexedDB', { value: db, configurable: true });
}

async function settle(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  resetStudioStoreSyncForTests();
  resetStorageForTests();
  localStorage.clear();
  (h.state.purge as ReturnType<typeof vi.fn>).mockClear();
  h.wrtc.sendStoreSet.mockReset();
  h.state.onSession = undefined;
  Object.defineProperty(globalThis, 'indexedDB', { value: undefined, configurable: true });
});

describe('P0-002 · Legacy-IndexedDB lesen', () => {
  it('liest kv + scratchpad und loescht die Datenbank NICHT beim Lesen', async () => {
    const db = fakeIndexedDb({
      names: [LEGACY_DATABASE_NAME],
      data: { [LEGACY_DATABASE_NAME]: { kv: [{ key: 'alt', value: { a: 1 } }], scratchpad: [{ x: 1 }] } },
    });
    installDb(db);

    const read = await readLegacyIndexedDb();

    expect(read.ok).toBe(true);
    expect(read.exists).toBe(true);
    expect(read.kv).toEqual({ alt: { a: 1 } });
    expect(read.scratchpad).toEqual([{ x: 1 }]);
    expect(db.deleted).toEqual([]);
  });

  it('Open-Fehler: ok=false und keine Loeschung', async () => {
    const db = fakeIndexedDb({ names: [LEGACY_DATABASE_NAME], failOpen: true });
    installDb(db);

    const read = await readLegacyIndexedDb();

    expect(read.ok).toBe(false);
    expect(read.kv).toEqual({});
    expect(db.deleted).toEqual([]);
  });

  it('Read-Fehler: ok=false und keine Loeschung', async () => {
    const db = fakeIndexedDb({ names: [LEGACY_DATABASE_NAME], failRead: true });
    installDb(db);

    const read = await readLegacyIndexedDb();

    expect(read.ok).toBe(false);
    expect(db.deleted).toEqual([]);
  });

  it('Datenbank existiert nicht: exists=false', async () => {
    const db = fakeIndexedDb({ names: ['AndereAppDB'] });
    installDb(db);

    const read = await readLegacyIndexedDb();

    expect(read).toMatchObject({ ok: true, exists: false });
    expect(db.deleted).toEqual([]);
  });
});

describe('P0-002 · Loeschung nur AudioMonastryDB', () => {
  it('deleteLegacyIndexedDb laesst fremde Datenbanken der Origin stehen', async () => {
    const db = fakeIndexedDb({ names: [LEGACY_DATABASE_NAME, 'AndereAppDB'] });
    installDb(db);

    await deleteLegacyIndexedDb();

    expect(db.deleted).toEqual([LEGACY_DATABASE_NAME]);
  });
});

describe('P0-002 · IndexedDB-Migration im Startpfad', () => {
  function installServer(entries: Record<string, string> = {}): { store: Map<string, string>; sets: string[] } {
    const store = new Map<string, string>(Object.entries(entries));
    const sets: string[] = [];
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ status: 'ok', entries: Object.fromEntries(store) }),
    } as unknown as Response)) as unknown as typeof fetch;
    h.wrtc.sendStoreSet.mockImplementation((key: string, value: string) => {
      sets.push(key);
      store.set(key, value);
    });
    return { store, sets };
  }

  it('uebernimmt kv erst nach Join-Bestaetigung und loescht dann nur AudioMonastryDB', async () => {
    const server = installServer();
    const db = fakeIndexedDb({
      names: [LEGACY_DATABASE_NAME, 'AndereAppDB'],
      data: { [LEGACY_DATABASE_NAME]: { kv: [{ key: 'audiomonastry_mix', value: { gain: 2 } }], scratchpad: [{ s: 1 }] } },
    });
    installDb(db);

    await startStudioStoreSync(200);
    await settle();

    expect(db.deleted).toEqual([]);
    expect(storageGet('audiomonastry_mix')).toBe(JSON.stringify({ gain: 2 }));

    h.state.onSession?.();
    await settle();

    expect(server.sets).toContain('audiomonastry_mix');
    expect(server.sets).toContain('audiomonastry_scratchpad');
    expect(db.deleted).toEqual([LEGACY_DATABASE_NAME]);
  });

  it('Preload scheitert: IndexedDB wird weder uebernommen noch geloescht', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('netz weg'); }) as unknown as typeof fetch;
    const db = fakeIndexedDb({
      names: [LEGACY_DATABASE_NAME],
      data: { [LEGACY_DATABASE_NAME]: { kv: [{ key: 'audiomonastry_mix', value: { gain: 2 } }], scratchpad: [] } },
    });
    installDb(db);

    await startStudioStoreSync(200);
    await settle();
    h.state.onSession?.();
    await settle();

    expect(h.wrtc.sendStoreSet).not.toHaveBeenCalled();
    expect(storageGet('audiomonastry_mix')).toBeNull();
    expect(db.deleted).toEqual([]);
  });
});
