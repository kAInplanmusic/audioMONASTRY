/**
 * AUDIT-2026-10-30-P0-002 · Legacy-Migration
 * ==========================================
 * Belegte Luecken vor dem Fix:
 *  - Preload-Fehler/Timeout wurde stumm verschluckt, danach galt
 *    `storageGet(key) === null` fuer ALLE Keys -> Altwerte ueberschrieben die
 *    Server-Wahrheit (storeSet ist serverseitig Last-Write-Wins).
 *  - localStorage wurde sofort geleert, geschrieben wurde aber erst nach dem
 *    Session-Join -> Reload vor dem Join = Altbestand weg und nie angekommen.
 *  - IndexedDB/OPFS wurden unabhaengig vom Erfolg geloescht.
 *  - Nutzer-Presets waren memory-only: von der Migration ausgeschlossen UND
 *    geloescht.
 *
 * Diese Datei prueft das Verhalten aus Sicht des Geraets (localStorage) und des
 * Servers (In-Memory-Studio-Store, der nur durch `store-set` waechst).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const state: {
    onSession?: () => void;
    onUpdate?: (msg: unknown) => void;
    purge: ReturnType<typeof vi.fn>;
  } = { purge: vi.fn(async () => 0) };
  const wrtc = {
    onSessionState: (cb: () => void) => {
      state.onSession = cb;
      return () => { state.onSession = undefined; };
    },
    onStoreUpdate: (cb: (msg: unknown) => void) => {
      state.onUpdate = cb;
      return () => { state.onUpdate = undefined; };
    },
    sendStoreSet: vi.fn(),
    sendStoreRemove: vi.fn(),
  };
  return { state, wrtc };
});

vi.mock('../src/utils/WebRTCManager', () => ({ webRTCManager: h.wrtc }));
vi.mock('../src/utils/opfs', () => ({ purgeDeviceFiles: h.state.purge }));

import {
  LEGACY_MIGRATION_VERSION,
  isMemoryOnlyKey,
  resetStorageForTests,
  storageGet,
} from '../src/utils/storage';
import {
  LEGACY_MIGRATION_LEDGER_KEY,
  preloadStudioStore,
  resetStudioStoreSyncForTests,
  startStudioStoreSync,
} from '../src/utils/studioStoreSync';

const K = 'audiomonastry_autoload';
const PRESETS = 'audiomonastry_local_presets';

/** Server-Wahrheit: waechst nur durch store-set (Last-Write-Wins wie server storeSet). */
let serverStore: Map<string, string>;

