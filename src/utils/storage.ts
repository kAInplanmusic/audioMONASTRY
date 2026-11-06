/**
 * audioMONASTRY · Storage-Adapter (Plattform-Kapsel)
 * ===================================================
 * Betreiber 2026-10-06: „NICHTS wird auf den Geräten der Nutzer gespeichert.
 * Keine Sounds, keine Audio, nichts."
 *
 * Dieser Adapter berührt deshalb KEINEN Browser-Speicher mehr (kein
 * localStorage/sessionStorage). Die Schnittstelle bleibt gleich und synchron;
 * dahinter liegen zwei Ziele:
 *
 *   Studio-Speicher (Server) – Studio-Daten: Presets, Favoriten, Autoload,
 *     Mappings, Stream-Einstellung … Beim Start vorgeladen (GET /api/store),
 *     Schreiben über den Socket an die Session, Änderungen anderer Geräte
 *     kommen zurück (src/utils/studioStoreSync.ts).
 *   Arbeitsspeicher – Protokolle, Zwischenspeicher, gerätebezogene Dinge
 *     (Audio-Eingang, Name/Farbe, Undo-Punkt). Weg nach dem Neuladen.
 *
 * Neue Schlüssel gehen standardmäßig auf den Server; nur die Liste unten
 * bleibt im Arbeitsspeicher.
 */

/** Schlüssel (oder Präfixe mit `*`), die nur im Arbeitsspeicher leben. */
export const MEMORY_ONLY_KEYS: readonly string[] = [
  'moa-log-*', // Assistenten-Verlauf je Plugin (Anzeige)
  'audiomonastry_audit_log', // lokale Audit-Kopie (der Server auditiert selbst)
  'audiomonastry_error_log', // Fehler-Warteschlange für die Telemetrie
  'audiomonastry_usage', // Nutzungszähler (Telemetrie)
  'am_analysis', // Analyse-Zwischenspeicher
  'audiomonastry_audio_settings', // gewählter Audio-Eingang – gilt nur für dieses Gerät
  'audiomonastry_user_*', // Name/Farbe/ID dieses Fensters
  'audiomonastry_module_states', // Modul-Zustände – Wahrheit ist die Session
  'spatialmonk-scene-snapshot', // Undo-Punkt im Spatial-Plugin
  // AUDIT-2026-10-30-P0-002: `audiomonastry_local_presets`/`dropmonk_presets`
  // standen hier (DA-2026-09-29-034, Kollisionen im Multi-User-Mirroring).
  // Folge: die Legacy-Migration hat die Schluessel nie uebernommen, aber das
  // Geraete-localStorage sofort geleert -> alle alten Presets waren nach dem
  // ersten Start weg. Datenverlust wiegt schwerer als die Mirroring-Kollision;
  // Presets sind deshalb wieder Studio-Speicher (Server-Wahrheit) und werden
  // migriert. Schreibzugriffe lesen den Serverstand vorher (presetStore.ts),
  // damit parallele Geraete ihre Listen nicht blind ueberschreiben.
];

export function isMemoryOnlyKey(key: string): boolean {
  return MEMORY_ONLY_KEYS.some((k) => (k.endsWith('*') ? key.startsWith(k.slice(0, -1)) : key === k));
}

export interface StudioStoreTransport {
  set(key: string, value: string): void;
  remove(key: string): void;
}

const memory = new Map<string, string>();
const server = new Map<string, string>();
let transport: StudioStoreTransport | null = null;

/** Verbindung zum Server-Speicher (src/utils/studioStoreSync.ts). */
export function setStudioStoreTransport(t: StudioStoreTransport | null): void {
  transport = t;
}

/** Vorgeladene bzw. von anderen Geräten geänderte Server-Einträge übernehmen. */
export function applyServerStore(entries: Record<string, string | null>): void {
  for (const [key, value] of Object.entries(entries)) {
    if (value === null) server.delete(key);
    else if (typeof value === 'string') server.set(key, value);
  }
}

export function storageGet(key: string): string | null {
  return (isMemoryOnlyKey(key) ? memory.get(key) : server.get(key)) ?? null;
}

export function storageSet(key: string, value: string): void {
  if (isMemoryOnlyKey(key)) {
    memory.set(key, value);
    return;
  }
  if (server.get(key) === value) return;
  server.set(key, value);
  transport?.set(key, value);
}

export function storageRemove(key: string): void {
  if (isMemoryOnlyKey(key)) {
    memory.delete(key);
    return;
  }
  if (!server.has(key)) return;
  server.delete(key);
  transport?.remove(key);
}

export function storageGetJson<T>(key: string): T | null {
  const raw = storageGet(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function storageSetJson(key: string, value: unknown): void {
  try {
    storageSet(key, JSON.stringify(value));
  } catch {
    /* nicht serialisierbar – ignorieren */
  }
}

/**
 * AUDIT-2026-10-30-P0-002: Version der einmaligen Uebernahme alter Geraetedaten.
 * Der Marker selbst liegt NICHT auf dem Geraet (Betreiber: nichts auf den
 * Geraeten), sondern versioniert im Studio-Speicher
 * (`audiomonastry_legacy_migration`, siehe studioStoreSync.ts) und haelt fest,
 * welche Schluessel dieses Geraet bereits uebernommen hat.
 */
export const LEGACY_MIGRATION_VERSION = 1;

export interface LegacyLocalStorageRead {
  /** Studio-Schluessel (Server): duerfen migriert werden. */
  entries: Record<string, string>;
  /** Geraetebezogene Schluessel: nur Arbeitsspeicher, nie Server. */
  memoryOnly: Record<string, string>;
  /** localStorage nicht lesbar (blockiert) – dann darf nichts geloescht werden. */
  blocked: boolean;
}

/**
 * Einmalige Uebernahme alter Geraetedaten: LIEST localStorage nur.
 * Gelöscht wird erst, wenn der Server den uebernommenen Stand bestaetigt hat
 * (`purgeLegacyLocalStorage`). Vorher gab diese Funktion localStorage sofort
 * frei – ein Reload vor dem Session-Join loeschte den Altbestand, ohne dass er
 * je beim Server ankam.
 */
export function readLegacyLocalStorage(): LegacyLocalStorageRead {
  const out: LegacyLocalStorageRead = { entries: {}, memoryOnly: {}, blocked: false };
  try {
    const ls = globalThis.localStorage;
    if (!ls) return out;
    const keys: string[] = [];
    for (let i = 0; i < ls.length; i += 1) {
      const key = ls.key(i);
      if (key) keys.push(key);
    }
    for (const key of keys) {
      const value = ls.getItem(key);
      if (value === null) continue;
      if (isMemoryOnlyKey(key)) out.memoryOnly[key] = value;
      else out.entries[key] = value;
    }
  } catch {
    out.blocked = true;
  }
  return out;
}

/** Entfernt die uebernommenen Schluessel – nur nach Server-Bestaetigung. */
export function purgeLegacyLocalStorage(keys: readonly string[]): void {
  try {
    const ls = globalThis.localStorage;
    if (!ls) return;
    for (const key of keys) {
      ls.removeItem(key);
    }
  } catch { /* blockiert – beim naechsten Start erneut */ }
}

/** sessionStorage enthaelt nur Geraete-Krimskrams; erst nach Bestaetigung leeren. */
export function purgeLegacySessionStorage(): void {
  try {
    globalThis.sessionStorage?.clear();
  } catch { /* ignore */ }
}

/** Nur für Tests: beide Speicher leeren. */
export function resetStorageForTests(): void {
  memory.clear();
  server.clear();
  transport = null;
}
