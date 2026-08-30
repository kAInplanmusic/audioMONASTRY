import { ModuleState } from '../context/ModuleStateContext';

// ============================================================================
// Task 22: UX/Onboarding + Rollen-Start-Presets
// ----------------------------------------------------------------------------
// Vier Rollen für den Workflow-Onboarding (analog zu B2B-Sessions):
//  DJ · Producer · Sound Engineer · STEM-Host. Jede Rolle definiert den
//  Start-Zustand: aktivierte Module, Start-Preset (Grundschlag), Monitor-Bus
//  (Cue) und eine Onboarding-Hinweisliste.
// ============================================================================

export type StudioRole = 'DJ' | 'PRODUCER' | 'ENGINEER' | 'STEM_HOST';

export interface RolePreset {
  role: StudioRole;
  /** Vortänzer-Start-Preset (ID eines Gegenstandes aus presets.ts) */
  startPresetId?: string;
  /** Welche Module anfänglich aktiv sind */
  activeModules: string[];
  /** Monitor-/Cue-Kanal dieser Rolle */
  monitor: 'MON1'|'MON2'|'MON3'|'MON4';
  /** Meta-Konfig für die Module (Token/Fokus) */
  hint: string;
}

export const ROLE_PRESETS: RolePreset[] = [
  {
    role: 'DJ',
    startPresetId: 'psy',
    activeModules: ['sequencer','drum','synth','controller','mixer'],
    monitor: 'MON1',
    hint: 'Fokus: Loops + Cue-Mixe live. Drum- u. Sequencer-Module aktiv.',
  },
  {
    role: 'PRODUCER',
    startPresetId: 'goa',
    activeModules: ['sequencer', 'drum', 'synth', 'instrument', 'effect', 'mixer', 'recording'],
    monitor: 'MON2',
    hint: 'Fokus: Sounddesign + Arrangement. Instrument/synth + Effekte aktiv.',
  },
  {
    role: 'ENGINEER',
    startPresetId: 'industrial',
    activeModules: ['eq', 'dsp', 'mastering', 'mixer', 'visualizer', 'spatial'],
    monitor: 'MON3',
    hint: 'Fokus: Metering/Summing. EQ, DSP, Mastering, Spatial aktiv.',
  },
  {
    role: 'STEM_HOST',
    startPresetId: 'tekk',
    activeModules: ['stem', 'library', 'drum', 'mixer', 'recording'],
    monitor: 'MON4',
    hint: 'Fokus: Stem-Pakete + Bibliothek. Stems/Drum+Samples aktiv.',
  },
];

/** Liest Eine Rolle und die dazugehörige Tooltip-Konfiguration als Onboarding. */
export function getRolePreset(role: StudioRole): RolePreset {
  return ROLE_PRESETS.find(r => r.role === role) ?? ROLE_PRESETS[0];
}

/** Wendet ein Rollen-Preset auf den Modul-Zustand an (alle außer genannten OFF). */
export function moduleStateForRole(role: StudioRole, allModules: string[]): Record<string, ModuleState> {
  const preset = getRolePreset(role);
  const out: Record<string, ModuleState> = {};
  allModules.forEach(m => { out[m] = preset.activeModules.includes(m) ? 'PRO' : 'OFF'; });
  return out;
}
