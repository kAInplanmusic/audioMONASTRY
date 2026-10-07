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

/**
 * Vorberechnete, geklemmte Parameter einer E-Piano-Note (RT-AUDIT-P0-001).
 * Ein Objekt dieses Typs wird EINMAL angelegt (z. B. je Voice-Slot im
 * AudioWorklet) und per `configureElectricPiano` bei jedem Anschlag neu
 * befüllt – so lässt sich die Note sample-weise über beliebig viele
 * Render-Blöcke fortsetzen, ohne pro Anschlag/Block einen Puffer zu allokieren.
 */
export interface ElectricPianoParams {
  rate: number;
  freq: number;
  modFreq: number;
  detuneHz: number;
  modIndex: number;
  modDecayS: number;
  ampDecayS: number;
  attackS: number;
  gain: number;
  detune: number;
}

/** Legt einen (neutralen) Parameter-Satz an – nur außerhalb des Render-Pfads aufrufen. */
export function createElectricPianoParams(): ElectricPianoParams {
  return {
    rate: 48000, freq: 220, modFreq: 440, detuneHz: 220, modIndex: 2.4,
    modDecayS: 0.35, ampDecayS: 1.8, attackS: 0.004, gain: 0.8, detune: 0.12,
  };
}

/**
 * Befüllt `target` mit den geklemmten Parametern einer Note (allokationsfrei).
 * Dieselben Grenzen/Defaults wie `renderElectricPiano` – beide teilen sich
 * diese Funktion, damit Puffer- und Sample-Variante bit-identisch klingen.
 */
export function configureElectricPiano(
  target: ElectricPianoParams,
  frequencyHz: number,
  opts: ElectricPianoOptions,
): ElectricPianoParams {
  const rate = Math.max(8000, safe(opts.sampleRate, 48000));
  const freq = Math.min(rate / 2.5, Math.max(20, safe(frequencyHz, 220)));
  const detune = Math.min(1, Math.max(0, safe(opts.detune, 0.12)));
  target.rate = rate;
  target.freq = freq;
  target.modFreq = freq * Math.min(8, Math.max(0.5, safe(opts.modRatio, 2)));
  target.detuneHz = freq * (1 + 0.0009 * detune * 100); // wenige Cent
  target.modIndex = Math.min(12, Math.max(0, safe(opts.modIndex, 2.4)));
  target.modDecayS = Math.max(0.01, safe(opts.modDecayS, 0.35));
  target.ampDecayS = Math.max(0.05, safe(opts.ampDecayS, 1.8));
  target.attackS = Math.max(0.0005, safe(opts.attackS, 0.004));
  target.gain = Math.min(1, Math.max(0, safe(opts.gain, 0.8)));
  target.detune = detune;
  return target;
}

/** Ein Sample (Index `i` ab Anschlag) der Note – reine Funktion, keine Allokation. */
export function electricPianoSample(p: ElectricPianoParams, i: number): number {
  const t = i / p.rate;
  const attack = 1 - Math.exp(-t / p.attackS);
  const ampEnv = attack * Math.exp(-t / p.ampDecayS);
  const index = p.modIndex * Math.exp(-t / p.modDecayS);
  const mod = Math.sin(TAU * p.modFreq * t);
  const carrier = Math.sin(TAU * p.freq * t + index * mod);
  const second = p.detune > 0 ? Math.sin(TAU * p.detuneHz * t + index * mod * 0.5) : 0;
  const value = (carrier + second * p.detune) / (1 + p.detune) * ampEnv * p.gain;
  return Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
}

/** Rendert eine E-Piano-Note als Buffer (−1..1). */
export function renderElectricPiano(frequencyHz: number, opts: ElectricPianoOptions = {}): Float32Array {
  const params = configureElectricPiano(createElectricPianoParams(), frequencyHz, opts);
  const length = pianoSampleCount(opts);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = electricPianoSample(params, i);
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
