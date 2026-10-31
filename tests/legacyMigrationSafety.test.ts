import { afterEach, describe, expect, it, vi } from 'vitest';

const rtc = vi.hoisted(() => ({
  onSessionState: vi.fn(),
  onStoreUpdate: vi.fn(),
  sendStoreSet: vi.fn(),
  sendStoreRemove: vi.fn(),
}));
vi.mock('../src/utils/WebRTCManager', () => ({ webRTCManager: rtc }));

function makeStorage(initial: Record<string, string>): Storage {
  const data = new Map(Object.entries(initial));
  return {
    get length() { return data.size; },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => { data.delete(key); },
    setItem: (key, value) => { data.set(key, value); },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.clearAllMocks();
});

describe('sichere Migration alter Gerätedaten', () => {
  it('bietet keine unbestätigte pauschale Löschung von OPFS und IndexedDB an', async () => {
    const idb = await import('../src/utils/indexedDB');
    const opfs = await import('../src/utils/opfs');
    expect('deleteDeviceDatabases' in idb).toBe(false);
    expect('purgeDeviceFiles' in opfs).toBe(false);
  });

  it('liest localStorage ohne jegliche Daten zu löschen', async () => {
    const local = makeStorage({ preset: 'legacy', audiomonastry_local_presets: 'personal' });
    const session = makeStorage({ other: 'keep' });
    vi.stubGlobal('localStorage', local);
    vi.stubGlobal('sessionStorage', session);
    const { takeLegacyLocalStorage } = await import('../src/utils/storage');
    expect(takeLegacyLocalStorage()).toEqual({ preset: 'legacy' });
    expect(local.getItem('preset')).toBe('legacy');
    expect(local.getItem('audiomonastry_local_presets')).toBe('personal');
    expect(session.getItem('other')).toBe('keep');
  });

  it('liest IndexedDB ohne Datenbanken zu löschen', async () => {
    const deleteDatabase = vi.fn();
    const db = {
      objectStoreNames: { contains: (name: string) => name === 'kv' || name === 'scratchpad' },
      transaction: (name: string) => ({ objectStore: () => ({ getAll: () => {
        const req: { result: unknown[]; onsuccess?: () => void } = {
          result: name === 'kv' ? [{ key: 'preset', value: { saved: true } }] : ['memo'],
        };
        queueMicrotask(() => req.onsuccess?.());
        return req;
      } }) }),
      close: vi.fn(),
    };
    vi.stubGlobal('indexedDB', {
      databases: async () => [{ name: 'AudioMonastryDB' }, { name: 'other' }],
      open: () => {
        const req: { result: typeof db; onsuccess?: () => void } = { result: db };
        queueMicrotask(() => req.onsuccess?.());
        return req;
      },
      deleteDatabase,
    });
    const { takeLegacyIndexedDb } = await import('../src/utils/indexedDB');
    expect(await takeLegacyIndexedDb()).toEqual({ kv: { preset: { saved: true } }, scratchpad: ['memo'] });
    expect(db.close).toHaveBeenCalledOnce();
    expect(deleteDatabase).not.toHaveBeenCalled();
  });

  it.each([
    ['erfolgreichem Vorladen', async () => ({ ok: true, json: async () => ({ entries: { preset: '"server"' } }) })],
    ['HTTP-Fehler', async () => ({ ok: false })],
  ])('bewahrt Altbestände auch bei %s und überschreibt den Server nicht', async (_label, fetchResult) => {
    const local = makeStorage({ preset: 'legacy' });
    const session = makeStorage({ other: 'keep' });
    const deleteDatabase = vi.fn();
    const removeEntry = vi.fn();
    vi.stubGlobal('localStorage', local);
    vi.stubGlobal('sessionStorage', session);
    vi.stubGlobal('indexedDB', { databases: async () => [{ name: 'other' }], deleteDatabase });
    vi.stubGlobal('navigator', { storage: { getDirectory: async () => ({
      async *entries() { yield ['audio', {}]; }, removeEntry,
    }) } });
    vi.stubGlobal('fetch', vi.fn(fetchResult));

    const { startStudioStoreSync } = await import('../src/utils/studioStoreSync');
    await startStudioStoreSync();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const joined = rtc.onSessionState.mock.calls[0]?.[0] as (() => void) | undefined;
    joined?.();
    expect(local.getItem('preset')).toBe('legacy');
    expect(session.getItem('other')).toBe('keep');
    expect(deleteDatabase).not.toHaveBeenCalled();
    expect(removeEntry).not.toHaveBeenCalled();
    expect(rtc.sendStoreSet).not.toHaveBeenCalled();
  });

  it('bewahrt alle Gerätedaten und sendet nichts bei fehlendem Server', async () => {
    const local = makeStorage({ preset: 'legacy', 'third-party': 'keep' });
    const session = makeStorage({ 'session-other': 'keep' });
    const deleteDatabase = vi.fn();
    const removeEntry = vi.fn();
    vi.stubGlobal('localStorage', local);
    vi.stubGlobal('sessionStorage', session);
    vi.stubGlobal('indexedDB', { databases: async () => [{ name: 'unrelated' }], deleteDatabase });
    vi.stubGlobal('navigator', { storage: { getDirectory: async () => ({
      async *entries() { yield ['legacy-audio', {}]; }, removeEntry,
    }) } });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));

    const { startStudioStoreSync } = await import('../src/utils/studioStoreSync');
    await startStudioStoreSync();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const joined = rtc.onSessionState.mock.calls[0]?.[0] as (() => void) | undefined;
    joined?.();

    expect(local.getItem('preset')).toBe('legacy');
    expect(local.getItem('third-party')).toBe('keep');
    expect(session.getItem('session-other')).toBe('keep');
    expect(deleteDatabase).not.toHaveBeenCalled();
    expect(removeEntry).not.toHaveBeenCalled();
    expect(rtc.sendStoreSet).not.toHaveBeenCalled();
  });
});
