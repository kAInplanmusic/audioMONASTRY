/**
 * audioMONASTRY · VisualMONK: Phasen-Makros
 * =========================================
 * Aus dem Konzept „Ritual": Ein Befehl (Aufbau, Trance, Höhepunkt, Auflösung) schaltet Preset, Überblendzeit, Standzeit,
 * Schwellen, Taktbindung und Effektzahl gemeinsam um. Quelle für Szene (TypeScript) und Pod (Python): `npm run build:vis-scene`
 * schreibt daraus `services/audiomonastry-ai-runtime/visual/phases.json`.
 */
import type { ShowOptions } from './showOrchestrator';

export interface VisPhase {
  id: string;
  label: string;
  /** Preset der Szene (siehe visualPresets). */
  presetId: string;
  show: Required<Pick<ShowOptions, 'minDwellS' | 'fadeS' | 'onsetThreshold' | 'energyJump' | 'quantize'>>;
  /** Obergrenze gleichzeitiger Effekte im Regie-Modus. */
  maxEffects: number;
}

export const PHASES: readonly VisPhase[] = [
  { id: 'build', label: 'Aufbau', presetId: 'starfield', maxEffects: 1,
    show: { minDwellS: 10, fadeS: 3, onsetThreshold: 0.9, energyJump: 0.5, quantize: 'bar' } },
  { id: 'trance', label: 'Trance', presetId: 'psy', maxEffects: 2,
    show: { minDwellS: 7, fadeS: 2, onsetThreshold: 0.82, energyJump: 0.4, quantize: 'bar' } },
  { id: 'peak', label: 'Höhepunkt', presetId: 'inferno', maxEffects: 4,
    show: { minDwellS: 3, fadeS: 0.4, onsetThreshold: 0.6, energyJump: 0.25, quantize: 'beat' } },
  { id: 'release', label: 'Auflösung', presetId: 'liquid', maxEffects: 1,
    show: { minDwellS: 12, fadeS: 4, onsetThreshold: 0.95, energyJump: 0.6, quantize: 'bar' } },
];

export const PHASE_IDS: readonly string[] = PHASES.map((phase) => phase.id);

export function phaseById(id: string | null | undefined): VisPhase | undefined {
  return PHASES.find((phase) => phase.id === id);
}
