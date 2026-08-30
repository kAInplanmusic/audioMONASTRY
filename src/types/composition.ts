// src/types/composition.ts
import { TrackType } from '../types';

export type ArrangementPattern = Record<TrackType, boolean[]>;

export interface CompositionResponse {
    task_id: string;
    patterns: ArrangementPattern;
    synthNotes: number[];
    bpm: number;
    genre: string;
}

// Zod Schema for validation
import { z } from 'zod';

export const ArrangementSchema = z.object({
    patterns: z.record(z.string(), z.array(z.boolean()).length(16)),
    synthNotes: z.array(z.number()).length(16),
    bpm: z.number().min(80).max(180),
    genre: z.string(),
});
