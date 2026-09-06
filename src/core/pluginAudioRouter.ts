/**
 * audioMONASTRY · PluginAudioRouter (P0-2)
 * =========================================
 * Zentrale Schicht `pluginId → { source, mixerChannel, insertBus, activate(),
 * deactivate() }`. OFF = raus aus der Signalkette, AUTO_AI/PRO = Einspeisung.
 *
 * Alle 21 Plugin-IDs sind registriert (masterplayerMONK ist feste UI-Leiste,
 * kein Plugin). Unbekannte IDs werden geloggt und ignoriert (kein Crash).
 */
import { audioEngine, pluginAudioChannels } from '../utils/audioEngine';
import type { TrackType } from '../types';

export type PluginActiveState = 'AUTO_AI' | 'PRO';
export type PluginIsolationLevel = 'insert' | 'send' | 'ui-only';

export interface PluginRouteConfig {
  id: string;
  /** Kanal(e), auf die das Plugin seine Quelle einspeist. */
  channels: TrackType[];
  /** Audio-Quellklasse des Plugins. */
  source: 'synth' | 'drum' | 'sampler' | 'voice' | 'channel' | 'ui-only';
  /** TRUE wenn dieses Plugin Audio auf MAIN einspeisen darf. */
  mainFeeder: boolean;
  /**
   * AM-E2-1: Audio-Isolation-Level des Plugins.
   *   insert  = eigene Quelle → Kanalzug → MAIN (z. B. synth/drum/sampler)
   *   send    = Kanalweg-/Bus-Einspeisung (z. B. mixer/effect/eq/dsp/spatial)
   *   ui-only = kein Audio-Graph (z. B. library/mastering/controller)
   */
  isolation: PluginIsolationLevel;
}

const PLUGIN_ROUTE_DEFS: Array<[string, PluginRouteConfig['source'], boolean]> = [
  ['mixer', 'channel', true],
  ['drop', 'sampler', true],
  ['song', 'ui-only', false],
  ['effect', 'channel', true],
  ['instrument', 'synth', true],
  ['sampler', 'sampler', true],
  ['drum', 'drum', true],
  ['mcp', 'sampler', true],
  ['synthesizer', 'synth', true],
  ['stem', 'ui-only', false],
  ['voice', 'voice', true],
  ['sound', 'sampler', true],
  ['spatial', 'channel', true],
  ['library', 'ui-only', false],
  ['eq', 'channel', true],
  ['dsp', 'channel', true],
  ['mastering', 'ui-only', false],
  ['recording', 'ui-only', false],
  ['controller', 'ui-only', false],
  ['performance', 'ui-only', false],
  ['ai', 'ui-only', false],
];

const ROUTES: Record<string, PluginRouteConfig> = Object.fromEntries(
  PLUGIN_ROUTE_DEFS.map(([id, source, mainFeeder]) => [
    id,
    {
      id,
      channels: pluginAudioChannels(id),
      source,
      mainFeeder,
      isolation: isolationFor(source),
    },
  ]),
);

/** AM-E2-1: Isolation-Level aus der Quellklasse ableiten. */
function isolationFor(source: PluginRouteConfig['source']): PluginIsolationLevel {
  if (source === 'ui-only') return 'ui-only';
  if (source === 'channel') return 'send';
  return 'insert';
}

/** AM-E2-1: Routing-Matrix validieren (P2-4-Vorprüfung, serverlos). */
export function validateRoutingMatrix(ids: readonly string[]): string[] {
  const violations: string[] = [];
  for (const id of ids) {
    const route = ROUTES[id];
    if (!route) {
      violations.push(`${id}: nicht registriert`);
      continue;
    }
    if (route.isolation !== 'ui-only' && route.channels.length === 0) {
      violations.push(`${id}: Audio-Quelle ohne Kanalziel (isolation=${route.isolation})`);
    }
    for (const ch of route.channels) {
      if (!/^channel([1-9]|10)$/.test(ch)) {
        violations.push(`${id}: ungültiges Kanalziel ${ch}`);
      }
    }
  }
  return violations;
}

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
