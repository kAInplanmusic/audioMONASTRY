import { z } from 'zod';

export const TrackPresetSchema = z.object({
  id: z.string(),
  name: z.string(),
  genre: z.string(),
  bpm: z.number().min(60).max(250),
  key: z.string(),
  description: z.string(),
  patterns: z.object({
    channel1: z.array(z.boolean()),
    channel2: z.array(z.boolean()),
    channel3: z.array(z.boolean()),
    channel4: z.array(z.boolean()),
    channel5: z.array(z.boolean()),
    channel6: z.array(z.boolean()),
    channel7: z.array(z.boolean()),
    channel8: z.array(z.boolean()),
  }),
  synthNotes: z.array(z.number()),
  cutoff: z.number().min(20).max(20000),
  resonance: z.number().min(0).max(20),
  delayTime: z.number().min(0).max(2),
  decay: z.number().min(0).max(1),
});
