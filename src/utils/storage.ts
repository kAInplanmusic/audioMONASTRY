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
  'audiomonastry_local_presets', // DA-2026-09-29-034: Benutzer-Presets dürfen nicht über den Studio-Speicher synchronisiert werden, da sie per localStorage pro Browser leben und im Multi-User-Mirroring kollidieren. Arbeitsspeicher-only statt Server-Synchronisation.
  'dropmonk_presets', // DA-2026-09-29-034: Drop-Presets ebenfalls lokal, nicht server-autoritativ synchronisieren.
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
 * Einmalige Übernahme alter Gerätedaten: liest localStorage (Studio-Schlüssel),
 * leert danach localStorage UND sessionStorage vollständig. Einziger
 * Browser-Speicher-Zugriff in der App.
 */
export function takeLegacyLocalStorage(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const ls = globalThis.localStorage;
    if (ls) {
      for (let i = 0; i < ls.length; i += 1) {
        const key = ls.key(i);
        if (key && !isMemoryOnlyKey(key)) {
          const value = ls.getItem(key);
          if (value !== null) out[key] = value;
        }
      }
      ls.clear();
    }
  } catch { /* blockiert – nichts zu übernehmen */ }
  try {
    globalThis.sessionStorage?.clear();
  } catch { /* ignore */ }
  return out;
}

/** Nur für Tests: beide Speicher leeren. */
export function resetStorageForTests(): void {
  memory.clear();
  server.clear();
  transport = null;
}
