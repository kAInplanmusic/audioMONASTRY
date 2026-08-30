import { z } from 'zod';
import { TRACK_ROLE_MAP, TrackRole, ALL_ROLES, emptyPatterns } from '../types';


export const PresetSchema = z.object({
  global: z.object({
    tempo: z.number().min(30).max(300).optional(),
    masterVolume: z.number().min(-100).max(0).optional(),
  }).optional(),
  tracks: z.array(z.object({
    id: z.string(),
    instrument: z.string(),
    params: z.record(z.string(), z.any()).optional(),
    effects: z.array(z.object({
      type: z.string(),
      params: z.record(z.string(), z.any()).optional()
    })).optional(),
    output: z.string(),
    patterns: z.array(z.boolean()).optional()
  })).optional(),
  buses: z.array(z.object({
    id: z.string(),
    effects: z.array(z.object({
      type: z.string(),
      params: z.record(z.string(), z.any()).optional()
    })).optional(),
    output: z.string()
  })).optional(),
  connections: z.array(z.object({
    source: z.string(),
    destination: z.string()
  })).optional()
});

export const GeminiPresetSchema = z.object({
  name: z.string().optional(),
  bpm: z.number().min(60).max(250),
  cutoff: z.number().min(20).max(20000),
  resonance: z.number().min(0).max(20),
  decay: z.number().min(0).max(1),
  engine: z.enum(['SUBTRACTIVE', 'FM', 'WAVETABLE']).optional(),
  patterns: z.record(z.string(), z.array(z.boolean()).length(16)).optional(),
  synthNotes: z.array(z.number()).length(16).optional()
});

export type Preset = z.infer<typeof PresetSchema>;
export type GeminiPreset = z.infer<typeof GeminiPresetSchema>;

export function validatePreset(data: unknown): Preset {
  return PresetSchema.parse(data);
}

export function validateGeminiPreset(data: unknown): GeminiPreset {
  return GeminiPresetSchema.parse(data);
}


// --- Track-Role-Validierung (einheitliches Datenmodell) ---
export const TRACK_ROLE_ORDER: TrackRole[] = [...ALL_ROLES];

/**
 * Prüft, dass Patterns die erwartete Spurenstruktur haben und jede Spur
 * den semantischen Rollen zugeordnet ist (channel1..channel8).
 */
export function validateTrackPreset(patterns: unknown): boolean {
  if (!patterns || typeof patterns !== 'object') return false;
  const p = patterns as Record<string, unknown>;
  for (const track of Object.keys(TRACK_ROLE_MAP)) {
    const steps = p[track];
    if (!Array.isArray(steps) || steps.length !== 16) {
      return false;
    }
    if (!steps.every(s => typeof s === 'boolean')) return false;
  }
  return true;
}

/** Stellt sicher, dass Patterns vollständig (alle 8 Spuren à 16 Steps) sind. */
export function normalizePatterns(input: unknown): Record<string, boolean[]> {
  const base = emptyPatterns();
  if (!input || typeof input !== 'object') return base as unknown as Record<string, boolean[]>;
  const asRecord = input as Record<string, unknown>;
  for (const track of Object.keys(base) as (keyof typeof base)[]) {
    if (Array.isArray(asRecord[track])) {
      const arr = asRecord[track] as unknown[];
      base[track] = arr.slice(0, 16).map(v => !!v);
      while (base[track].length < 16) base[track].push(false);
    }
  }
  return base as unknown as Record<string, boolean[]>;
}
