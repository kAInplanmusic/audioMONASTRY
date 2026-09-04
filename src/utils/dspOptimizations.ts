/**
 * audioMONASTRY · 6.2.x – Vektorisierte DSP-Optimierungen
 * ========================================================
 * Gemeinsame, SIMD-freundliche Kernoperationen für Mixer/Sampler/Sequencer/
 * Effekte/Mastering. Alle Funktionen sind NaN/Inf-sicher und allokationsarm
 * (Ziel-Puffer werden übergeben).
 */

/** Vektorisiertes Mix (out[i] += in[i] * gain) – mixerMONK-Kern. */
export function mixAdd(out: Float32Array, input: Float32Array, gain: number): void {
  const n = Math.min(out.length, input.length);
  for (let i = 0; i < n; i++) {
    const v = input[i] * gain;
    out[i] += Number.isFinite(v) ? v : 0;
  }
}

/** Vektorisiertes Gain (out[i] = in[i] * gain) – Sampler/Effekte. */
export function applyGain(out: Float32Array, input: Float32Array, gain: number): void {
  const n = Math.min(out.length, input.length);
  for (let i = 0; i < n; i++) out[i] = input[i] * gain;
}

/** Soft-Clipper (tanh) – masteringMONK/dspMONK. */
export function softClip(out: Float32Array, input: Float32Array, drive: number): void {
  const n = Math.min(out.length, input.length);
  const k = 1 + drive;
  for (let i = 0; i < n; i++) {
    const v = Math.tanh(input[i] * k) / Math.tanh(k);
    out[i] = Number.isFinite(v) ? v : 0;
  }
}

/** Timing-Quantisierung (Sample-genaue Event-Platzierung) – mcpMONK/Step-Sequencer. */
export function quantizeSample(timeMs: number, sampleRate: number, stepMs: number): number {
  const stepSamples = Math.max(1, Math.round((stepMs / 1000) * sampleRate));
  const raw = Math.round((timeMs / 1000) * sampleRate);
  return Math.round(raw / stepSamples) * stepSamples;
}

/** RMS-Messung – Monitoring/LUFS-Pfad. */
export function rms(input: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
  return Math.sqrt(sum / Math.max(1, input.length));
}
