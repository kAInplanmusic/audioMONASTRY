/**
 * audioMONASTRY · Drum-Synthese + Humanize (Geonkick/Hydrogen-Referenz, eigener Code)
 * ==================================================================================
 * Kick/Snare/Hat als segmentierte Synthese (Pitch-/Amp-Hüllkurven, Noise-Layer,
 * Click-Transient) + deterministische Humanize-Funktion (Timing-/Velocity-Jitter).
 */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function renderKick(durationSec = 0.4, sampleRate = 48000): Float32Array {
  const sr = Math.max(8000, sampleRate);
  const frames = Math.max(1, Math.round(durationSec * sr));
  const out = new Float32Array(frames);
  let phase = 0;
  for (let i = 0; i < frames; i++) {
    const t = i / sr;
    const freq = 45 + 95 * Math.exp(-t * 28); // Pitch-Hüllkurve 140→45 Hz
    const amp = Math.exp(-t * 8);             // Amp-Hüllkurve
    phase += (2 * Math.PI * freq) / sr;
    let s = Math.sin(phase) * amp;
    if (t < 0.004) s += (1 - t / 0.004) * 0.8; // Click-Transient
    out[i] = Math.tanh(s * 1.4); // Soft-Clipper
  }
  return out;
}

export function renderSnare(durationSec = 0.25, sampleRate = 48000, seed = 7): Float32Array {
  const sr = Math.max(8000, sampleRate);
  const frames = Math.max(1, Math.round(durationSec * sr));
  const out = new Float32Array(frames);
  const rand = mulberry32(seed);
  for (let i = 0; i < frames; i++) {
    const t = i / sr;
    const tone = Math.sin(2 * Math.PI * 180 * t) * Math.exp(-t * 22) * 0.7;
    const noise = (rand() * 2 - 1) * Math.exp(-t * 18) * 0.9;
    out[i] = Math.tanh(tone + noise);
  }
  return out;
}

export function renderHat(durationSec = 0.08, sampleRate = 48000, seed = 99): Float32Array {
  const sr = Math.max(8000, sampleRate);
  const frames = Math.max(1, Math.round(durationSec * sr));
  const out = new Float32Array(frames);
  const rand = mulberry32(seed);
  for (let i = 0; i < frames; i++) {
    const t = i / sr;
    out[i] = (rand() * 2 - 1) * Math.exp(-t * 55);
  }
  return out;
}

export interface HumanizeResult {
  timeOffsetSec: number;
  velocity: number;
}

/** Deterministischer Humanize-Jitter (Timing ±amount/2, Velocity ±amount/2). */
export function humanize(step: number, amount = 0.02, seed = 1234): HumanizeResult {
  const rand = mulberry32(seed + step * 7919);
  return {
    timeOffsetSec: (rand() - 0.5) * amount,
    velocity: Math.max(0.2, Math.min(1, 0.9 + (rand() - 0.5) * amount)),
  };
}
