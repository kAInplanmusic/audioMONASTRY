/**
 * audioMONASTRY · ehemaliger IndexedDB-Adapter
 * ============================================
 * Betreiber 2026-10-06: „NICHTS wird auf den Geräten der Nutzer gespeichert."
 * Die Funktionen bleiben (gleiche Aufrufer), schreiben aber in den
 * Studio-Speicher auf dem Server (src/utils/storage.ts) – nie mehr in die
 * Browser-Datenbank. Alte Daten werden nur lesend übernommen;
 * ohne dauerhaft bestätigte Migration darf nichts gelöscht werden.
 */
import { storageGetJson, storageRemove, storageSetJson } from './storage';

const LEGACY_DB = 'AudioMonastryDB';

/** Großen Stand laden (Studio-Speicher). */
export const largeGetJson = async <T,>(key: string): Promise<T | null> => storageGetJson<T>(key);

/** Großen Stand schreiben (Studio-Speicher, an den Server). */
export const largeSetJson = async (key: string, value: unknown): Promise<void> => {
  storageSetJson(key, value);
};

export const largeDelete = async (key: string): Promise<void> => {
  storageRemove(key);
};

/**
 * Liest die alte Browser-Datenbank (kv + scratchpad), ohne sie zu löschen.
 * Ohne IndexedDB oder ohne alte Daten: leer.
 */
export async function takeLegacyIndexedDb(): Promise<{ kv: Record<string, unknown>; scratchpad: unknown[] }> {
  const empty = { kv: {}, scratchpad: [] as unknown[] };
  if (typeof indexedDB === 'undefined') return empty;
  try {
    const list = typeof indexedDB.databases === 'function' ? await indexedDB.databases() : [{ name: LEGACY_DB }];
    if (!list.some((d) => d.name === LEGACY_DB)) return empty;
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(LEGACY_DB);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const readAll = (store: string) => new Promise<unknown[]>((resolve) => {
      if (!db.objectStoreNames.contains(store)) { resolve([]); return; }
      const req = db.transaction(store, 'readonly').objectStore(store).getAll();
      req.onsuccess = () => resolve(req.result as unknown[]);
      req.onerror = () => resolve([]);
    });
    const kvRows = await readAll('kv');
    const scratchpad = await readAll('scratchpad');
    db.close();
    const kv: Record<string, unknown> = {};
    for (const row of kvRows) {
      const r = row as { key?: unknown; value?: unknown };
      if (typeof r.key === 'string') kv[r.key] = r.value;
    }
    return { kv, scratchpad };
  } catch {
    return empty;
  }
}
