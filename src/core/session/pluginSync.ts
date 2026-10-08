/**
 * UI2-P0-003 · SYNC gegen Main (Betreiber 2026-10-06)
 * ====================================================
 * Jedes Plugin, das etwas abspielt oder erzeugt und abspielt, hat eine
 * SYNC-Taste (Standard an). SYNC an: Start auf dem nächsten Main-Takt,
 * taktgleiche Pattern-Position, Main-Tempo (Stems gewarpt), Pad-Quantisierung.
 * SYNC aus: sofortiger Start, eigene Zählung.
 *
 * Dieses Modul hält nur den Zustand (UI-Wahrheit, kein Audio-Thread). Die
 * Audio-Seite liest ihn über `isPluginSynced()` bzw. `subscribePluginSync()`;
 * die sample-genaue Quantisierung gehört in die v2-Verkabelung
 * (docs/design/V2_UI_VERKABELUNG.md, Abschnitt 3).
 */

export const SYNC_PLUGINS = ['drop', 'song', 'syntisampler', 'drumsampler', 'instru', 'voice', 'sound', 'stem'] as const;
export type SyncPluginId = (typeof SYNC_PLUGINS)[number];

const state = new Map<string, boolean>(SYNC_PLUGINS.map((id) => [id, true]));
const listeners = new Set<() => void>();
let version = 0;

export function isSyncPlugin(id: string): id is SyncPluginId {
  return (SYNC_PLUGINS as readonly string[]).includes(id);
}

/** SYNC-Zustand eines Plugins; Plugins ohne Wiedergabe sind nie synchronisiert. */
export function isPluginSynced(id: string): boolean {
  return isSyncPlugin(id) ? state.get(id) !== false : false;
}

/** Setzt SYNC; liefert `false` für Plugins ohne Wiedergabe. */
export function setPluginSync(id: string, on: boolean): boolean {
  if (!isSyncPlugin(id)) return false;
  if (state.get(id) === on) return true;
  state.set(id, on);
  version += 1;
  listeners.forEach((l) => l());
  return true;
}

export function subscribePluginSync(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Für `useSyncExternalStore`: ändert sich bei jeder SYNC-Änderung. */
export function pluginSyncVersion(): number {
  return version;
}

/** Snapshot für Session-Zwischenspeicher und Replikation. */
export function pluginSyncSnapshot(): Record<string, boolean> {
  return Object.fromEntries(SYNC_PLUGINS.map((id) => [id, isPluginSynced(id)]));
}
