/**
 * audioMONASTRY · IndexedDB-Adapter (Plattform-Kapsel)
 * =====================================================
 * Kapselt Scratchpad- und KV-Zugriffe. Andere Module nutzen `db.ts`
 * (Re-Export) und damit indirekt diesen Adapter.
 *
 * DCT-106: Große States (Session-Snapshots, History, Presets, Waveform-
 * Metadaten) gehören in IndexedDB, kleine UI-Präferenzen bleiben in
 * localStorage, Audio-Blobs liegen in OPFS. Audio-Pfade warten NIE auf
 * IndexedDB – alle Schreibzugriffe sind fire-and-forget.
 */
/** Einmal geöffnete Verbindung wird wiederverwendet (kein Connection-Leak). */
let dbPromise: Promise<IDBDatabase> | null = null;

export const openDB = (): Promise<IDBDatabase> => {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('AudioMonastryDB', 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('scratchpad')) {
        db.createObjectStore('scratchpad', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('kv')) {
        db.createObjectStore('kv', { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      dbPromise = null; // erneuter Versuch nach Fehler
      reject(request.error);
    };
  });
  return dbPromise;
};

export const saveToDB = async (item: unknown): Promise<void> => {
  const db = await openDB();
  const tx = db.transaction('scratchpad', 'readwrite');
  tx.objectStore('scratchpad').put({ ...(item as Record<string, unknown>), lastModified: Date.now() });
};

/** Große JSON-States asynchron laden (nie im Audio-Callback aufrufen). */
export const largeGetJson = async <T,>(key: string): Promise<T | null> => {
  if (typeof indexedDB === 'undefined') return null;
  try {
    const db = await openDB();
    const tx = db.transaction('kv', 'readonly');
    const req = tx.objectStore('kv').get(key);
    return await new Promise<T | null>((resolve, reject) => {
      req.onsuccess = () => resolve((req.result as { value?: T } | undefined)?.value ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
};

/** Große JSON-States asynchron schreiben (fire-and-forget-fähig). */
export const largeSetJson = async (key: string, value: unknown): Promise<void> => {
  if (typeof indexedDB === 'undefined') return;
  try {
    const db = await openDB();
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put({ key, value, updatedAt: Date.now() });
  } catch {
    /* Quota/Fehler – nicht kritisch */
  }
};

export const largeDelete = async (key: string): Promise<void> => {
  if (typeof indexedDB === 'undefined') return;
  try {
    const db = await openDB();
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').delete(key);
  } catch {
    /* ignore */
  }
};
