// src/utils/validation.ts – ohne zod (Bundle-Diät P2-5)
// Manuelle, schlanke Validierung für Track-Presets. API-kompatibel zu zod:
// TrackPresetSchema.parse / TrackPresetSchema.safeParse.

export interface TrackPreset {
  id: string;
  name: string;
  genre: string;
  bpm: number;
  key: string;
  description: string;
  patterns: Record<string, boolean[]>;
  synthNotes: number[];
  cutoff: number;
  resonance: number;
  delayTime: number;
  decay: number;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function isStr(v: unknown): v is string {
  return typeof v === 'string';
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

export const TrackPresetSchema = {
  parse(data: unknown): TrackPreset {
    const result = TrackPresetSchema.safeParse(data);
    if (result.success) return result.data;
    throw (result as { success: false; error: Error }).error;
  },

  safeParse(data: unknown): { success: true; data: TrackPreset } | { success: false; error: Error } {
    const fail = (msg: string) => ({ success: false as const, error: new Error(msg) });
    if (!isObj(data)) return fail('Track-Preset muss ein Objekt sein');
    const { id, name, genre, bpm, key, description, patterns, synthNotes, cutoff, resonance, delayTime, decay } = data;
    if (!isStr(id) || !isStr(name) || !isStr(genre) || !isStr(key) || !isStr(description)) {
      return fail('id/name/genre/key/description müssen Strings sein');
    }
    if (!isNum(bpm) || bpm < 60 || bpm > 250) return fail('bpm muss 60..250 sein');
    if (!isObj(patterns)) return fail('patterns fehlt');
    for (let i = 1; i <= 8; i++) {
      const ch = `channel${i}`;
      if (!Array.isArray(patterns[ch])) return fail(`patterns.${ch} fehlt`);
    }
    if (!Array.isArray(synthNotes) || !synthNotes.every((n) => isNum(n))) return fail('synthNotes muss number[] sein');
    if (!isNum(cutoff) || cutoff < 20 || cutoff > 20000) return fail('cutoff muss 20..20000 sein');
    if (!isNum(resonance) || resonance < 0 || resonance > 20) return fail('resonance muss 0..20 sein');
    if (!isNum(delayTime) || delayTime < 0 || delayTime > 2) return fail('delayTime muss 0..2 sein');
    if (!isNum(decay) || decay < 0 || decay > 1) return fail('decay muss 0..1 sein');
    return { success: true, data: data as unknown as TrackPreset };
  },
};
