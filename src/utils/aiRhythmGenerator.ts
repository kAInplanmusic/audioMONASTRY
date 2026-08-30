// src/utils/aiRhythmGenerator.ts
import { TrackType } from '../types';

export const generateRhythmicPattern = (genre: string): Record<TrackType, boolean[]> => {
  const patterns: Record<TrackType, boolean[]> = {
    channel1: Array(16).fill(false),
    channel2: Array(16).fill(false),
    channel3: Array(16).fill(false),
    channel4: Array(16).fill(false),
    channel5: Array(16).fill(false),
    channel6: Array(16).fill(false),
    channel7: Array(16).fill(false),
    channel8: Array(16).fill(false),
  };

  // Simple rule-based generation based on genre
  if (genre === 'techno') {
    // 4-on-the-floor kick
    [0, 4, 8, 12].forEach(step => patterns.channel1[step] = true);
    // offbeat hats
    [2, 6, 10, 14].forEach(step => patterns.channel2[step] = true);
  } else {
    // Random basic beat
    for (let i = 0; i < 16; i += 4) patterns.channel1[i] = true;
  }

  return patterns;
};
