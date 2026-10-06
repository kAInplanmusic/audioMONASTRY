import { webRTCManager } from './WebRTCManager';
import { storageGetJson } from './storage';
import { PluginSettingsStore, type PluginSettings } from '../core/session/pluginSettingsSync';

export { mergeKnown } from '../core/session/pluginSettingsSync';

/**
 * Beständige Plugins – Browser-Anbindung des Speichers
 * (src/core/session/pluginSettingsSync.ts).
 *
 * Terminals nutzen nur drei Funktionen:
 *   readPluginSettings(id, alterSchlüssel?)  → Einstiegsstand beim Öffnen
 *   writePluginSettings(id, stand)           → bei jeder Änderung
 *   flushPluginSettings(id)                  → beim Verlassen (App ruft das)
 *
 * Der alte, nur lokale Gerätespeicher (z. B. 'eq-state') dient einmalig als
 * Startwert, solange die Session noch keinen Stand für das Plugin hat.
 */

/** Wird vom PluginManagerProvider gesetzt (zentraler Lock = Halter-Wahrheit). */
let holderCheck: (pluginId: string) => boolean = () => false;

export function setPluginSettingsHolderCheck(fn: (pluginId: string) => boolean): void {
  holderCheck = fn;
}

const store = new PluginSettingsStore({
  send: (pluginId, settings) => webRTCManager.sendPluginSettings(pluginId, settings),
  isHolder: (pluginId) => holderCheck(pluginId),
  setTimer: (fn, ms) => window.setTimeout(fn, ms),
  clearTimer: (h) => window.clearTimeout(h as number),
});

let started = false;

/** Einmal beim Start (main.tsx): Session-Stände empfangen, beim Schließen sichern. */
export function startPluginSettingsSync(): void {
  if (started) return;
  started = true;
  webRTCManager.onSessionState((snapshot: unknown) => store.acceptSnapshot(snapshot));
  webRTCManager.onPluginSettings((msg: { pluginId?: unknown }) => store.accept(String(msg?.pluginId ?? ''), msg));
  window.addEventListener('pagehide', () => store.flushAll());
}

export interface PluginSettingsOptions {
  /** Bereich innerhalb eines Plugins (z. B. 'mpc' im syntisampler). */
  section?: string;
  /** Alter, nur lokaler Speicherschlüssel – einmaliger Startwert ohne Session-Stand. */
  legacyKey?: string;
}

export function readPluginSettings<T = PluginSettings>(pluginId: string, opts: PluginSettingsOptions = {}): T | null {
  return store.read<T>(pluginId, opts.section) ?? (opts.legacyKey ? storageGetJson<T>(opts.legacyKey) : null);
}

export function writePluginSettings(pluginId: string, settings: object, opts: PluginSettingsOptions = {}): void {
  store.write(pluginId, settings as PluginSettings, opts.section);
}

export function flushPluginSettings(pluginId: string): void {
  store.flush(pluginId);
}
