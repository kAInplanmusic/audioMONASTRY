/**
 * pluginTheme – zentrale Zuordnung Plugin-ID → CSS-Theme-Klasse.
 * ============================================================================
 * P1-2 (D8): „Erst CSS-Variablen-Themes komplett & sauber umsetzen.“
 *
 * Alle Farbwerte liegen AUSSCHLIESSLICH in `src/index.css` unter
 * `.monk-theme-<id> { --monk-accent: …; --monk-accent-rgb: …; }`.
 * Dieses Modul enthält bewusst KEINE Hex-Werte, damit keine plugin-lokalen
 * Farb-Duplikate entstehen (Design-Token-Regel aus MASTER_TODO P1-2).
 * ============================================================================
 */

/** Verbindliche Reihenfolge (siehe `src/plugins/registry.ts`). */
export const PLUGIN_THEME_IDS = [
  'masterplayer',
  'instrument',
  'synthesizer',
  'drum',
  'sampler',
  'mcp',
  'voice',
  'sound',
  'mixer',
  'controller',
  'effect',
  'drop',
  'library',
  'eq',
  'dsp',
  'mastering',
  'stem',
  'spatial',
  'recording',
  'performance',
  'ai',
] as const;

export type PluginThemeId = (typeof PLUGIN_THEME_IDS)[number];

/** Hardware-/Referenz-Look je Plugin (für Skin-Ausbau und Screenshot-Vergleich). */
export const PLUGIN_SKIN_REFERENCES: Record<PluginThemeId, string> = {
  masterplayer: 'Master-Transport (Brand: Teal/Cyan)',
  instrument: 'Instrument-Canvas (GarageBand-artig, Touch)',
  synthesizer: 'MiniMoog / Prophet / Juno (Analog-Synth)',
  drum: 'TR-808 / Dirtywave M8',
  sampler: 'SP-404 / MPC-Sampler',
  mcp: 'Akai MPC (Pads + Step-Sequencer)',
  voice: 'Mikrofon-/Voice-Chain',
  sound: 'Sound-Design-Pad',
  mixer: 'Pioneer DJM-A9 / Allen & Heath XONE',
  controller: 'MIDI-/HID-Controller',
  effect: 'FX-Rack (Multi-Effekt)',
  drop: 'Drop-/Clip-Launcher',
  library: 'biblioMONK-Library',
  eq: 'API 550 / SSL (EQ)',
  dsp: 'DSP-Kern (Filter/Dynamics)',
  mastering: 'TC Electronic / Massey (Mastering)',
  stem: 'Stem-Separation',
  spatial: '3D-Panner (High-End-Controller)',
  recording: 'Recorder/Transport',
  performance: 'Performance-Monitor (Gauges)',
  ai: 'aiMONK (MOA/MCP)',
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
  'mixer', 'synthesizer', 'drum', 'eq', 'mastering', 'spatial', 'mcp', 'sampler',
];

export function getHardwareSkinClass(id: string | undefined | null): string {
  if (id && HARDWARE_SKIN_IDS.includes(id)) {
    return `hw-skin-${id}`;
  }
  return '';
}