function installServer(): void {
  serverStore = new Map();
  globalThis.fetch = vi.fn(async () => {
    return {
      ok: true,
      status: 200,
      json: async () => ({ status: 'ok', entries: Object.fromEntries(serverStore) }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  h.wrtc.sendStoreSet.mockImplementation((key: string, value: string) => {
    serverStore.set(key, value);
  });
  h.wrtc.sendStoreRemove.mockImplementation((key: string) => {
    serverStore.delete(key);
  });
}

function failFetch(message = 'netz weg'): void {
  globalThis.fetch = vi.fn(async () => { throw new Error(message); }) as unknown as typeof fetch;
}

/** Fetch, der erst beim Abort-Signal aufgibt (2,5-s-Timeout-Pfad). */
function hangingFetch(): void {
  globalThis.fetch = vi.fn((_url: string, init?: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
  })) as unknown as typeof fetch;
}

async function settle(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await new Promise((r) => setTimeout(r, 0));
}

/** Migrationsmarker (Server): { version, delivered } unter LEGACY_MIGRATION_LEDGER_KEY. */
function ledger(): { version: number; delivered: string[] } | null {
  // Studio-Speicher transportiert Werte als JSON-Text -> einmal transportiert,
  // einmal Nutzinhalt.
  const raw = serverStore.get(LEGACY_MIGRATION_LEDGER_KEY);
  return raw ? (JSON.parse(JSON.parse(raw) as string) as { version: number; delivered: string[] }) : null;
}

async function joinSession(): Promise<void> {
  h.state.onSession?.();
  await settle();
}

beforeEach(() => {
  resetStudioStoreSyncForTests();
  resetStorageForTests();
  localStorage.clear();
  globalThis.sessionStorage?.clear();
  (h.state.purge as ReturnType<typeof vi.fn>).mockClear();
  h.wrtc.sendStoreSet.mockReset();
  h.wrtc.sendStoreRemove.mockReset();
  h.state.onSession = undefined;
  h.state.onUpdate = undefined;
  Object.defineProperty(globalThis, 'indexedDB', { value: undefined, configurable: true });
  installServer();
});

afterEach(() => {
  resetStudioStoreSyncForTests();
  vi.restoreAllMocks();
});

describe('P0-002 · Preload-Ergebnis: bestaetigt vs. nicht erreichbar', () => {
  it('bestaetigt: migriert Altbestand, aber erst nach Join + Server-ACK', async () => {
    localStorage.setItem(K, 'song-1');

    await startStudioStoreSync(200);
    await settle();

    // Noch kein Join: nichts geschrieben, nichts geloescht.
    expect(h.wrtc.sendStoreSet).not.toHaveBeenCalled();
    expect(serverStore.size).toBe(0);
    expect(localStorage.getItem(K)).toBe('song-1');
    expect(storageGet(K)).toBe('song-1');

    await joinSession();

    expect(serverStore.get(K)).toBe(JSON.stringify('song-1'));
    expect(localStorage.getItem(K)).toBeNull();
    expect(localStorage.length).toBe(0); // kein Geraete-Marker: „nichts auf dem Geraet"
    expect(ledger()).toEqual({ version: LEGACY_MIGRATION_VERSION, delivered: [K] });
    expect(h.state.purge).toHaveBeenCalled();
  });

  it('Preload scheitert (Netz): NICHT migrieren, Altdaten bleiben liegen', async () => {
    localStorage.setItem(K, 'song-1');
    failFetch();

    await startStudioStoreSync(200);
    await settle();
    await joinSession();

    expect(h.wrtc.sendStoreSet).not.toHaveBeenCalled();
    expect(serverStore.has(K)).toBe(false);
    expect(localStorage.getItem(K)).toBe('song-1');
    expect(ledger()).toBeNull();
    expect(h.state.purge).not.toHaveBeenCalled();
  });

  it('Preload-Timeout: NICHT migrieren, Altdaten bleiben liegen', async () => {
    localStorage.setItem(K, 'song-1');
    hangingFetch();

    await startStudioStoreSync(20);
    await settle();
    await joinSession();

    expect(h.wrtc.sendStoreSet).not.toHaveBeenCalled();
    expect(localStorage.getItem(K)).toBe('song-1');
    expect(h.state.purge).not.toHaveBeenCalled();
  });

  it('Preload antwortet 500: NICHT migrieren', async () => {
    localStorage.setItem(K, 'song-1');
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) } as unknown as Response)) as unknown as typeof fetch;

    await startStudioStoreSync(200);
    await settle();
    await joinSession();

    expect(h.wrtc.sendStoreSet).not.toHaveBeenCalled();
    expect(localStorage.getItem(K)).toBe('song-1');
  });

  it('Retry beim naechsten Start nach gescheitertem Preload', async () => {
    localStorage.setItem(K, 'song-1');
    failFetch();
    await startStudioStoreSync(200);
    await settle();
    expect(localStorage.getItem(K)).toBe('song-1');

    // "Naechster Start": Server erreichbar, Altdaten unveraendert vorhanden.
    resetStudioStoreSyncForTests();
    resetStorageForTests();
    installServer();
    await startStudioStoreSync(200);
    await settle();
    await joinSession();

    expect(serverStore.get(K)).toBe(JSON.stringify('song-1'));
    expect(localStorage.getItem(K)).toBeNull();
  });

  it('preloadStudioStore klassifiziert 200 ohne entries-Objekt als nicht erreichbar', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ status: 'ok' }) } as unknown as Response)) as unknown as typeof fetch;
    await expect(preloadStudioStore(200)).resolves.toMatchObject({ status: 'unreachable' });
  });
});

