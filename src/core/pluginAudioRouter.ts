/**
 * audioMONASTRY · PluginAudioRouter (P0-2)
 * =========================================
 * Zentrale Schicht `pluginId → { source, mixerChannel, insertBus, activate(),
 * deactivate() }`. OFF = raus aus der Signalkette, AUTO_AI/PRO = Einspeisung.
 *
 * Alle 21 Plugin-IDs sind registriert. Unbekannte IDs werden geloggt und
 * ignoriert (kein Crash, kein Blind-Routing).
 */
import { audioEngine, pluginAudioChannels } from '../utils/audioEngine';
import type { TrackType } from '../types';

export type PluginActiveState = 'AUTO_AI' | 'PRO';

export interface PluginRouteConfig {
  id: string;
  /** Kanal(e), auf die das Plugin seine Quelle einspeist. */
  channels: TrackType[];
  /** Audio-Quellklasse des Plugins. */
  source: 'synth' | 'drum' | 'sampler' | 'voice' | 'channel' | 'ui-only';
  /** TRUE wenn dieses Plugin Audio auf MAIN einspeisen darf. */
  mainFeeder: boolean;
}

const PLUGIN_ROUTE_DEFS: Array<[string, PluginRouteConfig['source'], boolean]> = [
  ['masterplayer', 'ui-only', false],
  ['instrument', 'synth', true],
  ['synthesizer', 'synth', true],
  ['drum', 'drum', true],
  ['sampler', 'sampler', true],
  ['mcp', 'sampler', true],
  ['voice', 'voice', true],
  ['sound', 'sampler', true],
  ['mixer', 'channel', true],
  ['controller', 'ui-only', false],
  ['effect', 'channel', true],
  ['drop', 'sampler', true],
  ['library', 'ui-only', false],
  ['eq', 'channel', true],
  ['dsp', 'channel', true],
  ['mastering', 'ui-only', false],
  ['stem', 'ui-only', false],
  ['spatial', 'channel', true],
  ['recording', 'ui-only', false],
  ['performance', 'ui-only', false],
  ['ai', 'ui-only', false],
];

const ROUTES: Record<string, PluginRouteConfig> = Object.fromEntries(
  PLUGIN_ROUTE_DEFS.map(([id, source, mainFeeder]) => [
    id,
    { id, channels: pluginAudioChannels(id), source, mainFeeder },
  ]),
);

export const PLUGIN_ROUTE_IDS: readonly string[] = Object.freeze(Object.keys(ROUTES));

export function getPluginRoute(id: string): PluginRouteConfig | undefined {
  return ROUTES[id];
}

export function listPluginRoutes(): PluginRouteConfig[] {
  return Object.values(ROUTES);
}

/**
 * Aktiviert ein Plugin (OFF → AUTO_AI/PRO).
 * Unbekannte IDs werden geloggt und ignoriert.
 */
export function activatePlugin(id: string, state: PluginActiveState): void {
  const route = ROUTES[id];
  if (!route) {
    console.warn('[pluginAudioRouter] unbekannte Plugin-ID ignoriert:', id);
    return;
  }
  try {
    audioEngine.activatePlugin(id, state);
  } catch (e) {
    console.warn('[pluginAudioRouter] activate fehlgeschlagen:', id, (e as Error).message);
  }
}

/**
 * Deaktiviert ein Plugin (→ OFF): Signalquelle trennen bzw. sanft stummschalten.
 */
export function deactivatePlugin(id: string): void {
  const route = ROUTES[id];
  if (!route) {
    console.warn('[pluginAudioRouter] unbekannte Plugin-ID ignoriert:', id);
    return;
  }
  try {
    audioEngine.deactivatePlugin(id);
    // NEW-D1-2: mixerMONK ist die einzige MAIN-Einspeisung – OFF stoppt Main+Clock.
    if (id === 'mixer') (audioEngine as any).stopMainAndClock?.();
  } catch (e) {
    console.warn('[pluginAudioRouter] deactivate fehlgeschlagen:', id, (e as Error).message);
  }
}

/**
 * Zentrale Zustands-Transition für ModuleStateContext/PluginManager:
 * OFF → deactivate, AUTO_AI/PRO → activate.
 */
export function routeModuleState(id: string, state: 'OFF' | PluginActiveState): void {
  if (state === 'OFF') deactivatePlugin(id);
  else activatePlugin(id, state);
}

/** Prüfpunkt P0-2: keine unbekannten Plugin-IDs im Router-Register. */
export function assertAllPluginIdsRegistered(ids: readonly string[]): string[] {
  const missing = ids.filter((id) => !ROUTES[id]);
  return missing;
}
