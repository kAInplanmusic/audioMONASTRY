/**
 * audioMONASTRY · V2Meters (RT-AUDIT-P0-005)
 * ============================================================
 * High-performance audio metering according to ITU-R BS.1770-4.
 * Measures Peak, True-Peak (4× oversampling FIR), RMS, Correlation,
 * and K-weighted LUFS (Momentary and Short-term).
 * Designed for allocation-free use in the AudioWorklet thread.
 *
 * Alle Werte liegen in einem SharedArrayBuffer (siehe METER_LAYOUT), den der
 * Prozessor einmalig per `meter-sab` an den Main-Thread übergibt. Jedes Feld
 * hat genau EINEN Schreiber (Worklet bzw. Main-Thread).
 */
import { TruePeakDetector } from '../../dsp/truePeak';

export const METER_LAYOUT = {
  PEAK_L: 0,
  PEAK_R: 1,
  TRUE_PEAK_L: 2,
  TRUE_PEAK_R: 3,
  RMS_L: 4,
  RMS_R: 5,
  CORRELATION: 6,
  LUFS_M: 7,
  LUFS_S: 8,
  UNDERRUNS_WORKLET: 9,
  UNDERRUNS_MAIN: 10,
  /** Spitzenwert-Hold: Maximum über die letzten ~20 ms (kein Sample-Verlust bei 60-Hz-UI). */
  PEAK_HOLD_L: 11,
  PEAK_HOLD_R: 12,
  /** Ringpuffer der letzten Block-Samples des linken Kanals (Wellenform-Anzeige). */
  WAVEFORM_START: 13,
  /** Anzahl Wellenform-Samples im Ring (= ein Render-Block). */
  WAVEFORM_LEN: 128,
  COUNT: 13 + 128,
} as const;

/**
 * RT-AUDIT-P0-005 (Schritt 4): Worklet-Underrun-Bewertung. Vergleicht die
 * tatsächlich verstrichene Wall-Clock-Zeit mit der Soll-Dauer einer Messperiode.
 * Reine Funktion – ohne Worklet-Globals testbar.
 */
export function isWorkletUnderrun(elapsedMs: number, expectedMs: number, thresholdMs = 3): boolean {
  return elapsedMs - expectedMs > thresholdMs;
}

/**
 * RT-AUDIT-P0-005 (Schritt 3): Main-Thread-Underrun-Bewertung. Wanduhr-Fortschritt
 * gegen Audio-Fortschritt (getOutputTimestamp). Mehr als 1,5 Render-Quanten
 * Rückstand = verpasste Deadline. Reine Funktion – testbar.
 */
export function isMainUnderrun(elapsedWallMs: number, elapsedContextMs: number, blockMs: number): boolean {
  return elapsedWallMs - elapsedContextMs > 1.5 * blockMs;
}

/**
 * Biquad filter for K-weighting (BS.1770-4).
 */
class Biquad {
  private b0=0; private b1=0; private b2=0;
  private a1=0; private a2=0;
  private x1=0; private x2=0;
  private y1=0; private y2=0;

  setCoefficients(b0: number, b1: number, b2: number, a1: number, a2: number) {
    this.b0 = b0; this.b1 = b1; this.b2 = b2;
    this.a1 = a1; this.a2 = a2;
  }

  process(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }

  reset() {
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
  }
}

export class V2Meters {
  private readonly sab: SharedArrayBuffer;
  private readonly view: Float32Array;

  // K-Weighting filters for LUFS (Stage 1: Pre-filter, Stage 2: RLB filter)
  private readonly filterL1 = new Biquad();
  private readonly filterL2 = new Biquad();
  private readonly filterR1 = new Biquad();
  private readonly filterR2 = new Biquad();

  // True-Peak (echtes 4×-Oversampling, BS.1770-4 Annex 2)
  private readonly tpL = new TruePeakDetector();
  private readonly tpR = new TruePeakDetector();

  // Windowing for LUFS (Momentary: 400ms, Short-term: 3s)
  private readonly momentaryWindowSamples: number;
  private readonly shortTermWindowSamples: number;
  private readonly momentaryHistory: Float32Array; // L^2 + R^2 history
  private momentaryHistoryPos = 0;
  private momentaryHistorySum = 0;
  /** Anzahl bislang gefüllter Historien-Slots (Normierung ab Start – sonst zu leise). */
  private filled = 0;

