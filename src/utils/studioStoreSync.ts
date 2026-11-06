/**
 * Studio-Speicher ↔ Server (Betreiber 2026-10-06: „NICHTS wird auf den Geräten
 * der Nutzer gespeichert")
 * ==========================================================================
 * - Beim Start alle Einträge vom Server vorladen (GET /api/store), bevor die
 *   Oberfläche zeichnet – Presets, Favoriten usw. sind sofort da.
 * - Schreiben geht über den Socket an die Session (erst nach dem Beitritt;
 *   vorher wird gesammelt und danach gesendet).
 * - Änderungen anderer Geräte kommen live zurück.
 * - Einmalig: alte Gerätedaten (localStorage, Browser-Datenbank) auf den Server
 *   übernehmen und erst danach vom Gerät löschen – auch Dateien im Gerät (OPFS).
 *
 * AUDIT-2026-10-30-P0-002 (Legacy-Migration darf Server-Wahrheit nicht
 * ueberschreiben und Geraetedaten nicht vor der Bestaetigung loeschen):
 * - Das Vorlade-Ergebnis wird als `confirmed` vs. `unreachable` gefuehrt.
 *   Fehler, Timeout und Nicht-200 galten vorher als „Server hat nichts“, danach
 *   hat die Migration jeden Altbestand per store-set (serverseitig
 *   Last-Write-Wins) ueber die Server-Wahrheit geschrieben.
 * - Ohne bestaetigten Server wird NICHT migriert: Altdaten bleiben liegen und
 *   werden beim naechsten Start erneut versucht.
 * - Ein Key, den der Server schon hat, gilt als Server-Wahrheit und wird nicht
 *   ueberschrieben (auch wenn sein Wert nicht dekodierbar ist).
 * - Geloescht wird erst nach Server-ACK: Read-back von GET /api/store muss die
 *   uebernommenen Werte bestaetigen; sonst bleiben Altdaten und IndexedDB-DB
 *   unangetastet (Reload vor dem Join verliert nichts mehr).
 * - Migrationsmarker: versionierter Eintrag `audiomonastry_legacy_migration` im
 *   Studio-Speicher (Server) mit der Liste bereits uebernommener Schluessel.
 *   Ein Marker in localStorage waere billiger, verstoesst aber gegen „nichts
 *   auf dem Geraet" (tests/e2e/noDeviceStorage.spec.ts prueft local === 0).
 *
 * Werte gehen als JSON-Text über die Leitung (der Server prüft JSON).
 */
import {
  applyServerStore,
  LEGACY_MIGRATION_VERSION,
  purgeLegacyLocalStorage,
  purgeLegacySessionStorage,
  readLegacyLocalStorage,
  setStudioStoreTransport,
  storageGet,
  storageSet,
  storageSetJson,
} from './storage';
import { deleteLegacyIndexedDb, readLegacyIndexedDb } from './indexedDB';
import { purgeDeviceFiles } from './opfs';
import { webRTCManager } from './WebRTCManager';

/** Versionierter Migrationsmarker im Studio-Speicher (Server, kein Geraetezustand). */
export const LEGACY_MIGRATION_LEDGER_KEY = 'audiomonastry_legacy_migration';

const pending = new Map<string, string | null>();
let joined = false;
let started = false;
let unsubscribers: Array<() => void> = [];

/** Ein Eintrag, den die Migration auf den Server gebracht hat (Wert = Server-Rohtext). */
interface MigrationState {
  /** Schluessel -> erwarteter Studio-Wert (Rohtext) fuer den ACK-Vergleich. */
  expected: Map<string, string>;
  /** Vor diesem Lauf bereits als uebernommen markierte Schluessel. */
  deliveredBefore: Set<string>;
  legacyKeys: string[];
  deleteLegacyDb: boolean;
  dbOk: boolean | null;
  finalized: boolean;
}

let migration: MigrationState | null = null;
let migrationTask: Promise<void> | null = null;
let confirming = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

function flush(): void {
  for (const [key, value] of pending) {
    if (value === null) webRTCManager.sendStoreRemove(key);
    else webRTCManager.sendStoreSet(key, JSON.stringify(value));
  }
  pending.clear();
}

/** Server-Antwort (Werte als JSON-Text) in Rohtexte für den Adapter wandeln. */
export function decodeServerEntries(entries: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!entries || typeof entries !== 'object') return out;
  for (const [key, raw] of Object.entries(entries as Record<string, unknown>)) {
    if (typeof raw !== 'string') continue;
    try {
      const value = JSON.parse(raw);
      if (typeof value === 'string') out[key] = value;
    } catch { /* ungültiger Eintrag – überspringen */ }
  }
  return out;
}