describe('P0-002 · Server-Wahrheit gewinnt', () => {
  it('Server hat den Key bereits: lokaler Altbestand ueberschreibt ihn nicht', async () => {
    serverStore.set(K, JSON.stringify('server-neu'));
    localStorage.setItem(K, 'geraet-alt');
    localStorage.setItem('audiomonastry_master_gain', 'geraet-gain');

    await startStudioStoreSync(200);
    await settle();

    expect(storageGet(K)).toBe('server-neu');
    await joinSession();

    expect(serverStore.get(K)).toBe(JSON.stringify('server-neu'));
    expect(serverStore.get('audiomonastry_master_gain')).toBe(JSON.stringify('geraet-gain'));
    expect(localStorage.getItem(K)).toBeNull();
    expect(localStorage.getItem('audiomonastry_master_gain')).toBeNull();
  });

  it('Schluessel mit nicht dekodierbarem Serverwert gelten als vorhanden (Server gewinnt)', async () => {
    serverStore.set(K, '42'); // JSON-Zahl, kein String
    localStorage.setItem(K, 'geraet-alt');

    await startStudioStoreSync(200);
    await settle();
    await joinSession();

    expect(serverStore.get(K)).toBe('42');
    expect(localStorage.getItem(K)).toBeNull();
  });
});

describe('P0-002 · Reload vor dem Join', () => {
  it('loescht nichts, solange der Server den Bestand nicht bestaetigt hat', async () => {
    localStorage.setItem(K, 'song-1');

    await startStudioStoreSync(200);
    await settle();

    expect(localStorage.getItem(K)).toBe('song-1');
    expect(h.wrtc.sendStoreSet).not.toHaveBeenCalled();

    // Reload: Modul- und Arbeitsspeicher weg, localStorage bleibt.
    resetStudioStoreSyncForTests();
    resetStorageForTests();

    await startStudioStoreSync(200);
    await settle();
    await joinSession();

    expect(serverStore.get(K)).toBe(JSON.stringify('song-1'));
    expect(localStorage.getItem(K)).toBeNull();
  });

  it('Join ohne Server-ACK (Read-back scheitert): keine Loeschung, spaeterer Join holt es nach', async () => {
    localStorage.setItem(K, 'song-1');

    let n = 0;
    globalThis.fetch = vi.fn(async () => {
      n += 1;
      if (n === 1) {
        return { ok: true, status: 200, json: async () => ({ status: 'ok', entries: {} }) } as unknown as Response;
      }
      throw new Error('bestaetigung weg');
    }) as unknown as typeof fetch;

    await startStudioStoreSync(200);
    await settle();
    await joinSession();

    // Wert ging raus (store-set), aber der Server hat ihn nicht bestaetigt.
    expect(serverStore.get(K)).toBe(JSON.stringify('song-1'));
    expect(localStorage.getItem(K)).toBe('song-1');
    expect(ledger()).toBeNull();
    expect(h.state.purge).not.toHaveBeenCalled();

    // Naechster Join: Server antwortet wieder -> jetzt darf geloescht werden.
    installServer();
    serverStore.set(K, JSON.stringify('song-1'));
    await joinSession();

    expect(localStorage.getItem(K)).toBeNull();
    expect(ledger()).toEqual({ version: LEGACY_MIGRATION_VERSION, delivered: [K] });
  });
});