  /** Peak-Hold über ~20 ms (kein Sample-Verlust bei 60-Hz-Abfrage). */
  private readonly holdBlocks: number;
  private readonly peakHoldL: Float32Array;
  private readonly peakHoldR: Float32Array;
  private holdPos = 0;

  constructor(private sampleRate: number, sab?: SharedArrayBuffer) {
    const size = METER_LAYOUT.COUNT * Float32Array.BYTES_PER_ELEMENT;
    this.sab = sab ?? new SharedArrayBuffer(size);
    this.view = new Float32Array(this.sab);

    this.momentaryWindowSamples = Math.round(sampleRate * 0.4);
    this.shortTermWindowSamples = Math.round(sampleRate * 3.0);

    // For allocation-free windowing, we store block-sized energy sums.
    // Assuming 128 samples per block.
    const historySize = Math.ceil(this.shortTermWindowSamples / 128);
    this.momentaryHistory = new Float32Array(historySize);

    this.holdBlocks = Math.max(1, Math.round((0.02 * sampleRate) / 128));
    this.peakHoldL = new Float32Array(this.holdBlocks);
    this.peakHoldR = new Float32Array(this.holdBlocks);

    this.setupFilters();
  }

  private setupFilters() {
    const sr = this.sampleRate;
    // Stage 1: Pre-filter (High shelf)
    const f0 = 1681.97445095229;
    const G  = 3.99984385397334;
    const Q  = 0.707175236955419;

    const K  = Math.tan(Math.PI * f0 / sr);
    const Vh = Math.pow(10, G / 20);
    const Vb = Math.pow(Vh, 0.4996667741545416); // De Man: exakter Exponent statt √

    // BS.1770-4 Pre-Filter (Shelf) nach der Herleitung von De Man: Bandbreite
    // über K/Q (Q ≈ 1/√2, aber nicht exakt) – bei 48 kHz stimmen die Koeffizienten
    // mit der Tabelle der Norm überein (b0 = 1,53512485958697, a1 = −1,69065929318241).
    const a0 = 1 + K / Q + K * K;
    const b0 = (Vh + Vb * K / Q + K * K) / a0;
    const b1 = 2 * (K * K - Vh) / a0;
    const b2 = (Vh - Vb * K / Q + K * K) / a0;
    const a1 = 2 * (K * K - 1) / a0;
    const a2 = (1 - K / Q + K * K) / a0;

    this.filterL1.setCoefficients(b0, b1, b2, a1, a2);
    this.filterR1.setCoefficients(b0, b1, b2, a1, a2);

    // Stage 2: RLB filter (High pass)
    const f0_2 = 38.13547087602444;
    const Q_2  = 0.5003270373253902;
    const K_2  = Math.tan(Math.PI * f0_2 / sr);
    const b0_2 = 1 / (1 + K_2 / Q_2 + K_2 * K_2);
    const b1_2 = -2 * b0_2;
    const b2_2 = b0_2;
    const a1_2 = 2 * b0_2 * (K_2 * K_2 - 1);
    const a2_2 = b0_2 * (1 - K_2 / Q_2 + K_2 * K_2);

    this.filterL2.setCoefficients(b0_2, b1_2, b2_2, a1_2, a2_2);
    this.filterR2.setCoefficients(b0_2, b1_2, b2_2, a1_2, a2_2);
  }

