/**
 * pluginTheme – zentrale Zuordnung Plugin-ID → CSS-Theme-Klasse.
 * ============================================================================
 * P1-2 (D8): „Erst CSS-Variablen-Themes komplett & sauber umsetzen.“
 *
 * Alle Farbwerte liegen AUSSCHLIESSLICH in `src/index.css` unter
 * `.monk-theme-<id> { --monk-accent: …; --monk-accent-rgb: …; }`.
 * Dieses Modul enthält bewusst KEINE Hex-Werte, damit keine plugin-lokalen
 * Farb-Duplikate entstehen (Design-Token-Regel (siehe MASTERTODOENDE.json)).
 * ============================================================================
 */

/** Verbindliche Reihenfolge (ARCH-PLUGIN-001: 16 MONKs + System-Module). */
export const PLUGIN_THEME_IDS = [
  'mixer',
  'drop',
  'song',
  'effect',
  'syntisampler',
  'drumsampler',
  'instru',
  'biblio',
  'voice',
  'sound',
  'stem',
  'spatial',
  'eq',
  'dsp',
  'master',
  'record',
  'ai',
  'perfor',
] as const;

export type PluginThemeId = (typeof PLUGIN_THEME_IDS)[number];

/** Hardware-/Referenz-Look je Plugin (für Skin-Ausbau und Screenshot-Vergleich). */
export const PLUGIN_SKIN_REFERENCES: Record<PluginThemeId, string> = {
  mixer: 'Pioneer DJM-A9 / Allen & Heath XONE',
  drop: 'Drop-/Clip-Launcher',
  song: 'Song-/Track-Composer (Vocal-Song-Studio)',
  effect: 'FX-Rack (Multi-Effekt)',
  syntisampler: 'MiniMoog / Prophet + SP-404 / MPC-Sampler',
  drumsampler: 'TR-808 / Dirtywave M8',
  instru: 'Instrument-Canvas (GarageBand-artig, Touch)',
  biblio: 'biblioMONK-Library',
  voice: 'Mikrofon-/Voice-Chain',
  sound: 'Sound-Design-Pad',
  stem: 'Stem-Separation',
  spatial: '3D-Panner (High-End-Controller)',
  eq: 'API 550 / SSL (EQ)',
  dsp: 'DSP-Kern (Filter/Dynamics)',
  master: 'TC Electronic / Massey (Mastering)',
  record: 'Recorder/Transport',
  ai: 'aiMONK (MOA/MCP)',
  perfor: 'Performance-Monitor (Gauges)',
};

export const DEFAULT_THEME_CLASS = 'monk-theme-masterplayer';

/** Liefert die CSS-Theme-Klasse für eine Plugin-ID (mit Fallback). */
export function getPluginThemeClass(id: string | undefined | null): string {
  if (id && (PLUGIN_THEME_IDS as readonly string[]).includes(id)) {
    return `monk-theme-${id}`;
  }
  return DEFAULT_THEME_CLASS;
}

/** Liefert die Referenz-Hardware für eine Plugin-ID (Fallback: eigener Name). */
export function getPluginSkinReference(id: string | undefined | null): string {
  if (id && id in PLUGIN_SKIN_REFERENCES) {
    return PLUGIN_SKIN_REFERENCES[id as PluginThemeId];
  }
  return 'Eigenes Theme';
}

/**
 * P1-2 Hardware-Skins: pro Plugin eine Hardware-Look-Klasse, die in
 * `src/index.css` (`.hw-skin-*`) Material-/Knob-/Fader-Optik nachzieht.
 * Die konkreten Farben kommen weiterhin aus den `.monk-theme-*`-Variablen –
 * die Skin-Klasse steuert nur Textur/Stil (Panel-Kante, Knob-Ring, Fader).
 */
const HARDWARE_SKIN_IDS: readonly string[] = [
  'mixer', 'syntisampler', 'drumsampler', 'eq', 'master', 'spatial',
];

export function getHardwareSkinClass(id: string | undefined | null): string {
  if (id && HARDWARE_SKIN_IDS.includes(id)) {
    return `hw-skin-${id}`;
  }
  return '';
}
