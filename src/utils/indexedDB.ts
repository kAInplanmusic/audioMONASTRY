/**
 * audioMONASTRY · ehemaliger IndexedDB-Adapter
 * ============================================
 * Betreiber 2026-10-06: „NICHTS wird auf den Geräten der Nutzer gespeichert."
 * Die Funktionen bleiben (gleiche Aufrufer), schreiben aber in den
 * Studio-Speicher auf dem Server (src/utils/storage.ts) – nie mehr in die
 * Browser-Datenbank. Einziger Browser-Zugriff hier: alte Daten einmalig lesen
 * (`readLegacyIndexedDb`) und – erst nach Server-Bestaetigung –
 * `deleteLegacyIndexedDb`.
 *
 * AUDIT-2026-10-30-P0-002: Vorher gab die Uebernahme im catch still `{kv:{}}`
 * zurueck und loeschte die Datenbank im finally, also auch nach fehlgeschlagenem
 * Lesen (Bestand weg, nie angekommen). Ausserdem loeschte
 * `deleteDeviceDatabases()` ALLE Datenbanken der Origin.
 */
import { storageGetJson, storageRemove, storageSetJson } from './storage';

export const LEGACY_DATABASE_NAME = 'AudioMonastryDB';
const LEGACY_DB = LEGACY_DATABASE_NAME;

/** Großen Stand laden (Studio-Speicher). */
export const largeGetJson = async <T,>(key: string): Promise<T | null> => storageGetJson<T>(key);

/** Großen Stand schreiben (Studio-Speicher, an den Server). */
export const largeSetJson = async (key: string, value: unknown): Promise<void> => {
  storageSetJson(key, value);
};

export const largeDelete = async (key: string): Promise<void> => {
  storageRemove(key);
};

export interface LegacyIndexedDbRead {
  /** true = Lesen hat vollstaendig geklappt (oder es gibt keine DB). */
  ok: boolean;
  /** true = die alte Datenbank existiert (dann darf nach ACK geloescht werden). */
  exists: boolean;
  kv: Record<string, unknown>;
  scratchpad: unknown[];
}

function openDatabase(name: string): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(name);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB.open fehlgeschlagen'));
    req.onblocked = () => reject(new Error('indexedDB.open blockiert'));
  });
}

/** Liest einen Store komplett; ein Fehler ist ein Fehler (kein stilles Leer-Ergebnis). */
function readAllRows(db: IDBDatabase, store: string): Promise<unknown[]> {
  return new Promise<unknown[]>((resolve, reject) => {
    if (!db.objectStoreNames.contains(store)) {
      resolve([]);
      return;
    }
    try {
      const tx = db.transaction(store, 'readonly');
      const req = tx.objectStore(store).getAll();
      req.onsuccess = () => resolve(req.result as unknown[]);
      req.onerror = () => reject(req.error ?? new Error(`indexedDB read ${store} fehlgeschlagen`));
      tx.onabort = () => reject(tx.error ?? new Error(`indexedDB Transaktion ${store} abgebrochen`));
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Einmalige Uebernahme: liest die alte Browser-Datenbank (kv + scratchpad).
 * Loescht NICHTS – die Loeschung passiert erst nach Server-Bestaetigung
 * (`deleteLegacyIndexedDb`). Bei Lesefehlern bleibt `ok === false`: dann wird
 * weder migriert noch geloescht, sondern beim naechsten Start erneut versucht.
 */
export async function readLegacyIndexedDb(): Promise<LegacyIndexedDbRead> {
  const none: LegacyIndexedDbRead = { ok: true, exists: false, kv: {}, scratchpad: [] };
  if (typeof indexedDB === 'undefined') return none;
  try {
    let names: string[] | null = null;
    if (typeof indexedDB.databases === 'function') {
      names = (await indexedDB.databases()).map((d) => d.name).filter((n): n is string => !!n);
      // Eine fehlende DB ist kein Fehler – aber auch kein Loeschauftrag.
      if (!names.includes(LEGACY_DB)) return none;
    }
    const db = await openDatabase(LEGACY_DB);
    try {
      const kvRows = await readAllRows(db, 'kv');
      const scratchpad = await readAllRows(db, 'scratchpad');
      const kv: Record<string, unknown> = {};
      for (const row of kvRows) {
        const r = row as { key?: unknown; value?: unknown };
        if (typeof r.key === 'string') kv[r.key] = r.value;
      }
      return { ok: true, exists: true, kv, scratchpad };
    } finally {
      try { db.close(); } catch { /* ignore */ }
    }
  } catch {
    return { ok: false, exists: true, kv: {}, scratchpad: [] };
  }
}

/**
 * Loescht ausschliesslich die alte audioMONASTRY-Datenbank. Andere Datenbanken
 * derselben Origin gehoeren anderen Apps und bleiben unangetastet.
 */
export async function deleteLegacyIndexedDb(): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  try {
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase(LEGACY_DB);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    });
  } catch { /* nichts zu löschen */ }
}
