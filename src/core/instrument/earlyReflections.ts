/**
 * audioMONASTRY · Early-Reflections + Additiv-Kerne (eigener Code)
 * ================================================================
 *   * `renderEarlyReflectionsImpulse` – 4-Tap-Early-Reflections mit Damping
 *     und Feedback (Freeverb-artig, kein Fremdcode)
 *   * `renderAdditiveMorph` – Partial-Morphing zwischen zwei Harmonik-Sets
 *     mit spektraler Hüllkurve
 */

import { createSeededRandom as mulberry32 } from '../../utils/random';

export interface EarlyReflectionParams {
  tapsMs: number[];
  tapGains: number[];
  feedback: number;
  damping: number;
}

export const DEFAULT_EARLY_REFLECTIONS: EarlyReflectionParams = {
  tapsMs: [19, 31, 43, 59],
  tapGains: [0.8, 0.6, 0.45, 0.3],
  feedback: 0.25,
  damping: 0.3,
};

/** Rendert die Impulsantwort der Early-Reflections (deterministisch). */
export function renderEarlyReflectionsImpulse(
  durationSec = 0.3,
  sampleRate = 48000,
  params: EarlyReflectionParams = DEFAULT_EARLY_REFLECTIONS,
): Float32Array {
  const sr = Math.max(8000, sampleRate);
  const frames = Math.max(1, Math.round(durationSec * sr));
  const out = new Float32Array(frames);
  const taps = params.tapsMs.map((ms) => Math.max(1, Math.round((ms / 1000) * sr)));
  const damp = Math.max(0, Math.min(0.95, params.damping));

  for (let i = 0; i < frames; i++) {
    let sample = 0;
    params.tapGains.forEach((gain, t) => {
      const idx = i - taps[t];
      if (idx >= 0) sample += out[idx] * gain;
    });
    // Feedback mit Damping (Tiefpass-Charakter).
    const fbIdx = i - Math.max(2, Math.round(0.002 * sr));
    if (fbIdx >= 0) sample += out[fbIdx] * params.feedback * (1 - damp);
    out[i] = Math.tanh(sample * 1.2);
  }
  // Dirac am Anfang.
  out[0] = 1;
  return out;
}

export interface AdditiveMorphParams {
  partialsA: number[];
  partialsB: number[];
  /** 0..1 Morph-Position. */
  position: number;
}

/** Rendert einen additiven Block mit Partial-Morphing. */
export function renderAdditiveMorph(
  noteHz: number,
  durationSec: number,
  sampleRate = 48000,
  params: AdditiveMorphParams = { partialsA: [1, 0.5, 0.25], partialsB: [1, 0.1, 0.05, 0.4, 0.2], position: 0.5 },
): Float32Array {
  const sr = Math.max(8000, sampleRate);
  const frames = Math.max(1, Math.round(durationSec * sr));
  const out = new Float32Array(frames);
  const t = Math.max(0, Math.min(1, params.position));
  const maxPartials = Math.max(params.partialsA.length, params.partialsB.length);

  for (let i = 0; i < frames; i++) {
    const time = i / sr;
    let sample = 0;
    for (let p = 0; p < maxPartials; p++) {
      const a = params.partialsA[p] ?? 0;
      const b = params.partialsB[p] ?? 0;
      const amp = a + (b - a) * t;
      if (amp === 0) continue;
      sample += amp * Math.sin(2 * Math.PI * noteHz * (p + 1) * time) * Math.exp(-time * (1.5 + p * 0.4));
    }
    if (!Number.isFinite(sample)) sample = 0;
    out[i] = Math.max(-1, Math.min(1, sample));
  }
  void mulberry32;
  return out;
}
