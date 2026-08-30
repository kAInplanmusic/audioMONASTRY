import { 
  Sliders, Keyboard, Grid3X3, Box, Music, Speaker, Sparkles, Waves, 
  Mic, Layers, Radio, Database, Activity, Zap, Cpu, Square, Gauge 
} from 'lucide-react';
// Lazy-Code-Splitting: Jedes Terminal wird erst beim Aktivieren geladen
// (reduziert das Hauptbundle erheblich; Vite erzeugt eigene Chunks).
import { lazy } from 'react';
const MischpultTerminal = lazy(() => import('../components/MischpultTerminal').then(m => ({ default: m.MischpultTerminal })));
const SequencerPluginTerminal = lazy(() => import('../components/SequencerPluginTerminal').then(m => ({ default: m.SequencerPluginTerminal })));
const LibraryTerminal = lazy(() => import('../components/LibraryTerminal').then(m => ({ default: m.LibraryTerminal })));
const DrumMachineTerminal = lazy(() => import('../components/DrumMachineTerminal').then(m => ({ default: m.DrumMachineTerminal })));
const InstrumentsTerminal = lazy(() => import('../components/InstrumentsTerminal').then(m => ({ default: m.InstrumentsTerminal })));
const SpatialPluginTerminal = lazy(() => import('../components/SpatialPluginTerminal').then(m => ({ default: m.SpatialPluginTerminal })));
const EQPluginTerminal = lazy(() => import('../components/EQPluginTerminal').then(m => ({ default: m.EQPluginTerminal })));
const MasteringOverlay = lazy(() => import('../components/MasteringOverlay').then(m => ({ default: m.MasteringOverlay })));
const MIDIControllerTerminal = lazy(() => import('../components/MIDIControllerTerminal').then(m => ({ default: m.MIDIControllerTerminal })));
const FXEngineTerminal = lazy(() => import('../components/FXEngineTerminal').then(m => ({ default: m.FXEngineTerminal })));
const StemExtractorTerminal = lazy(() => import('../components/StemExtractorTerminal').then(m => ({ default: m.StemExtractorTerminal })));
const VoiceGenTerminal = lazy(() => import('../components/VoiceGenTerminal').then(m => ({ default: m.VoiceGenTerminal })));
const RecorderTerminal = lazy(() => import('../components/RecorderTerminal').then(m => ({ default: m.RecorderTerminal })));
const DSPTerminal = lazy(() => import('../components/DSPTerminal').then(m => ({ default: m.DSPTerminal })));
const VisualizerTerminal = lazy(() => import('../components/VisualizerTerminal').then(m => ({ default: m.VisualizerTerminal })));
const SamplerTerminal = lazy(() => import('../components/SamplerTerminal').then(m => ({ default: m.SamplerTerminal })));
const SynthesizerTerminal = lazy(() => import('../components/SynthesizerTerminal').then(m => ({ default: m.SynthesizerTerminal })));
const PerformanceMonitorTerminal = lazy(() => import('../components/PerformanceMonitorTerminal').then(m => ({ default: m.PerformanceMonitorTerminal })));

const ICON_MAP: Record<string, any> = {
  Sliders, Keyboard, Grid3X3, Box, Music, Speaker, Sparkles, Waves, 
  Mic, Layers, Radio, Database, Activity, Zap, Cpu, Square, Gauge
};

const COMPONENT_MAP: Record<string, any> = {
  mixer: MischpultTerminal,
  controller: MIDIControllerTerminal,
  sequencer: SequencerPluginTerminal,
  spatial: SpatialPluginTerminal,
  instrument: InstrumentsTerminal,
  drum: DrumMachineTerminal,
  effect: FXEngineTerminal,
  synth: SynthesizerTerminal,
  voice: VoiceGenTerminal,
  visualizer: VisualizerTerminal,
  sampler: SamplerTerminal,
  stem: StemExtractorTerminal,
  recording: RecorderTerminal,
  library: LibraryTerminal,
  eq: EQPluginTerminal,
  dsp: DSPTerminal,
  mastering: MasteringOverlay,
  performance: PerformanceMonitorTerminal
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
  { group: 'sound',   members: ['synth', 'instrument'],  primary: 'instrument' },
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
  mixer: { name: 'mixerMONK', short: 'MIX', icon: 'Sliders' },
  controller: { name: 'controllerMONK', short: 'CTRL', icon: 'Keyboard' },
  sequencer: { name: 'sequencerMONK', short: 'SEQ', icon: 'Grid3X3' },
  spatial: { name: 'spatialMONK', short: '3D', icon: 'Box' },
  instrument: { name: 'instrumentMONK', short: 'INS', icon: 'Music' },
  drum: { name: 'drumMONK', short: 'DRM', icon: 'Speaker' },
  effect: { name: 'effectMONK', short: 'FX', icon: 'Sparkles' },
  synth: { name: 'synthesizerMONK', short: 'SYN', icon: 'Waves' },
  voice: { name: 'voiceMONK', short: 'VOX', icon: 'Mic' },
  visualizer: { name: 'visMONK', short: 'VIS', icon: 'Activity' },
  sampler: { name: 'samplerMONK', short: 'SAM', icon: 'Speaker' },
  stem: { name: 'stemMONK', short: 'RMX', icon: 'Radio' },
  recording: { name: 'recordingMONK', short: 'REC', icon: 'Activity' },
  library: { name: 'biblioMONK', short: 'LIB', icon: 'Database' },
  eq: { name: 'eqMONK', short: 'EQ', icon: 'Activity' },
  mastering: { name: 'masteringMONK', short: 'MST', icon: 'Square' },
  performance: { name: 'perfMONK', short: 'PRF', icon: 'Gauge' },
};

const EXPECTED_PLUGIN_COUNT = 17;

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
