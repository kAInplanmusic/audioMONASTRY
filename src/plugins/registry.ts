import { 
  Sliders, Keyboard, Grid3X3, Box, Music, Speaker, Sparkles, Waves, 
  Mic, Layers, Radio, Database, Activity, Zap, Cpu, Square, Gauge, Bot, AudioLines
} from 'lucide-react';
// Lazy-Code-Splitting: Jedes Terminal wird erst beim Aktivieren geladen
// (reduziert das Hauptbundle erheblich; Vite erzeugt eigene Chunks).
import { lazy } from 'react';
const InstrumentsTerminal = lazy(() => import('../components/InstrumentsTerminal').then(m => ({ default: m.InstrumentsTerminal })));
const SynthesizerTerminal = lazy(() => import('../components/SynthesizerTerminal').then(m => ({ default: m.SynthesizerTerminal })));
const DrumMachineTerminal = lazy(() => import('../components/DrumMachineTerminal').then(m => ({ default: m.DrumMachineTerminal })));
const SamplerTerminal = lazy(() => import('../components/SamplerTerminal').then(m => ({ default: m.SamplerTerminal })));
const McpTerminal = lazy(() => import('../components/McpTerminal').then(m => ({ default: m.McpTerminal })));
const VoiceGenTerminal = lazy(() => import('../components/VoiceGenTerminal').then(m => ({ default: m.VoiceGenTerminal })));
const SoundTerminal = lazy(() => import('../components/SoundTerminal').then(m => ({ default: m.SoundTerminal })));
const SongMonkTerminal = lazy(() => import('../components/SongMonkTerminal').then(m => ({ default: m.SongMonkTerminal })));
const DJ4ChMixer = lazy(() => import('../components/DJ4ChMixer').then(m => ({ default: m.DJ4ChMixer })));
const MIDIControllerTerminal = lazy(() => import('../components/MIDIControllerTerminal').then(m => ({ default: m.MIDIControllerTerminal })));
const FXEngineTerminal = lazy(() => import('../components/FXEngineTerminal').then(m => ({ default: m.FXEngineTerminal })));
const DropTerminal = lazy(() => import('../components/DropTerminal').then(m => ({ default: m.DropTerminal })));
const LibraryTerminal = lazy(() => import('../components/LibraryTerminal').then(m => ({ default: m.LibraryTerminal })));
const EQPluginTerminal = lazy(() => import('../components/EQPluginTerminal').then(m => ({ default: m.EQPluginTerminal })));
const DSPTerminal = lazy(() => import('../components/DSPTerminal').then(m => ({ default: m.DSPTerminal })));
const MasteringOverlay = lazy(() => import('../components/MasteringOverlay').then(m => ({ default: m.MasteringOverlay })));
const StemExtractorTerminal = lazy(() => import('../components/StemExtractorTerminal').then(m => ({ default: m.StemExtractorTerminal })));
const SpatialScene = lazy(() => import('../components/SpatialScene').then(m => ({ default: m.SpatialScene })));
const RecorderTerminal = lazy(() => import('../components/RecorderTerminal').then(m => ({ default: m.RecorderTerminal })));
const PerformanceMonitorTerminal = lazy(() => import('../components/PerformanceMonitorTerminal').then(m => ({ default: m.PerformanceMonitorTerminal })));
const AiMonkTerminal = lazy(() => import('../components/AiMonkTerminal').then(m => ({ default: m.AiMonkTerminal })));

const ICON_MAP: Record<string, any> = {
  Sliders, Keyboard, Grid3X3, Box, Music, Speaker, Sparkles, Waves, 
  Mic, Layers, Radio, Database, Activity, Zap, Cpu, Square, Gauge, Bot, AudioLines
};

// ============================================================================
// Plugin-Reihenfolge (verbindlich):
//   0 instrument · 1 synthesizer · 2 drum · 3 sampler
//   4 mcp · 5 voice · 6 sound · 7 song · 8 mixer · 9 controller · 10 effect
//   11 drop · 12 library · 13 eq · 14 dsp · 15 mastering · 16 stem
//   17 spatial · 18 recording · 19 performance · 20 ai
// masterplayerMONK ist KEIN Plugin, sondern feste View-only-Leiste (App.tsx).
// visMONK wurde entfernt; seine Signal-Anzeige ist in perfMONK integriert.
// ============================================================================
const COMPONENT_MAP: Record<string, any> = {
  instrument: InstrumentsTerminal,
  synthesizer: SynthesizerTerminal,
  drum: DrumMachineTerminal,
  sampler: SamplerTerminal,
  mcp: McpTerminal,
  voice: VoiceGenTerminal,
  sound: SoundTerminal,
  song: SongMonkTerminal,
  mixer: DJ4ChMixer,
  controller: MIDIControllerTerminal,
  effect: FXEngineTerminal,
  drop: DropTerminal,
  library: LibraryTerminal,
  eq: EQPluginTerminal,
  dsp: DSPTerminal,
  mastering: MasteringOverlay,
  stem: StemExtractorTerminal,
  spatial: SpatialScene,
  recording: RecorderTerminal,
  performance: PerformanceMonitorTerminal,
  ai: AiMonkTerminal,
};

