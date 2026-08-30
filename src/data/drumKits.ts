/**
 * audioMONASTRY · Drum-Kit-Katalog – maschinengetreue Presets
 * ============================================================
 * Alle bekannten klassischen Drum-Devices mit ihren Sounds und
 * Synthese-Parametern (an den Tone.js-Engine-Kern angelehnt).
 */
export interface DrumSoundPreset {
  id: string;
  name: string;
  type: 'kick' | 'snare' | 'clap' | 'hat' | 'tom' | 'perc';
  /** Kick/Tom-Grundfrequenz (Hz). */
  freq?: number;
  freqStart?: number;
  freqEnd?: number;
  decay?: number;
  pitchDecay?: number;
  octaves?: number;
  noise?: boolean;
  noiseFilter?: number;
  harmonicity?: number;
  modulationIndex?: number;
  resonance?: number;
}

export interface DrumKit {
  id: string;
  name: string;
  origin: string;
  year: number;
  sounds: DrumSoundPreset[];
}

export const DRUM_KITS: DrumKit[] = [
  {
    id: 'tr-808', name: 'TR-808', origin: 'Roland', year: 1980,
    sounds: [
      { id: 'kick', name: 'Bass Drum', type: 'kick', freq: 50, freqStart: 156, freqEnd: 40, decay: 0.45, pitchDecay: 0.06, octaves: 8 },
      { id: 'snare', name: 'Snare', type: 'snare', noise: true, noiseFilter: 1800, decay: 0.18, freq: 180 },
      { id: 'clap', name: 'Hand Clap', type: 'clap', noise: true, noiseFilter: 1200, decay: 0.2 },
      { id: 'chh', name: 'Closed Hat', type: 'hat', noise: true, noiseFilter: 8000, decay: 0.05, harmonicity: 5.1, modulationIndex: 32 },
      { id: 'ohh', name: 'Open Hat', type: 'hat', noise: true, noiseFilter: 7500, decay: 0.35, harmonicity: 5.1, modulationIndex: 32 },
      { id: 'ltom', name: 'Low Tom', type: 'tom', freq: 110, freqStart: 220, freqEnd: 55, decay: 0.4 },
      { id: 'mtom', name: 'Mid Tom', type: 'tom', freq: 150, freqStart: 300, freqEnd: 75, decay: 0.3 },
      { id: 'htom', name: 'High Tom', type: 'tom', freq: 200, freqStart: 400, freqEnd: 100, decay: 0.25 },
      { id: 'rim', name: 'Rimshot', type: 'perc', freq: 1800, decay: 0.02 },
      { id: 'cow', name: 'Cowbell', type: 'perc', freq: 587, decay: 0.2 },
      { id: 'clv', name: 'Claves', type: 'perc', freq: 2500, decay: 0.05 },
      { id: 'mar', name: 'Maracas', type: 'perc', noise: true, noiseFilter: 6000, decay: 0.06 },
      { id: 'cng', name: 'Conga', type: 'perc', freq: 240, decay: 0.18 },
    ],
  },
  {
    id: 'tr-909', name: 'TR-909', origin: 'Roland', year: 1983,
    sounds: [
      { id: 'kick', name: 'Bass Drum', type: 'kick', freq: 55, freqStart: 180, freqEnd: 45, decay: 0.5, pitchDecay: 0.05, octaves: 8 },
      { id: 'snare', name: 'Snare', type: 'snare', noise: true, noiseFilter: 2200, decay: 0.16, freq: 200 },
      { id: 'clap', name: 'Hand Clap', type: 'clap', noise: true, noiseFilter: 1500, decay: 0.18 },
      { id: 'chh', name: 'Closed Hat', type: 'hat', noise: true, noiseFilter: 9000, decay: 0.04, harmonicity: 5.3, modulationIndex: 34 },
      { id: 'ohh', name: 'Open Hat', type: 'hat', noise: true, noiseFilter: 8500, decay: 0.4, harmonicity: 5.3, modulationIndex: 34 },
      { id: 'ltom', name: 'Low Tom', type: 'tom', freq: 100, freqStart: 200, freqEnd: 50, decay: 0.35 },
      { id: 'mtom', name: 'Mid Tom', type: 'tom', freq: 140, freqStart: 280, freqEnd: 70, decay: 0.3 },
      { id: 'htom', name: 'High Tom', type: 'tom', freq: 190, freqStart: 380, freqEnd: 95, decay: 0.22 },
      { id: 'rim', name: 'Rimshot', type: 'perc', freq: 2000, decay: 0.02 },
      { id: 'ride', name: 'Ride', type: 'perc', noise: true, noiseFilter: 7000, decay: 0.5 },
      { id: 'crs', name: 'Crash', type: 'perc', noise: true, noiseFilter: 6000, decay: 0.7 },
    ],
  },
  {
    id: 'tr-606', name: 'TR-606', origin: 'Roland', year: 1981,
    sounds: [
      { id: 'kick', name: 'Bass Drum', type: 'kick', freq: 60, freqStart: 150, freqEnd: 48, decay: 0.3, octaves: 6 },
      { id: 'snare', name: 'Snare', type: 'snare', noise: true, noiseFilter: 2000, decay: 0.14, freq: 190 },
      { id: 'chh', name: 'Closed Hat', type: 'hat', noise: true, noiseFilter: 8500, decay: 0.04, harmonicity: 5.0, modulationIndex: 28 },
      { id: 'ohh', name: 'Open Hat', type: 'hat', noise: true, noiseFilter: 8000, decay: 0.3, harmonicity: 5.0, modulationIndex: 28 },
      { id: 'ltom', name: 'Low Tom', type: 'tom', freq: 105, freqStart: 210, freqEnd: 52, decay: 0.3 },
      { id: 'htom', name: 'High Tom', type: 'tom', freq: 185, freqStart: 370, freqEnd: 92, decay: 0.2 },
      { id: 'cym', name: 'Cymbal', type: 'perc', noise: true, noiseFilter: 6500, decay: 0.45 },
    ],
  },
  {
    id: 'tr-707', name: 'TR-707', origin: 'Roland', year: 1985,
    sounds: [
      { id: 'kick', name: 'Bass Drum', type: 'kick', freq: 55, freqStart: 160, freqEnd: 44, decay: 0.4, octaves: 7 },
      { id: 'snare', name: 'Snare', type: 'snare', noise: true, noiseFilter: 2100, decay: 0.15, freq: 200 },
      { id: 'chh', name: 'Closed Hat', type: 'hat', noise: true, noiseFilter: 9000, decay: 0.05, harmonicity: 5.2, modulationIndex: 30 },
      { id: 'ohh', name: 'Open Hat', type: 'hat', noise: true, noiseFilter: 8500, decay: 0.4, harmonicity: 5.2, modulationIndex: 30 },
      { id: 'ltom', name: 'Low Tom', type: 'tom', freq: 100, freqStart: 200, freqEnd: 50, decay: 0.35 },
      { id: 'mtom', name: 'Mid Tom', type: 'tom', freq: 140, freqStart: 280, freqEnd: 70, decay: 0.3 },
      { id: 'htom', name: 'High Tom', type: 'tom', freq: 190, freqStart: 380, freqEnd: 95, decay: 0.22 },
      { id: 'rim', name: 'Rimshot', type: 'perc', freq: 1900, decay: 0.02 },
      { id: 'cow', name: 'Cowbell', type: 'perc', freq: 560, decay: 0.18 },
      { id: 'tmb', name: 'Tambourine', type: 'perc', noise: true, noiseFilter: 7000, decay: 0.08 },
      { id: 'crs', name: 'Crash', type: 'perc', noise: true, noiseFilter: 6000, decay: 0.6 },
      { id: 'ride', name: 'Ride', type: 'perc', noise: true, noiseFilter: 7000, decay: 0.5 },
    ],
  },
  {
    id: 'cr-78', name: 'CR-78', origin: 'Roland', year: 1978,
    sounds: [
      { id: 'kick', name: 'Bass Drum', type: 'kick', freq: 58, freqStart: 140, freqEnd: 46, decay: 0.35, octaves: 6 },
      { id: 'snare', name: 'Snare', type: 'snare', noise: true, noiseFilter: 1900, decay: 0.13, freq: 185 },
      { id: 'clap', name: 'Clap', type: 'clap', noise: true, noiseFilter: 1300, decay: 0.15 },
      { id: 'chh', name: 'Closed Hat', type: 'hat', noise: true, noiseFilter: 8200, decay: 0.05, harmonicity: 4.9, modulationIndex: 26 },
      { id: 'ohh', name: 'Open Hat', type: 'hat', noise: true, noiseFilter: 7800, decay: 0.32, harmonicity: 4.9, modulationIndex: 26 },
      { id: 'ltom', name: 'Low Tom', type: 'tom', freq: 102, freqStart: 204, freqEnd: 51, decay: 0.3 },
      { id: 'htom', name: 'High Tom', type: 'tom', freq: 180, freqStart: 360, freqEnd: 90, decay: 0.2 },
      { id: 'rim', name: 'Rimshot', type: 'perc', freq: 1800, decay: 0.02 },
      { id: 'cow', name: 'Cowbell', type: 'perc', freq: 540, decay: 0.16 },
      { id: 'gui', name: 'Guiro', type: 'perc', noise: true, noiseFilter: 4000, decay: 0.12 },
      { id: 'tmb', name: 'Tambourine', type: 'perc', noise: true, noiseFilter: 6800, decay: 0.08 },
      { id: 'cng', name: 'Conga', type: 'perc', freq: 230, decay: 0.16 },
    ],
  },
  {
    id: 'linndrum', name: 'LinnDrum', origin: 'Linn', year: 1982,
    sounds: [
      { id: 'kick', name: 'Bass Drum', type: 'kick', freq: 52, freqStart: 150, freqEnd: 42, decay: 0.4, octaves: 7 },
      { id: 'snare', name: 'Snare', type: 'snare', noise: true, noiseFilter: 2000, decay: 0.14, freq: 195 },
      { id: 'clap', name: 'Clap', type: 'clap', noise: true, noiseFilter: 1400, decay: 0.16 },
      { id: 'chh', name: 'Closed Hat', type: 'hat', noise: true, noiseFilter: 8800, decay: 0.05, harmonicity: 5.1, modulationIndex: 30 },
      { id: 'ohh', name: 'Open Hat', type: 'hat', noise: true, noiseFilter: 8200, decay: 0.38, harmonicity: 5.1, modulationIndex: 30 },
      { id: 'ltom', name: 'Low Tom', type: 'tom', freq: 98, freqStart: 196, freqEnd: 49, decay: 0.32 },
      { id: 'mtom', name: 'Mid Tom', type: 'tom', freq: 138, freqStart: 276, freqEnd: 69, decay: 0.28 },
      { id: 'htom', name: 'High Tom', type: 'tom', freq: 188, freqStart: 376, freqEnd: 94, decay: 0.2 },
      { id: 'rim', name: 'Rimshot', type: 'perc', freq: 1900, decay: 0.02 },
      { id: 'cow', name: 'Cowbell', type: 'perc', freq: 550, decay: 0.17 },
      { id: 'cab', name: 'Cabasa', type: 'perc', noise: true, noiseFilter: 5000, decay: 0.1 },
      { id: 'cng', name: 'Conga', type: 'perc', freq: 235, decay: 0.15 },
      { id: 'tmb', name: 'Tambourine', type: 'perc', noise: true, noiseFilter: 6900, decay: 0.07 },
    ],
  },
  {
    id: 'dmx', name: 'Oberheim DMX', origin: 'Oberheim', year: 1981,
    sounds: [
      { id: 'kick', name: 'Bass Drum', type: 'kick', freq: 54, freqStart: 155, freqEnd: 43, decay: 0.38, octaves: 7 },
      { id: 'snare', name: 'Snare', type: 'snare', noise: true, noiseFilter: 2050, decay: 0.14, freq: 198 },
      { id: 'clap', name: 'Clap', type: 'clap', noise: true, noiseFilter: 1350, decay: 0.16 },
      { id: 'chh', name: 'Closed Hat', type: 'hat', noise: true, noiseFilter: 8600, decay: 0.05, harmonicity: 5.0, modulationIndex: 28 },
      { id: 'ohh', name: 'Open Hat', type: 'hat', noise: true, noiseFilter: 8000, decay: 0.35, harmonicity: 5.0, modulationIndex: 28 },
      { id: 'ltom', name: 'Low Tom', type: 'tom', freq: 104, freqStart: 208, freqEnd: 52, decay: 0.3 },
      { id: 'htom', name: 'High Tom', type: 'tom', freq: 186, freqStart: 372, freqEnd: 93, decay: 0.2 },
      { id: 'rim', name: 'Rimshot', type: 'perc', freq: 1850, decay: 0.02 },
      { id: 'cow', name: 'Cowbell', type: 'perc', freq: 545, decay: 0.17 },
      { id: 'cab', name: 'Cabasa', type: 'perc', noise: true, noiseFilter: 5100, decay: 0.1 },
      { id: 'cng', name: 'Conga', type: 'perc', freq: 228, decay: 0.15 },
      { id: 'tmb', name: 'Tambourine', type: 'perc', noise: true, noiseFilter: 6800, decay: 0.07 },
      { id: 'shk', name: 'Shaker', type: 'perc', noise: true, noiseFilter: 6000, decay: 0.09 },
    ],
  },
  {
    id: 'drumtraks', name: 'Sequential Drumtraks', origin: 'Sequential', year: 1984,
    sounds: [
      { id: 'kick', name: 'Bass Drum', type: 'kick', freq: 53, freqStart: 152, freqEnd: 42, decay: 0.36, octaves: 7 },
      { id: 'snare', name: 'Snare', type: 'snare', noise: true, noiseFilter: 2100, decay: 0.13, freq: 196 },
      { id: 'clap', name: 'Clap', type: 'clap', noise: true, noiseFilter: 1400, decay: 0.15 },
      { id: 'chh', name: 'Closed Hat', type: 'hat', noise: true, noiseFilter: 8700, decay: 0.045, harmonicity: 5.1, modulationIndex: 29 },
      { id: 'ohh', name: 'Open Hat', type: 'hat', noise: true, noiseFilter: 8100, decay: 0.36, harmonicity: 5.1, modulationIndex: 29 },
      { id: 'ltom', name: 'Low Tom', type: 'tom', freq: 101, freqStart: 202, freqEnd: 50, decay: 0.31 },
      { id: 'mtom', name: 'Mid Tom', type: 'tom', freq: 139, freqStart: 278, freqEnd: 69, decay: 0.27 },
      { id: 'htom', name: 'High Tom', type: 'tom', freq: 187, freqStart: 374, freqEnd: 93, decay: 0.21 },
      { id: 'rim', name: 'Rimshot', type: 'perc', freq: 1880, decay: 0.02 },
      { id: 'cow', name: 'Cowbell', type: 'perc', freq: 548, decay: 0.16 },
    ],
  },
];

export function getDrumKit(id: string): DrumKit | undefined {
  return DRUM_KITS.find((k) => k.id === id);
}

export function getDrumSound(kitId: string, soundId: string): DrumSoundPreset | undefined {
  return getDrumKit(kitId)?.sounds.find((s) => s.id === soundId);
}
