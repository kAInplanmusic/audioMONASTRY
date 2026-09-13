/**
 * audioMONASTRY · Persistenz – Browser-Adapter (PERSIST-P1-002)
 * ===========================================================
 * Bindet den reinen Autosave-Kern an die vorhandene IndexedDB-Schicht
 * (`largeGetJson`/`largeSetJson`). Fehlt IndexedDB (SSR, Test, blockierter
 * Storage), fällt es EHRLICH auf den In-Memory-Store zurück: der Autosave
 * funktioniert, der Stand überlebt aber keinen Reload (`kind` macht das sichtbar).
 */
import { largeDelete, largeGetJson, largeSetJson } from '../../utils/indexedDB';
import { createMemoryStore, type AsyncKeyValueStore } from './sessionAutosave';

/** Store auf der bestehenden IndexedDB-Schicht. */
export function createIndexedDbStore(): AsyncKeyValueStore {
  return {
    async get(key) {
      const value = await largeGetJson<string>(key);
      return typeof value === 'string' ? value : null;
    },
    async set(key, value) {
      await largeSetJson(key, value);
    },
    async remove(key) {
      await largeDelete(key);
    },
  };
}

export interface BestEffortStore {
  store: AsyncKeyValueStore;
  /** `indexeddb` = persistent · `memory` = nur für die Sitzung. */
  kind: 'indexeddb' | 'memory';
}

/** Wählt IndexedDB, wenn verfügbar – sonst In-Memory (mit sichtbarem `kind`). */
export function createBestEffortStore(): BestEffortStore {
  const hasIdb = typeof indexedDB !== 'undefined' && indexedDB !== null;
  if (!hasIdb) return { store: createMemoryStore(), kind: 'memory' };
  try {
    return { store: createIndexedDbStore(), kind: 'indexeddb' };
  } catch {
    return { store: createMemoryStore(), kind: 'memory' };
  }
}
