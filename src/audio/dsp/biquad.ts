/**
 * audioMONASTRY · Biquad-Koeffizienten (AM-E4-3)
 * ===============================================
 * Einheitliche DF1-Koeffizientenberechnung, stabil an den Rändern
 * (freq → 0 und freq → Nyquist) und NaN-sicher. Wird von dspProcessor
 * und spatialMONK (Crossover) genutzt.
 */

export type BiquadCoefficients = [number, number, number, number, number]; // b0,b1,b2,a1,a2

export function computeLowpassCoefficients(freq: number, q: number, sampleRate: number): BiquadCoefficients {
  const sr = Math.max(8000, Number.isFinite(sampleRate) ? sampleRate : 48000);
  const f = Math.max(0, Math.min(sr / 2 - 1, Number.isFinite(freq) ? freq : 1000));
  const qq = Math.max(0.1, Math.min(20, Number.isFinite(q) ? q : 0.707));
  const w = (2 * Math.PI * f) / sr;
  const cos = Math.cos(w);
  const sin = Math.sin(w);
  const alpha = sin / (2 * qq);
  const a0 = 1 + alpha;
  const b0 = (1 - cos) / 2;
  const b1 = 1 - cos;
  const b2 = b0;
  const a1 = (-2 * cos) / a0;
  const a2 = (1 - alpha) / a0;
  const out: BiquadCoefficients = [b0 / a0, b1 / a0, b2 / a0, a1, a2];
  for (let i = 0; i < 5; i++) if (!Number.isFinite(out[i])) out[i] = 0;
  return out;
}