  processBlock(left: Float32Array, right: Float32Array) {
    const len = left.length;
    let pL = 0;
    let pR = 0;
    let blockSumL2 = 0;
    let blockSumR2 = 0;
    let blockCorrSum = 0;
    let blockL2 = 0;
    let blockR2 = 0;
    let tpPeakL = 0;
    let tpPeakR = 0;

    for (let i = 0; i < len; i++) {
      const sL = left[i];
      const sR = right[i];

      // Peak
      const aL = Math.abs(sL);
      const aR = Math.abs(sR);
      if (aL > pL) pL = aL;
      if (aR > pR) pR = aR;

      // True-Peak (4×-Oversampling-FIR, BS.1770-4)
      const tL = this.tpL.push(sL);
      if (tL > tpPeakL) tpPeakL = tL;
      const tR = this.tpR.push(sR);
      if (tR > tpPeakR) tpPeakR = tR;

      // RMS / Energy
      blockL2 += sL * sL;
      blockR2 += sR * sR;
      blockCorrSum += sL * sR;

      // K-Weighting for LUFS
      const kL = this.filterL2.process(this.filterL1.process(sL));
      const kR = this.filterR2.process(this.filterR1.process(sR));
      blockSumL2 += kL * kL;
      blockSumR2 += kR * kR;
    }

    // Peak + True-Peak in den SAB
    this.view[METER_LAYOUT.PEAK_L] = pL;
    this.view[METER_LAYOUT.PEAK_R] = pR;
    this.view[METER_LAYOUT.TRUE_PEAK_L] = tpPeakL;
    this.view[METER_LAYOUT.TRUE_PEAK_R] = tpPeakR;

    // Peak-Hold (~20 ms) – verhindert Sample-Verlust bei 60-Hz-Abfrage.
    const hp = this.holdPos;
    this.peakHoldL[hp] = pL;
    this.peakHoldR[hp] = pR;
    this.holdPos = (hp + 1) % this.holdBlocks;
    let holdL = 0;
    let holdR = 0;
    for (let i = 0; i < this.holdBlocks; i++) {
      if (this.peakHoldL[i] > holdL) holdL = this.peakHoldL[i];
      if (this.peakHoldR[i] > holdR) holdR = this.peakHoldR[i];
    }
    this.view[METER_LAYOUT.PEAK_HOLD_L] = holdL;
    this.view[METER_LAYOUT.PEAK_HOLD_R] = holdR;

    // RMS (block-based)
    this.view[METER_LAYOUT.RMS_L] = Math.sqrt(blockL2 / len);
    this.view[METER_LAYOUT.RMS_R] = Math.sqrt(blockR2 / len);

    // Correlation
    const denom = Math.sqrt(blockL2 * blockR2);
    this.view[METER_LAYOUT.CORRELATION] = denom > 1e-9 ? blockCorrSum / denom : 0;

    // LUFS: BS.1770-4 SUMMIERT die mittleren Leistungen der Kanäle (G_L = G_R = 1),
    // es wird nicht gemittelt – sonst misst Stereo 3 dB zu leise.
    const blockEnergy = (blockSumL2 + blockSumR2) / len;

    // Windowing history
    const oldEnergy = this.momentaryHistory[this.momentaryHistoryPos];
    this.momentaryHistory[this.momentaryHistoryPos] = blockEnergy;
    this.momentaryHistorySum += blockEnergy - oldEnergy;
    this.momentaryHistoryPos = (this.momentaryHistoryPos + 1) % this.momentaryHistory.length;
    if (this.filled < this.momentaryHistory.length) this.filled++;

    // LUFS Calculation
    // Momentary: die letzten 400 ms (bzw. so viele Blöcke wie seit Start gefüllt).
    const mSteps = Math.min(this.filled, Math.ceil(this.momentaryWindowSamples / len));
    let mSum = 0;
    for (let i = 1; i <= mSteps; i++) {
      const idx = (this.momentaryHistoryPos - i + this.momentaryHistory.length) % this.momentaryHistory.length;
      mSum += this.momentaryHistory[idx];
    }
    const mEnergy = mSteps > 0 ? mSum / mSteps : 0;
    this.view[METER_LAYOUT.LUFS_M] = mEnergy > 1e-12 ? -0.691 + 10 * Math.log10(mEnergy) : -70;

    // Short-term: bis zu 3 s (bzw. so viele Blöcke wie seit Start gefüllt).
    const sEnergy = this.filled > 0 ? this.momentaryHistorySum / this.filled : 0;
    this.view[METER_LAYOUT.LUFS_S] = sEnergy > 1e-12 ? -0.691 + 10 * Math.log10(sEnergy) : -70;

    // Wellenform-Ring (linker Kanal) für die Anzeige.
    const wf = METER_LAYOUT.WAVEFORM_START;
    const wl = len < METER_LAYOUT.WAVEFORM_LEN ? len : METER_LAYOUT.WAVEFORM_LEN;
    for (let i = 0; i < wl; i++) this.view[wf + i] = left[i];
  }

  getSharedBuffer(): SharedArrayBuffer {
    return this.sab;
  }

  /**
   * Zählt einen Underrun. Jeder Zähler hat genau EINEN Schreiber (Worklet bzw.
   * Main-Thread), daher reicht ein Float32-Inkrement im selben Layout wie alle
   * anderen Felder – kein Int32-Bitmuster in der Float32-Sicht, keine Allokation.
   */
  recordUnderrun(isWorklet: boolean) {
    const idx = isWorklet ? METER_LAYOUT.UNDERRUNS_WORKLET : METER_LAYOUT.UNDERRUNS_MAIN;
    this.view[idx] += 1;
  }
}
