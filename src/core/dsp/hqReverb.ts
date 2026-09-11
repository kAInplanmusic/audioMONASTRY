/**
 * audioMONASTRY · HQ-Reverb (FDN) (FEAT-P3-001)
 * ============================================
 * Feedback-Delay-Network mit 4 Delay-Leitungen (Hadamard-artige Mischung),
 * Tiefen-Dämpfung pro Leitung und RT60-basiertem Feedback. Deutlich
 * „hochwertiger" als ein einzelner Comb: dichte Fahne ohne metallisches
 * Klingeln, und die Dämpfung nimmt Höhen zuerst weg (wie ein Raum).
 *
 * Reiner Baustein: kein Audio-Kontext, kein DOM. Alles ist blockweise
 * berechenbar und damit testbar (Fahne klingt ab, stabil, kein NaN, Dry/Wet).
 */

export interface ReverbOptions {
  sampleRate?: number;
  /** RT60 in Sekunden (Zeit bis −60 dB). */
  decayS?: number;
  /** 0 = keine Dämpfung, 1 = stark (Höhen klingen zuerst ab). */
  damping?: number;
  /** 0 = nur trocken, 1 = nur nass. */
  mix?: number;
  /** Raumgröße (skaliert die Delay-Längen). */
  sizeScale?: number;
}

const DEFAULT_DELAYS_MS = [29.7, 37.1, 41.1, 43.7];

export class HighQualityReverb {
  readonly sampleRate: number;
  private readonly lines: { buffer: Float32Array; index: number; length: number; gain: number; damp: number }[] = [];
  private readonly mix: number;
  private readonly dampingState: number[] = [];
  private readonly dampingCoef: number;

  constructor(opts: ReverbOptions = {}) {
    const rate = Math.max(8000, Number.isFinite(opts.sampleRate) ? Number(opts.sampleRate) : 48000);
    this.sampleRate = rate;
    const decayS = Math.max(0.05, Math.min(30, Number.isFinite(opts.decayS) ? Number(opts.decayS) : 2));
    const sizeScale = Math.max(0.2, Math.min(3, Number.isFinite(opts.sizeScale) ? Number(opts.sizeScale) : 1));
    const damping = Math.max(0, Math.min(1, Number.isFinite(opts.damping) ? Number(opts.damping) : 0.35));
    this.mix = Math.max(0, Math.min(1, Number.isFinite(opts.mix) ? Number(opts.mix) : 0.3));
    // Dämpfungs-Koeffizient eines Ein-Pol-Tiefpasses (mehr Dämpfung = tieferer Koeffizient)
    this.dampingCoef = Math.max(0.05, 1 - damping * 0.95);

    for (const ms of DEFAULT_DELAYS_MS) {
      const length = Math.max(1, Math.round((ms / 1000) * rate * sizeScale));
      this.lines.push({
        buffer: new Float32Array(length),
        index: 0,
        length,
        // RT60: g = 10^(−3 · LängeInSekunden / decayS)
        gain: Math.pow(10, (-3 * (length / rate)) / decayS),
        damp: this.dampingCoef,
      });
      this.dampingState.push(0);
    }
  }

  /** Setzt das Netz zurück (z. B. bei Transport-Stop). */
  reset(): void {
    for (const line of this.lines) line.buffer.fill(0);
    this.dampingState.fill(0);
  }

  /** Verarbeitet einen Block; liefert einen NEUEN Buffer (Eingabe bleibt unberührt). */
  process(input: Float32Array): Float32Array {
    const out = new Float32Array(input.length);
    const feedback: number[] = this.lines.map((line) => line.buffer[line.index]);
    for (let i = 0; i < input.length; i++) {
      const dry = Number.isFinite(input[i]) ? input[i] : 0;

      // Hadamard-artige Mischung der Rückkopplungen (orthogonal, verlustfrei).
      const a = feedback[0];
      const b = feedback[1];
      const c = feedback[2];
      const d = feedback[3];
      const mixed = [
        (a + b + c + d) * 0.5,
        (a - b + c - d) * 0.5,
        (a + b - c - d) * 0.5,
        (a - b - c + d) * 0.5,
      ];

      for (let l = 0; l < this.lines.length; l++) {
        const line = this.lines[l];
        // Lehrbuch-Delay-Line: erst den aeltesten Wert LESEN (= genau `length`
        // Samples Verzoegerung), dann an derselben Stelle schreiben.
        const delayed = line.buffer[line.index];
        // Ein-Pol-Dämpfung: Höhen zuerst wegnehmen
        this.dampingState[l] = this.dampingState[l] * (1 - line.damp) + mixed[l] * line.damp;
        const write = dry * 0.5 + this.dampingState[l] * line.gain;
        line.buffer[line.index] = Number.isFinite(write) ? write : 0;
        line.index = (line.index + 1) % line.length;
        feedback[l] = delayed;
      }

      const wet = (feedback[0] + feedback[1] + feedback[2] + feedback[3]) * 0.25;
      const value = dry * (1 - this.mix) + wet * this.mix;
      out[i] = Number.isFinite(value) ? Math.max(-4, Math.min(4, value)) : 0;
    }
    return out;
  }
}

/** Kurzform: Impulsantwort des Netzwerks (für Tests/Presets). */
export function renderReverbImpulse(opts: ReverbOptions & { lengthSamples: number }): Float32Array {
  const reverb = new HighQualityReverb(opts);
  const impulse = new Float32Array(Math.max(1, Math.floor(opts.lengthSamples)));
  impulse[0] = 1;
  return reverb.process(impulse);
}
