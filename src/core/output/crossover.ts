/**
 * audioMONASTRY · 2.1-Crossover-Prozessor (P2-3)
 * ===============================================
 * Reine, plattformfreie DSP-Verarbeitung für den Master-Ausgang:
 *   * `mode: '2.1'`  – L/R werden hochpassgefiltert (Linkwitz-Riley 2. Ordnung),
 *     der Sub-Kanal (LFE) erhält die Summe (L+R)/2 tiefpassgefiltert.
 *   * `mode: 'phantom'` – kein dedizierter Sub-Kanal: der tiefpassgefilterte
 *     Sub-Anteil wird zurück in L/R gemischt (keine volle Bass-Einbuße).
 *
 * Die Biquad-Koeffizienten kommen aus `designLinkwitzRileyCrossover`
 * (OutputConfig). Verarbeitung blockweise, allocationsarm (State-Puffer werden
 * wiederverwendet), NaN/Inf-sicher – analog zu den Audio-Worklets.
 */
import { designLinkwitzRileyCrossover, type CrossoverCoefficients } from './OutputConfig';

export type CrossoverMode = '2.1' | 'phantom';

export interface Stereo21Result {
  left: Float32Array;
  right: Float32Array;
  /** Sub-Kanal (LFE). Im phantom-Modus identisch 0 (Bass steckt in L/R). */
  lfe: Float32Array;
}

/** Biquad-Zustand je Kanal (Direct Form 1). */
interface BiquadState {
  x1: number;
  x2: number;
  y1: number;
  y2: number;
}

export class Stereo21Crossover {
  readonly sampleRate: number;
  readonly crossoverHz: number;
  readonly mode: CrossoverMode;

  private coefs: CrossoverCoefficients;
  private lpL: BiquadState = { x1: 0, x2: 0, y1: 0, y2: 0 };
  private hpL: BiquadState = { x1: 0, x2: 0, y1: 0, y2: 0 };
  private hpR: BiquadState = { x1: 0, x2: 0, y1: 0, y2: 0 };

  constructor(sampleRate = 48000, crossoverHz = 90, mode: CrossoverMode = '2.1') {
    this.sampleRate = Math.max(8000, sampleRate);
    this.coefs = designLinkwitzRileyCrossover(this.sampleRate, crossoverHz);
    this.crossoverHz = this.coefs.crossoverHz;
    this.mode = mode;
  }

  reset(): void {
    this.lpL = { x1: 0, x2: 0, y1: 0, y2: 0 };
    this.hpL = { x1: 0, x2: 0, y1: 0, y2: 0 };
    this.hpR = { x1: 0, x2: 0, y1: 0, y2: 0 };
  }

  /** Verarbeitet einen Stereo-Block planar → L/R/LFE (oder phantom L/R). */
  process(left: Float32Array, right: Float32Array): Stereo21Result {
    const len = Math.min(left.length, right.length);
    const outL = new Float32Array(len);
    const outR = new Float32Array(len);
    const outLfe = this.mode === '2.1' ? new Float32Array(len) : new Float32Array(len);

    for (let i = 0; i < len; i++) {
      const mono = (left[i] + right[i]) * 0.5;
      const sub = this.biquad(mono, this.coefs.lowpass, this.lpL);
      const hl = this.biquad(left[i], this.coefs.highpass, this.hpL);
      const hr = this.biquad(right[i], this.coefs.highpass, this.hpR);

      if (this.mode === '2.1') {
        outLfe[i] = sub;
        outL[i] = hl;
        outR[i] = hr;
      } else {
        // Phantom: Sub-Anteil zurück in L/R mischen (Fallback ohne LFE-Kanal).
        outLfe[i] = 0;
        outL[i] = hl + sub * 0.5;
        outR[i] = hr + sub * 0.5;
      }
    }
    return { left: outL, right: outR, lfe: outLfe };
  }

  private biquad(x: number, c: CrossoverCoefficients['lowpass'], s: BiquadState): number {
    let y = c[0] * x + c[1] * s.x1 + c[2] * s.x2 - c[3] * s.y1 - c[4] * s.y2;
    if (!Number.isFinite(y)) y = 0;
    s.x2 = s.x1;
    s.x1 = x;
    s.y2 = s.y1;
    s.y1 = y;
    return y;
  }
}