// ============================================================================
// Task 21: Modul-Zusammenführung – Aliase für Konsolidierung
// ----------------------------------------------------------------------------
// Gruppen, deren Module zu einem "Metamodul" zusammengefasst werden können:
//  - Verarbeitungskette: dsp + eq + effect  → primärer Kern: 'effect'
//  - Klangerzeugung:     synth + instrument → primärer Kern: 'instrument'
//  - Signalquelle:       recorder + voice   → primärer Kern: 'recording'
// resolveComponent(id) liefert die ERSTE primäre Komponente der Gruppe, sodass
// beim Zusammenführen nur ein Terminal gerendert wird.
// ============================================================================

/** Gruppen mit ihren Mitgliedern und dem primären (verbleibenden) Modul. */
export const METAMODULE_GROUPS: { group: string; members: string[]; primary: string }[] = [
  { group: 'process', members: ['dsp', 'eq', 'effect'], primary: 'effect' },
  { group: 'sound',   members: ['synthesizer', 'instrument'],  primary: 'instrument' },
  { group: 'source',  members: ['recording', 'voice'],   primary: 'recording' },
];

/** Mappt ein Modul auf seinen primären Gruppenvorsteher. */
export function resolvePrimaryModule(id: string): string {
  const g = METAMODULE_GROUPS.find(x => x.members.includes(id));
  return g ? g.primary : id;
}

/** Führt für ein Modul die richtige Render-Komponente auf (Merge-bewusst). */
export function resolveComponent(id: string): any {
  return COMPONENT_MAP[resolvePrimaryModule(id)] ?? COMPONENT_MAP[id];
}

const DEFAULT_PLUGIN_METADATA: Record<string, { name: string; short: string; icon: string }> = {
  instrument: { name: 'instrumentMONK', short: 'INS', icon: 'Music' },
  synthesizer: { name: 'synthesizerMONK', short: 'SYN', icon: 'Waves' },
  drum: { name: 'drumMONK', short: 'DRM', icon: 'Speaker' },
  sampler: { name: 'samplerMONK', short: 'SAM', icon: 'Speaker' },
  mcp: { name: 'mcpMONK', short: 'MCP', icon: 'Grid3X3' },
  voice: { name: 'voiceMONK', short: 'VOX', icon: 'Mic' },
  sound: { name: 'soundMONK', short: 'SND', icon: 'AudioLines' },
  song: { name: 'songMONK', short: 'SNG', icon: 'Music' },
  mixer: { name: 'mixerMONK', short: 'MIX', icon: 'Sliders' },
  controller: { name: 'controllerMONK', short: 'CTRL', icon: 'Keyboard' },
  effect: { name: 'effectMONK', short: 'FX', icon: 'Sparkles' },
  drop: { name: 'dropMONK', short: 'DRP', icon: 'Zap' },
  library: { name: 'biblioMONK', short: 'LIB', icon: 'Database' },
  eq: { name: 'eqMONK', short: 'EQ', icon: 'Activity' },
  dsp: { name: 'dspMONK', short: 'DSP', icon: 'Cpu' },
  mastering: { name: 'masteringMONK', short: 'MST', icon: 'Square' },
  stem: { name: 'stemMONK', short: 'RMX', icon: 'Radio' },
  spatial: { name: 'spatialMONK', short: '3D', icon: 'Box' },
  recording: { name: 'recordingMONK', short: 'REC', icon: 'Activity' },
  performance: { name: 'perfMONK', short: 'PRF', icon: 'Gauge' },
  ai: { name: 'aiMONK', short: 'AI', icon: 'Bot' },
};

const EXPECTED_PLUGIN_COUNT = 21;

const createFallbackRegistry = () =>
  Object.keys(COMPONENT_MAP).map((id) => {
    const metadata = DEFAULT_PLUGIN_METADATA[id] || {
      name: `${id}MONK`,
      short: id.substring(0, 3).toUpperCase(),
      icon: 'Cpu',
    };
    return {
      id,
      name: metadata.name,
      short: metadata.short,
      icon: ICON_MAP[metadata.icon] || Cpu,
      component: COMPONENT_MAP[id],
    };
  });

let _pluginRegistry: readonly any[] = [];

/** Read-only accessor – einzige, immutable Registry-Quelle. */
export const getPluginRegistry = (): readonly any[] => _pluginRegistry;

export const discoverPlugins = async () => {
    try {
        const response = await fetch('/plugin-manifest.json');
        const manifest = await response.json();
        
        if (Array.isArray(manifest.ui_plugins)) {
            const discoveredPlugins = manifest.ui_plugins.map((p: any) => ({
                ...p,
                icon: ICON_MAP[p.icon] || Cpu,
                component: COMPONENT_MAP[p.id]
            })).filter((p: any) => p.component);

            if (discoveredPlugins.length === EXPECTED_PLUGIN_COUNT) {
                _pluginRegistry = Object.freeze(discoveredPlugins);
                return _pluginRegistry;
            }
             
            console.warn(
                `Plugin manifest mismatch: expected ${EXPECTED_PLUGIN_COUNT}, got ${discoveredPlugins.length}. Falling back to built-in registry.`,
            );
        }
    } catch (error) {
        console.error("Failed to discover plugins:", error);
    }
    const fallback = Object.freeze(createFallbackRegistry());
    _pluginRegistry = fallback;
    return _pluginRegistry;
};

// Initial synchronous population
const _initial = createFallbackRegistry();
_pluginRegistry = Object.freeze(_initial);
