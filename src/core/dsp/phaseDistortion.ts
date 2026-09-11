/**
 * audioMONASTRY · Phase-Distortion-Oszillator (FEAT-P3-001)
 * ========================================================
 * Das klassische Casio-CZ-Verfahren: ein Sinus wird nicht gefiltert, sondern
 * seine **Phase** wird nichtlinear verzerrt. Dadurch entstehen bei praktisch
 * konstantem Rechenaufwand spektrale Änderungen, die mit einem Filter nur
 * schwer zu erreichen sind (harte, „digitale" Klangfarben für Leads/Bässe).
 *
 * Rein und samplebasiert: `shapePhase` ist die Abbildung, alles andere baut
 * darauf auf. Damit ist die Klangcharakteristik testbar (Oberwellen über die
 * Energie der ersten Ableitung), ohne einen Audio-Kontext zu brauchen.
 */

export type PhaseDistortionWave = 'sine' | 'saw' | 'square';

export interface PhaseDistortionOptions {
  /** 0 = unverzerrt, 1 = maximale Verzerrung. */
  amount?: number;
  /** Zielwellenform, deren Phasenverlauf angestrebt wird. */
  waveform?: PhaseDistortionWave;
  /** Ausgangspegel (Default 0.9, um Clipping zu vermeiden). */
  gain?: number;
}

const clamp01 = (v: number) => (!Number.isFinite(v) ? 0 : v < 0 ? 0 : v > 1 ? 1 : v);

/** Ziel-Phasenverlauf je Wellenform (0..1 → 0..1, monoton). */
function targetPhase(phase: number, waveform: PhaseDistortionWave): number {
  switch (waveform) {
    case 'saw':
      return phase < 0.5 ? phase * 2 : 2 - phase * 2;
    case 'square': {
      // Treppe: hält die Phase an, springt in der Mitte
      return phase < 0.5 ? Math.min(1, phase * 4) * 0.5 : 0.5 + Math.min(1, (phase - 0.5) * 4) * 0.5;
    }
    default:
      return phase;
  }
}

/**
 * Verzerrt die Phase: `amount` mischt zwischen linearer Phase (Sinus) und dem
 * Zielverlauf. Bei `amount = 0` bleibt die Phase unverändert.
 */
export function shapePhase(phase01: number, amount: number, waveform: PhaseDistortionWave = 'sine'): number {
  const p = clamp01(phase01);
  const a = clamp01(amount);
  if (a === 0) return p;
  const target = targetPhase(p, waveform);
  return p + (target - p) * a;
}

/** Ein Sample (−1..1) bei gegebener Phase. */
export function phaseDistortionSample(
  phase01: number,
  amount: number,
  waveform: PhaseDistortionWave = 'sine',
  gain = 0.9,
): number {
  const g = Number.isFinite(gain) ? Math.max(0, Math.min(1, gain)) : 0.9;
  const value = Math.sin(2 * Math.PI * shapePhase(phase01, amount, waveform)) * g;
  return Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
}

/** Rendert einen Ton als Buffer (für Tests/Presets/Bounce). */
export function renderPhaseDistortion(
  frequencyHz: number,
  sampleRate: number,
  lengthSamples: number,
  opts: PhaseDistortionOptions = {},
): Float32Array {
  const rate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 48000;
  const freq = Number.isFinite(frequencyHz) && frequencyHz > 0 ? frequencyHz : 440;
  const length = Math.max(0, Math.floor(lengthSamples));
  const out = new Float32Array(length);
  const amount = clamp01(opts.amount ?? 0.5);
  const waveform = opts.waveform ?? 'sine';
  const gain = opts.gain ?? 0.9;
  for (let i = 0; i < length; i++) {
    const phase = (i * freq) / rate;
    out[i] = phaseDistortionSample(phase - Math.floor(phase), amount, waveform, gain);
  }
  return out;
}

/**
 * Maß für den Oberwellengehalt: mittlere Energie der ersten Ableitung. Ein
 * reiner Sinus hat einen kleinen Wert, phasenverzerrte Signale einen deutlich
 * größeren (harte Kanten ⇒ große Differenzen).
 */
export function highFrequencyEnergy(signal: Float32Array): number {
  if (signal.length < 2) return 0;
  let sum = 0;
  for (let i = 1; i < signal.length; i++) {
    const d = signal[i] - signal[i - 1];
    sum += d * d;
  }
  return sum / (signal.length - 1);
}