describe('P0-002 · ACK-Reihenfolge Socket/HTTP', () => {
  it('Nachversuch bestaetigt spaeter und loescht erst dann', async () => {
    localStorage.setItem(K, 'song-1');

    let acknowledgements = 0;
    globalThis.fetch = vi.fn(async () => {
      // Erster Aufruf = Preload (leer), danach ACK: der erste ACK kommt zu
      // frueh (store-set noch nicht verarbeitet), der zweite sieht den Wert.
      if (h.wrtc.sendStoreSet.mock.calls.length === 0) {
        return { ok: true, status: 200, json: async () => ({ status: 'ok', entries: {} }) } as unknown as Response;
      }
      acknowledgements += 1;
      const entries = acknowledgements >= 2 ? Object.fromEntries(serverStore) : {};
      return { ok: true, status: 200, json: async () => ({ status: 'ok', entries }) } as unknown as Response;
    }) as unknown as typeof fetch;

    await startStudioStoreSync(200);
    await settle();
    await joinSession();

    // Erster ACK zu frueh: noch nichts geloescht.
    expect(localStorage.getItem(K)).toBe('song-1');
    expect(acknowledgements).toBeGreaterThanOrEqual(1);

    // Nachversuch (500 ms) bestaetigt -> Loeschung.
    await new Promise((r) => setTimeout(r, 750));
    await settle();

    expect(localStorage.getItem(K)).toBeNull();
    expect(ledger()?.delivered).toEqual([K]);
  });
});

describe('P0-002 · Migrationsmarker', () => {
  it('markiertes Geraet migriert nicht erneut (kein Rueck-Ueberschreiben des Servers)', async () => {
    serverStore.set(LEGACY_MIGRATION_LEDGER_KEY, JSON.stringify(JSON.stringify({
      version: LEGACY_MIGRATION_VERSION,
      delivered: [K],
    })));
    localStorage.setItem(K, 'rest-von-frueher');

    await startStudioStoreSync(200);
    await settle();
    await joinSession();

    expect(h.wrtc.sendStoreSet).not.toHaveBeenCalled();
    expect(serverStore.size).toBe(1); // nur der Marker selbst
    expect(localStorage.getItem(K)).toBeNull();
  });
});

describe('P0-002 · Presets', () => {
  it('Preset-Schluessel sind Server-Keys (nicht mehr memory-only)', () => {
    expect(isMemoryOnlyKey(PRESETS)).toBe(false);
  });

  it('alte Geraete-Presets wandern in den Server-Store und bleiben nutzbar', async () => {
    const presets = [{ id: 'p1', name: 'Alt-Preset', presetData: { gain: 3 } }];
    localStorage.setItem(PRESETS, JSON.stringify(presets));

    await startStudioStoreSync(200);
    await settle();
    await joinSession();

    expect(serverStore.get(PRESETS)).toBe(JSON.stringify(JSON.stringify(presets)));
    expect(localStorage.getItem(PRESETS)).toBeNull();

    const { fetchPresetsFromCloud } = await import('../src/utils/presetStore');
    const loaded = await fetchPresetsFromCloud();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].name).toBe('Alt-Preset');
  });

  it('Server-Presets gewinnen gegen alte Geraete-Presets', async () => {
    serverStore.set(PRESETS, JSON.stringify(JSON.stringify([{ id: 'p2', name: 'Server-Preset', presetData: { gain: 1 } }])));
    localStorage.setItem(PRESETS, JSON.stringify([{ id: 'p1', name: 'Alt-Preset', presetData: { gain: 3 } }]));

    await startStudioStoreSync(200);
    await settle();
    await joinSession();

    const { fetchPresetsFromCloud } = await import('../src/utils/presetStore');
    const loaded = await fetchPresetsFromCloud();
    expect(loaded.map((p) => p.name)).toEqual(['Server-Preset']);
    expect(localStorage.getItem(PRESETS)).toBeNull();
  });
});

describe('P0-002 · memory-only Altlasten', () => {
  it('werden nie an den Server geschrieben, aber nach Bestaetigung vom Geraet entfernt', async () => {
    localStorage.setItem('moa-log-eq', '["zeile"]');
    localStorage.setItem(K, 'song-1');

    await startStudioStoreSync(200);
    await settle();
    await joinSession();

    expect(serverStore.has('moa-log-eq')).toBe(false);
    expect(storageGet('moa-log-eq')).toBe('["zeile"]');
    expect(localStorage.getItem('moa-log-eq')).toBeNull();
  });
});
