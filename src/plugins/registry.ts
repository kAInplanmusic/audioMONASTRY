import { 
  Sliders, Keyboard, Grid3X3, Box, Music, Speaker, Sparkles, Waves, 
  Mic, Layers, Radio, Database, Activity, Zap, Cpu, Square, Gauge, Bot, AudioLines
} from 'lucide-react';
// Lazy-Code-Splitting: Jedes Terminal wird erst beim Aktivieren geladen
// (reduziert das Hauptbundle erheblich; Vite erzeugt eigene Chunks).
import { lazy } from 'react';
const SyntiSamplerTerminal = lazy(() => import('../components/SyntiSamplerTerminal').then(m => ({ default: m.SyntiSamplerTerminal })));
const DrumMachineTerminal = lazy(() => import('../components/DrumMachineTerminal').then(m => ({ default: m.DrumMachineTerminal })));
const InstrumentsTerminal = lazy(() => import('../components/InstrumentsTerminal').then(m => ({ default: m.InstrumentsTerminal })));
const VoiceGenTerminal = lazy(() => import('../components/VoiceGenTerminal').then(m => ({ default: m.VoiceGenTerminal })));
const SoundTerminal = lazy(() => import('../components/SoundTerminal').then(m => ({ default: m.SoundTerminal })));
const SongMonkTerminal = lazy(() => import('../components/SongMonkTerminal').then(m => ({ default: m.SongMonkTerminal })));
const DJ4ChMixer = lazy(() => import('../components/DJ4ChMixer').then(m => ({ default: m.DJ4ChMixer })));
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
// 16-MONK-REGISTRY (verbindliche Zielarchitektur, ARCH-PLUGIN-001)
// ----------------------------------------------------------------------------
// Reihenfolge + Kategorien:
//   DJ:        mixer(1) · drop(2) · song(3) · effect(4)
//   PRODUCING: syntisampler(5) · drumsampler(6) · instru(7) · biblio(8)
//   AI:        voice(9) · sound(10) · stem(11) · spatial(12)
//   MASTERING: eq(13) · dsp(14) · master(15) · record(16)
//
// System-Module (KEINE Plugins, nicht in dieser Registry):
//   masterplayerMONK (nach Head, fest) · aiMONK (nach recordMONK) ·
//   perforMONK (ganz unten). MIDI/Controller läuft über Settings.
//
// Konsolidierung (Migration-Matrix in TODO.md):
//   synthesizer + sampler + mcp(Synth/Sampler-Steuerung) → syntisampler
//   drum (+ Drum-Sampling)                              → drumsampler
//   instrument                                           → instru
//   library                                              → biblio
//   mastering                                            → master
//   recording                                            → record
//   controller/perf                                      → Settings/perforMONK (System)
// ============================================================================
const COMPONENT_MAP: Record<string, any> = {
  mixer: DJ4ChMixer,
  drop: DropTerminal,
  song: SongMonkTerminal,
  effect: FXEngineTerminal,
  syntisampler: SyntiSamplerTerminal,
  drumsampler: DrumMachineTerminal,
  instru: InstrumentsTerminal,
  biblio: LibraryTerminal,
  voice: VoiceGenTerminal,
  sound: SoundTerminal,
  stem: StemExtractorTerminal,
  spatial: SpatialScene,
  eq: EQPluginTerminal,
  dsp: DSPTerminal,
  master: MasteringOverlay,
  record: RecorderTerminal,
};

/** System-Module (bewusst außerhalb der 16er-Registry). */
export const SYSTEM_MODULES = {
  masterplayer: { name: 'masterplayerMONK', short: 'MPL', icon: 'Activity', component: null },
  ai: { name: 'aiMONK', short: 'AI', icon: 'Bot', component: AiMonkTerminal },
  perfor: { name: 'perforMONK', short: 'PRF', icon: 'Gauge', component: PerformanceMonitorTerminal },
} as const;

export function resolveComponent(id: string): any {
  return COMPONENT_MAP[id];
}

const DEFAULT_PLUGIN_METADATA: Record<string, { name: string; short: string; icon: string }> = {
  mixer: { name: 'mixerMONK', short: 'MIX', icon: 'Sliders' },
  drop: { name: 'dropMONK', short: 'DRP', icon: 'Zap' },
  song: { name: 'songMONK', short: 'SNG', icon: 'Music' },
  effect: { name: 'effectMONK', short: 'FX', icon: 'Sparkles' },
  syntisampler: { name: 'syntisamplerMONK', short: 'SYSA', icon: 'Waves' },
  drumsampler: { name: 'drumsamplerMONK', short: 'DRSA', icon: 'Speaker' },
  instru: { name: 'instruMONK', short: 'INS', icon: 'Music' },
  biblio: { name: 'biblioMONK', short: 'LIB', icon: 'Database' },
  voice: { name: 'voiceMONK', short: 'VOX', icon: 'Mic' },
  sound: { name: 'soundMONK', short: 'SND', icon: 'AudioLines' },
  stem: { name: 'stemMONK', short: 'RMX', icon: 'Radio' },
  spatial: { name: 'spatialMONK', short: '3D', icon: 'Box' },
  eq: { name: 'eqMONK', short: 'EQ', icon: 'Activity' },
  dsp: { name: 'dspMONK', short: 'DSP', icon: 'Cpu' },
  master: { name: 'masterMONK', short: 'MST', icon: 'Square' },
  record: { name: 'recordMONK', short: 'REC', icon: 'Activity' },
};

const EXPECTED_PLUGIN_COUNT = 16;

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
