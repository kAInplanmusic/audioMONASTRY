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
    activeModules: ['mixer', 'drop', 'song', 'effect'],
    monitor: 'MON1',
    hint: 'Fokus: DJ-Set live – Mixer, Drops, Song, FX.',
  },
  {
    role: 'PRODUCER',
    startPresetId: 'goa',
    activeModules: ['syntisampler', 'drumsampler', 'instru', 'biblio', 'effect', 'record'],
    monitor: 'MON2',
    hint: 'Fokus: Sounddesign + Arrangement – Synth/Sampler, Drums, Instrumente, Bibliothek.',
  },
  {
    role: 'ENGINEER',
    startPresetId: 'industrial',
    activeModules: ['eq', 'dsp', 'master', 'spatial', 'mixer', 'record'],
    monitor: 'MON3',
    hint: 'Fokus: Summing/Metering – EQ, DSP, Mastering, Spatial, Mixer.',
  },
  {
    role: 'STEM_HOST',
    startPresetId: 'tekk',
    activeModules: ['stem', 'biblio', 'drumsampler', 'mixer', 'record'],
    monitor: 'MON4',
    hint: 'Fokus: Stem-Pakete + Bibliothek – Stems, Drums/Samples, Mixer.',
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
