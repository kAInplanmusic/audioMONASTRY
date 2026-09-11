/**
 * audioMONASTRY · E-Piano-Stimme (FM) (FEAT-P3-001)
 * ================================================
 * Klassische FM-E-Piano-Synthese (DX7/Rhodes-Schule) als **reiner** Baustein:
 * ein Träger wird von einem Modulator in der Phase moduliert, dessen Index
 * schneller abklingt als die Amplitude. Genau daraus entsteht der typische
 * „Glocken"-Anschlag, der in ein weiches Sustain übergeht.
 *
 * Ohne Audio-Kontext, ohne DOM — der Baustein ist damit testbar (Hüllkurve,
 * Oberwellengehalt, Stabilität) und kann später im V2-Graph als Quelle dienen.
 */

export interface ElectricPianoOptions {
  sampleRate?: number;
  durationS?: number;
  /** Frequenzverhältnis Modulator : Träger (1 = glockig, 2–3 = metallisch). */
  modRatio?: number;
  /** FM-Index: Härte des Anschlags. */
  modIndex?: number;
  /** Abklingzeit des Modulator-Index (Sekunden). */
  modDecayS?: number;
  /** Abklingzeit der Amplitude (Sekunden). */
  ampDecayS?: number;
  /** Anschlagzeit (Sekunden); nie 0, sonst „klickt" es digital. */
  attackS?: number;
  /** Ausgangspegel 0..1 (Default 0.8). */
  gain?: number;
  /** Anteil einer leichten 2. Stimme (Chorus/Tremolo-Charakter), 0..1. */
  detune?: number;
}

const TAU = Math.PI * 2;
const safe = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

/** Dauer in Samples (auf sinnvolle Grenzen begrenzt). */
export function pianoSampleCount(opts: ElectricPianoOptions): number {
  const rate = Math.max(8000, safe(opts.sampleRate, 48000));
  const duration = Math.min(60, Math.max(0.01, safe(opts.durationS, 2)));
  return Math.floor(rate * duration);
}

/** Rendert eine E-Piano-Note als Buffer (−1..1). */
export function renderElectricPiano(frequencyHz: number, opts: ElectricPianoOptions = {}): Float32Array {
  const rate = Math.max(8000, safe(opts.sampleRate, 48000));
  const freq = Math.min(rate / 2.5, Math.max(20, safe(frequencyHz, 220)));
  const length = pianoSampleCount(opts);
  const modRatio = Math.min(8, Math.max(0.5, safe(opts.modRatio, 2)));
  const modIndex = Math.min(12, Math.max(0, safe(opts.modIndex, 2.4)));
  const modDecayS = Math.max(0.01, safe(opts.modDecayS, 0.35));
  const ampDecayS = Math.max(0.05, safe(opts.ampDecayS, 1.8));
  const attackS = Math.max(0.0005, safe(opts.attackS, 0.004));
  const gain = Math.min(1, Math.max(0, safe(opts.gain, 0.8)));
  const detune = Math.min(1, Math.max(0, safe(opts.detune, 0.12)));

  const out = new Float32Array(length);
  const modFreq = freq * modRatio;
  const detuneHz = freq * (1 + 0.0009 * detune * 100); // wenige Cent

  for (let i = 0; i < length; i++) {
    const t = i / rate;
    const attack = 1 - Math.exp(-t / attackS);
    const ampEnv = attack * Math.exp(-t / ampDecayS);
    const index = modIndex * Math.exp(-t / modDecayS);
    const mod = Math.sin(TAU * modFreq * t);
    const carrier = Math.sin(TAU * freq * t + index * mod);
    const second = detune > 0 ? Math.sin(TAU * detuneHz * t + index * mod * 0.5) : 0;
    const value = (carrier + second * detune) / (1 + detune) * ampEnv * gain;
    out[i] = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
  }
  return out;
}

/** Effektivwert eines Abschnitts (für Hüllkurven-Tests). */
export function rmsOf(signal: Float32Array, from = 0, to = signal.length): number {
  const start = Math.max(0, Math.min(signal.length, Math.floor(from)));
  const end = Math.max(start, Math.min(signal.length, Math.floor(to)));
  if (end === start) return 0;
  let sum = 0;
  for (let i = start; i < end; i++) sum += signal[i] * signal[i];
  return Math.sqrt(sum / (end - start));
}