export interface PreloadOutcome {
  /** `confirmed` nur bei HTTP 200 UND lesbarer entries-Antwort. */
  status: 'confirmed' | 'unreachable';
  /** Dekodierte Studio-Werte (Rohtext wie im Adapter) – Grundlage fuer den ACK-Vergleich. */
  entries: Record<string, string>;
  /** Alle Key-Namen, die der Server fuehrt – auch nicht dekodierbare Werte. */
  serverKeys: string[];
}

/**
 * Holt den Server-Stand. Jeder Zweifelsfall (Netzfehler, Timeout/Abort,
 * Nicht-200, kaputter Body) ist `unreachable` – NICHT „Server ist leer“.
 */
export async function preloadStudioStore(timeoutMs = 2500): Promise<PreloadOutcome> {
  const unreachable: PreloadOutcome = { status: 'unreachable', entries: {}, serverKeys: [] };
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch('/api/store', { cache: 'no-store', signal: ctrl.signal });
    } finally {
      clearTimeout(t);
    }
    if (!res.ok) return unreachable;
    const body = (await res.json()) as { entries?: unknown } | null;
    if (!body || typeof body !== 'object' || !body.entries || typeof body.entries !== 'object') {
      return unreachable;
    }
    const raw = body.entries as Record<string, unknown>;
    const entries = decodeServerEntries(raw);
    applyServerStore(entries);
    return { status: 'confirmed', entries, serverKeys: Object.keys(raw) };
  } catch {
    return unreachable;
  }
}

/** Bereits uebernommene Schluessel aus dem Server-Marker (leer = noch nie migriert). */
function readDeliveredKeys(entries: Record<string, string>): Set<string> {
  const delivered = new Set<string>();
  const raw = entries[LEGACY_MIGRATION_LEDGER_KEY];
  if (!raw) return delivered;
  try {
    const parsed = JSON.parse(raw) as { version?: unknown; delivered?: unknown };
    if (typeof parsed?.version !== 'number' || parsed.version < LEGACY_MIGRATION_VERSION) return delivered;
    if (!Array.isArray(parsed.delivered)) return delivered;
    for (const key of parsed.delivered) if (typeof key === 'string') delivered.add(key);
  } catch { /* kaputter Marker – wie „noch nicht migriert“ behandeln */ }
  return delivered;
}

function registerListeners(): void {
  for (const off of unsubscribers) off();
  unsubscribers = [
    // Nach jedem (Wieder-)Beitritt kommt ein Session-Snapshot: jetzt darf geschrieben werden.
    webRTCManager.onSessionState(() => {
      joined = true;
      flush();
      scheduleConfirmation();
    }),
    webRTCManager.onStoreUpdate((msg: { key?: unknown; value?: unknown }) => {
      const key = typeof msg?.key === 'string' ? msg.key : '';
      if (!key) return;
      if (msg.value === null) applyServerStore({ [key]: null });
      else applyServerStore(decodeServerEntries({ [key]: msg.value }));
    }),
  ];
}

/**
 * Bestaetigung per Read-back: erst wenn der Server alle uebernommenen Werte
 * (inkl. Migrationsmarker) unveraendert zurueckliefert, darf das Geraet sie
 * loeschen. Ohne ACK bleibt alles liegen (Retry beim naechsten Join/Start).
 */
async function confirmMigration(timeoutMs = 2500): Promise<void> {
  const current = migration;
  if (!current || current.finalized || confirming || current.expected.size === 0) return;
  confirming = true;
  try {
    const outcome = await preloadStudioStore(timeoutMs);
    if (outcome.status !== 'confirmed') return;
    for (const [key, expectedValue] of current.expected) {
      if (outcome.entries[key] !== expectedValue) return;
    }
    // Erst nach bestaetigter Uebernahme markieren: ein Marker, der vor dem ACK
    // geschrieben wird, wuerde beim naechsten Start die Loeschung erlauben,
    // obwohl der Wert den Server nie erreicht hat.
    writeLedger(current);
    finalizeMigration(current);
  } finally {
    confirming = false;
  }
}

/**
 * Schreibt den Migrationsmarker (Server) fuer die in diesem Lauf uebernommenen
 * Schluessel. Wird erst nach erfolgreichem ACK aufgerufen.
 */
function writeLedger(current: MigrationState): void {
  const delivered = new Set(current.deliveredBefore);
  for (const key of current.expected.keys()) delivered.add(key);
  if (delivered.size === 0) return;
  storageSet(LEGACY_MIGRATION_LEDGER_KEY, JSON.stringify({
    version: LEGACY_MIGRATION_VERSION,
    delivered: [...delivered].sort(),
  }));
}

/**
 * Bestaetigung mit begrenzten Nachversuchen: store-set geht per Socket raus,
 * der Read-back per HTTP – die Reihenfolge am Server ist nicht garantiert.
 * Ohne Nachversuch bliebe die Loeschung bis zum naechsten Session-Beitritt oder
 * Seitenneuladen liegen.
 */
