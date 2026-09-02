// src/types/composition.ts – ohne zod (Bundle-Diät P2-5)
import { TrackType } from '../types';

export type ArrangementPattern = Record<TrackType, boolean[]>;

export interface CompositionResponse {
  task_id: string;
  patterns: ArrangementPattern;
  synthNotes: number[];
  bpm: number;
  genre: string;
}

export interface ValidatedArrangement {
  patterns: ArrangementPattern;
  synthNotes: number[];
  bpm: number;
  genre: string;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Manuelle, schlanke Arrangement-Validierung (ersetzt zod ArrangementSchema). */
export const ArrangementSchema = {
  parse(data: unknown): ValidatedArrangement {
    const result = ArrangementSchema.safeParse(data);
    if (result.success) return result.data;
    throw (result as { success: false; error: Error }).error;
  },

  safeParse(data: unknown): { success: true; data: ValidatedArrangement } | { success: false; error: Error } {
    const fail = (msg: string) => ({ success: false as const, error: new Error(msg) });
    if (!isObj(data)) return fail('Arrangement muss ein Objekt sein');
    const { patterns, synthNotes, bpm, genre } = data;
    if (!isObj(patterns)) return fail('patterns fehlt');
    for (const ch of Object.keys(patterns)) {
      if (!Array.isArray(patterns[ch]) || patterns[ch].length !== 16) return fail(`patterns.${ch} muss boolean[16] sein`);
    }
    if (!Array.isArray(synthNotes) || synthNotes.length !== 16 || !synthNotes.every((n) => typeof n === 'number' && Number.isFinite(n))) {
      return fail('synthNotes muss number[16] sein');
    }
    if (typeof bpm !== 'number' || bpm < 80 || bpm > 180) return fail('bpm muss 80..180 sein');
    if (typeof genre !== 'string') return fail('genre muss ein String sein');
    return { success: true, data: { patterns, synthNotes, bpm, genre } as ValidatedArrangement };
  },
};
