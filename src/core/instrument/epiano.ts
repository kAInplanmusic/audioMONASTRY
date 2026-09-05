/**
 * audioMONASTRY · Physical-Modeling E-Piano (RdPiano/EP-Mk1-Referenz, eigener Code)
 * =================================================================================
 * Vereinfachtes Tine/Fork-Modell: inharmonische Partialschwingungen (Metall-
 * Stab) + Hammer-Noise-Transient + exponentieller Abkling. Deterministisch,
 * serverlos testbar – für Previews/Bounces.
 */

export interface EpianoParams {
  /** Inharmonizitäts-Faktor (0 = harmonisch, >0 = Metallstab). */
  inharmonicity: number;
  /** Partial-Amplituden (fallend). */
  partials: number[];
  /** Abklingzeit-Konstante in Sekunden. */
  decaySec: number;
  /** Hammer-Noise-Pegel 0..1. */
  hammerLevel: number;
}

export const DEFAULT_EPIANO: EpianoParams = {
  inharmonicity: 0.0004,
  partials: [1, 0.6, 0.35, 0.18, 0.08, 0.04],
  decaySec: 1.8,
  hammerLevel: 0.3,
};

import { createSeededRandom as mulberry32 } from '../../utils/random';

export function renderEpianoNote(
  noteHz: number,
  durationSeconds: number,
  sampleRate = 48000,
  params: EpianoParams = DEFAULT_EPIANO,
  seed = 42,
): Float32Array {
  const sr = Math.max(8000, sampleRate);
  const frames = Math.max(1, Math.round(durationSeconds * sr));
  const out = new Float32Array(frames);
  const rand = mulberry32(seed);

  for (let i = 0; i < frames; i++) {
    const t = i / sr;
    let sample = 0;
    for (let p = 0; p < params.partials.length; p++) {
      const n = p + 1;
      const freq = noteHz * n * Math.sqrt(1 + params.inharmonicity * n * n);
      sample += params.partials[p] * Math.sin(2 * Math.PI * freq * t) * Math.exp(-t / params.decaySec);
    }
    // Hammer-Noise-Transient (kurzer Knacks beim Anschlag).
    if (t < 0.02) {
      sample += (rand() * 2 - 1) * params.hammerLevel * (1 - t / 0.02);
    }
    if (!Number.isFinite(sample)) sample = 0;
    out[i] = Math.max(-1, Math.min(1, sample));
  }
  return out;
}