function scheduleConfirmation(attempt = 0): void {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void confirmMigration().then(() => {
      if (migration && !migration.finalized && attempt < 4) scheduleConfirmation(attempt + 1);
    });
  }, attempt === 0 ? 0 : Math.min(5000, 250 * 2 ** attempt));
}

/** Loescht Geraetedaten – erst nach bestaetigtem Server-Stand. */
function finalizeMigration(current: MigrationState | null): void {
  if (!current || current.finalized) return;
  if (current.dbOk !== true) return; // DB-Read offen/gescheitert: naechster Start
  current.finalized = true;
  purgeLegacyLocalStorage(current.legacyKeys);
  purgeLegacySessionStorage();
  if (current.deleteLegacyDb) void deleteLegacyIndexedDb();
  void purgeDeviceFiles();
  if (migration === current) migration = null;
}

/** Einmal beim Start (main.tsx), vor dem ersten Zeichnen. */
export async function startStudioStoreSync(timeoutMs = 2500): Promise<void> {
  if (started) return;
  started = true;

  setStudioStoreTransport({
    set: (key, value) => {
      pending.set(key, value);
      if (joined) flush();
    },
    remove: (key) => {
      pending.set(key, null);
      if (joined) flush();
    },
  });
  registerListeners();

  const preload = await preloadStudioStore(timeoutMs);
  if (preload.status !== 'confirmed') {
    // Server hat NICHT geantwortet: nicht migrieren, nichts loeschen, Retry beim
    // naechsten Start (bzw. erneutem Aufruf). Die Altdaten bleiben vollstaendig.
    console.warn('[studioStoreSync] Server-Stand nicht bestaetigt – Legacy-Migration verschoben, Geraetedaten bleiben erhalten.');
    started = false;
    return;
  }

  const serverKeys = new Set(preload.serverKeys);
  const delivered = readDeliveredKeys(preload.entries);
  const legacy = readLegacyLocalStorage();
  if (legacy.blocked) {
    console.warn('[studioStoreSync] localStorage nicht lesbar – Legacy-Migration verschoben.');
    started = false;
    return;
  }

  const current: MigrationState = {
    expected: new Map(),
    deliveredBefore: delivered,
    legacyKeys: [...Object.keys(legacy.entries), ...Object.keys(legacy.memoryOnly)],
    deleteLegacyDb: false,
    dbOk: null,
    finalized: false,
  };
  migration = current;

  // Geraetebezogene Altlasten leben weiter im Arbeitsspeicher (nie auf dem Server).
  for (const [key, value] of Object.entries(legacy.memoryOnly)) storageSet(key, value);

  for (const [key, value] of Object.entries(legacy.entries)) {
    // Bereits uebernommen (Marker) oder Server-Wahrheit vorhanden -> nicht schreiben.
    if (delivered.has(key)) continue;
    if (serverKeys.has(key) || storageGet(key) !== null) continue;
    storageSet(key, value);
    current.expected.set(key, value);
  }

  migrationTask = (async () => {
    const legacyDb = await readLegacyIndexedDb();
    current.dbOk = legacyDb.ok;
    current.deleteLegacyDb = legacyDb.exists;
    if (!legacyDb.ok) {
      console.warn('[studioStoreSync] Alte Browser-Datenbank nicht lesbar – weder Migration noch Loeschung.');
      return;
    }
    for (const [key, value] of Object.entries(legacyDb.kv)) {
      if (delivered.has(key)) continue;
      if (serverKeys.has(key) || storageGet(key) !== null) continue;
      const raw = JSON.stringify(value);
      storageSetJson(key, value);
      current.expected.set(key, raw);
    }
    if (legacyDb.scratchpad.length > 0
      && !delivered.has('audiomonastry_scratchpad')
      && !serverKeys.has('audiomonastry_scratchpad')
      && storageGet('audiomonastry_scratchpad') === null) {
      const raw = JSON.stringify(legacyDb.scratchpad);
      storageSetJson('audiomonastry_scratchpad', legacyDb.scratchpad);
      current.expected.set('audiomonastry_scratchpad', raw);
    }
  })().catch(() => { current.dbOk = false; });

  await migrationTask;

  if (current.expected.size > 0) {
    if (joined) {
      flush();
      scheduleConfirmation();
    }
    return;
  }

  // Nichts an den Server zu uebertragen: Bestaetigung ist der Preload selbst.
  finalizeMigration(current);
}

/** Nur fuer Tests: Modulzustand zuruecksetzen (Reload simulieren). */
export function resetStudioStoreSyncForTests(): void {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  for (const off of unsubscribers) off();
  unsubscribers = [];
  pending.clear();
  joined = false;
  started = false;
  migration = null;
  migrationTask = null;
  confirming = false;
}
