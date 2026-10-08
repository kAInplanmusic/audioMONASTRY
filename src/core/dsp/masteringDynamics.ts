/**
 * audioMONASTRY · Mastering-Dynamics-Kern (RT-AUDIT-P0-004)
 * =========================================================
 * Reiner Rechenkern der Masterkette – ohne Audio-Kontext, DOM oder Worklet-API.
 * Ihn nutzen BEIDE Seiten, damit es nur EINE Mastering-Logik gibt:
 *
 *   * `src/core/audio/nodes/processingNodes.ts` – `MasteringNode` im V2-Graphen
 *     (Live-Pfad im v2SinkProcessor, Offline-Bounce, C0-Kette).
 *   * `src/audio/worklets/masteringProcessor.ts` – Legacy-Worklet (wird vom
 *     audioEngine erzeugt, hängt aber nicht im hörbaren Pfad).
 *
 * Signalfluss je Sample (alle Kanäle gekoppelt, „linked stereo“):
 *
 *   x ─► Kompressor (Feed-forward, Soft-Knee) ─► · Makeup ─► y
 *   y ─► Delay-Line (lookaheadSamples) ───────────────────────► y[n−L] · g ─► Sicherung ±ceiling
 *   y ─► Limiter-Detektor (Sample- bzw. True-Peak) ─► Ziel-Gain ─► gleitendes Minimum
 *        ─► exponentielles Release ─► Attack-Rampe (Rechteck-Mittel) ─► g
 *
 * 1. Kompressor (Giannoulis/Massberg/Reiss, „Digital Dynamic Range Compressor
 *    Design – A Tutorial and Analysis“, JAES 60(6), 2012):
 *    Pegel im log-Bereich (Maximum |x| über Kanäle → dBFS), Gain-Computer =
 *    `compressorCurveDb` (Soft-Knee), Glättung der Gain-Reduction im dB-Bereich
 *    mit dem *smooth decoupled peak detector* (Gl. 17):
 *        y1[n] = max(xG[n], αR·y1[n−1] + (1−αR)·xG[n])
 *        yL[n] = αA·yL[n−1] + (1−αA)·y1[n]
 *    Dadurch regelt der Kompressor NICHT mehr aus dem Momentanpegel (vorher
 *    wirkte er wie ein statischer Waveshaper: 17,4 % THD bei −6 dBFS).
 * 2. Limiter mit echtem Lookahead: Der Detektor liest den EINGANG des Limiters
 *    (das kommende Signal), das Audio läuft um `lookaheadSamples` verzögert
 *    hinterher. Ziel-Gain je Sample min(1, ceiling/|y|), gleitendes Minimum
 *    (monotone Deque, vorallokiert) über das Fenster, exponentielles Release,
 *    danach ein gleitender Mittelwert über das Lookahead als lineare
 *    Attack-Rampe. Weil jedes Element im Mittelungsfenster ≤ Ziel-Gain des
 *    gerade ausgegebenen Samples ist, gilt |Ausgang| ≤ ceiling ohne Clipping.
 * 3. True-Peak (ITU-R BS.1770-4, Annex 2): 4×-Oversampling mit dem
 *    polyphasigen 48-Tap-FIR der Norm (4 Phasen × 12 Taps). Der Detektor sieht
 *    damit auch Inter-Sample-Peaks; seine Gruppenlaufzeit (5–6 Samples) wird
 *    über die Fensterlängen ausgeglichen, die Gesamtlatenz bleibt
 *    `lookaheadSamples`.
 * 4. Harte Sicherung ±ceiling hinter dem Limiter: reines Sicherheitsnetz.
 *    `safetyClipCount` zählt Eingriffe (bei korrekter Funktion 0).
 *
 * Echtzeit-Regeln (AGENTS.md §5, RT-AUDIT-P0-002): `process()` alloziert nicht,
 * nutzt keine Closures/Iteratoren und wirft nicht. Speicher wird nur in
 * `configure()` angelegt – beim Start und bei Sample-Rate-/Kanalzahl-Wechsel.
 */
import { compressorCurveDb, smoothingCoefficient, toDb } from './dynamicsMath';
import { v2MasteringLookaheadSamples } from '../audio/live/v2Pdc';

/**
 * Default-Einstellungen der Masterkette (eine Quelle für Node und Worklet).
 *  - threshold −14 dBFS, ratio 3:1, knee 6 dB, makeup 1 (linear)
 *  - ceiling 0,98 (≈ −0,18 dBFS)
 *  - release 50 ms: Limiter-Release (Zeitkonstante)
 *  - compAttack 10 ms / compRelease 100 ms: Kompressor-Attack/-Release
 *    (Zeitkonstanten des Detektors, Werte nach Giannoulis et al. 2012 typisch
 *    für Bus-Kompression; 10 ms lassen Transienten stehen, 100 ms pumpen nicht)
 */
export const MASTERING_DEFAULTS = Object.freeze({
  threshold: -14,
  ratio: 3,
  knee: 6,
  makeup: 1,
  ceiling: 0.98,
  release: 0.05,
  compAttack: 0.01,
  compRelease: 0.1,
});

/** Lookahead der Masterkette in Samples (dieselbe Quelle wie die PDC). */
export function masteringLookaheadSamples(sampleRate: number): number {
  return v2MasteringLookaheadSamples(sampleRate);
}

const TP_TAPS = 12;
const TP_PHASES = 4;
/**
 * ITU-R BS.1770-4, Annex 2: Interpolations-FIR für 4×-Oversampling,
 * 48 Taps in 4 Phasen à 12 (Tap k gewichtet x[n−k]).
 */
const TP_COEFFS = new Float64Array([
  // Phase 0
  0.0017089843750, 0.0109863281250, -0.0196533203125, 0.0332031250000,
  -0.0594482421875, 0.1373291015625, 0.9721679687500, -0.1022949218750,
  0.0476074218750, -0.0266113281250, 0.0148925781250, -0.0083007812500,
  // Phase 1
  -0.0291748046875, 0.0292968750000, -0.0517578125000, 0.0891113281250,
  -0.1665039062500, 0.4650878906250, 0.7797851562500, -0.2003173828125,
  0.1015625000000, -0.0582275390625, 0.0330810546875, -0.0189208984375,
  // Phase 2
  -0.0189208984375, 0.0330810546875, -0.0582275390625, 0.1015625000000,
  -0.2003173828125, 0.7797851562500, 0.4650878906250, -0.1665039062500,
  0.0891113281250, -0.0517578125000, 0.0292968750000, -0.0291748046875,
  // Phase 3
  -0.0083007812500, 0.0148925781250, -0.0266113281250, 0.0476074218750,
  -0.1022949218750, 0.9721679687500, 0.1373291015625, -0.0594482421875,
  0.0332031250000, -0.0196533203125, 0.0109863281250, 0.0017089843750,
]);
/**
 * Die vier Phasen liegen zwischen x[n−6] und x[n−5] (Maxima der Phasen bei den
 * Taps 5/6). Der True-Peak-Wert, der bei Ankunft n entsteht, gilt deshalb für
 * die Ausgangs-Samples n−6 und n−5 – das gleichen die Fensterlängen aus.
 */
const TP_DELAY_MIN = 5;
const TP_DELAY_MAX = 6;
/**
 * Obere Schranke der FIR-Verstärkung: max über die Phasen von Σ|h| (≈ 2,02).
 * Ist max|y| der letzten 12 Samples · TP_ABS_GAIN ≤ ceiling, kann keine Phase
 * das Ceiling überschreiten (Dreiecksungleichung) – der FIR entfällt dann
 * exakt ohne Genauigkeitsverlust.
 */
const TP_ABS_GAIN = ((): number => {
  let max = 0;
  for (let p = 0; p < TP_PHASES; p++) {
    let sum = 0;
    for (let k = 0; k < TP_TAPS; k++) sum += Math.abs(TP_COEFFS[p * TP_TAPS + k]);
    if (sum > max) max = sum;
  }
  return max;
})();

/** dB → ln-Faktor für exp() (schneller als Math.pow pro Sample). */
const DB_TO_LN = Math.LN10 / 20;
/** Unter dieser Gain-Reduction (dB) wird auf 0 gesetzt (Denormal-Schutz, unhörbar). */
const GR_FLOOR_DB = 1e-9;
/** Relativer Spielraum, ab dem die Sicherung als echter Eingriff zählt (Rundung ignorieren). */
const SAFETY_REL_EPS = 1e-9;

export interface MasteringDynamicsOptions {
  /** True-Peak-Detektor (4×-Oversampling, BS.1770-4). Default: an. */
  truePeak?: boolean;
}

export class MasteringDynamics {
  /** Kompressor-Threshold in dBFS. */
  threshold: number = MASTERING_DEFAULTS.threshold;
  /** Kompressor-Ratio (≥ 1). */
  ratio: number = MASTERING_DEFAULTS.ratio;
  /** Soft-Knee-Breite in dB. */
  knee: number = MASTERING_DEFAULTS.knee;
  /** Makeup-Gain (linear), vor dem Limiter. */
  makeup: number = MASTERING_DEFAULTS.makeup;
  /** Limiter-Ceiling (linear, Sample- bzw. True-Peak). */
  ceiling: number = MASTERING_DEFAULTS.ceiling;
  /** One-Pole-Koeffizienten (1 − α), siehe `smoothingCoefficient`. */
  compAttackCoef = 1;
  compReleaseCoef = 1;
  limiterReleaseCoef = 1;

  readonly truePeak: boolean;

  private sr = 0;
  private lookahead = 0;
  private channels = 0;
  /** Delay-Line je Kanal (Länge = lookahead, read-before-write). */
  private delay: Float32Array[] = [];
  private delayPos = 0;
  /** Verzögerte Samples des aktuellen Frames (je Kanal). */
  private delayed = new Float64Array(0);
  /** True-Peak-Historie je Kanal, doppelt abgelegt (2·TAPS) → kein Modulo pro Tap. */
  private tpHist: Float64Array[] = [];
  private tpPos = 0;
  /** max|y| über alle Kanäle je Frame (letzte TP_TAPS Frames) – für die FIR-Abkürzung. */
  private readonly tpFramePeak = new Float64Array(TP_TAPS);

  // Kompressor-Zustand (dB): y1 = Release-Peak, yL = geglättete Gain-Reduction.
  private compPeakDb = 0;
  private compGrDb = 0;

  // Limiter-Zustand.
  /** Fensterlänge des gleitenden Minimums (Ankünfte). */
  private window = 1;
  /** Länge der Attack-Rampe (Rechteck-Mittel). */
  private boxLen = 1;
  private dqVal = new Float64Array(1);
  private dqIdx = new Float64Array(1);
  private dqHead = 0;
  private dqSize = 0;
  /** Laufender Ankunftszähler (double: exakt bis 2^53 Samples). */
  private arrival = 0;
  private env = 1;
  private box = new Float64Array(1);
  private boxPos = 0;
  private boxSum = 1;
  /** Anzahl der Einträge < 1 im Rechteck-Fenster (exakte Rückkehr auf Gain 1). */
  private boxBelow = 0;
  private limiterGain = 1;

  private attackSec = Number.NaN;
  private compReleaseSec = Number.NaN;
  private limiterReleaseSec = Number.NaN;

  /** Eingriffe der harten Sicherung hinter dem Limiter (Soll: 0). */
  safetyClipCount = 0;

  constructor(sampleRate = 48000, channels = 2, options: MasteringDynamicsOptions = {}) {
    this.truePeak = options.truePeak ?? true;
    this.configure(sampleRate, channels);
    this.setTimes(MASTERING_DEFAULTS.compAttack, MASTERING_DEFAULTS.compRelease, MASTERING_DEFAULTS.release);
  }

  /** Lookahead (= Latenz) in Samples. */
  get lookaheadSamples(): number {
    return this.lookahead;
  }

  /** Latenz in Sekunden (lookaheadSamples / sampleRate). */
  get latencySeconds(): number {
    return this.sr > 0 ? this.lookahead / this.sr : 0;
  }

  get sampleRate(): number {
    return this.sr;
  }

  /** Aktuelle Gain-Reduction des Kompressors in dB (≥ 0). */
  get gainReductionDb(): number {
    return this.compGrDb;
  }

  /** Aktuelle Gain-Reduction des Limiters in dB (≥ 0). */
  get limiterGainReductionDb(): number {
    return this.limiterGain >= 1 ? 0 : -toDb(this.limiterGain);
  }

  /**
   * Legt Speicher an bzw. passt ihn an. Nur hier wird alloziert: bei neuer
   * Sample-Rate komplett (Lookahead ändert sich, Zustand wird zurückgesetzt),
   * bei mehr Kanälen nur die zusätzlichen Leitungen. Im eingeschwungenen
   * Zustand ein reiner Vergleich (pro Block aufrufbar).
   */
  configure(sampleRate: number, channels: number): void {
    const sr = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 48000;
    const chans = Math.max(1, Math.floor(channels) || 1);
    if (sr !== this.sr) {
      this.sr = sr;
      this.lookahead = masteringLookaheadSamples(sr);
      const L = this.lookahead;
      const dMin = this.truePeak ? TP_DELAY_MIN : 0;
      const dMax = this.truePeak ? TP_DELAY_MAX : 0;
      // Ankunft n gilt für Ausgang n−dMax … n−dMin; Ausgang n' ist y[n'−L].
      // Erzwungen werden die Ankünfte [n'−window+1, n'−boxLen+1].
      this.window = L - dMin + 1;
      this.boxLen = L - dMax + 1;
      this.dqVal = new Float64Array(this.window);
      this.dqIdx = new Float64Array(this.window);
      this.box = new Float64Array(this.boxLen);
      this.channels = 0;
      this.delay = [];
      this.tpHist = [];
      // Sample-Rate geändert: alte Zeitkonstanten neu umrechnen.
      const a = this.attackSec;
      const cr = this.compReleaseSec;
      const lr = this.limiterReleaseSec;
      this.attackSec = this.compReleaseSec = this.limiterReleaseSec = Number.NaN;
      if (Number.isFinite(a)) this.setTimes(a, cr, lr);
    }
    if (chans > this.channels) {
      for (let ch = this.channels; ch < chans; ch++) {
        this.delay[ch] = new Float32Array(this.lookahead);
        this.tpHist[ch] = new Float64Array(2 * TP_TAPS);
      }
      this.delayed = new Float64Array(chans);
      if (this.channels === 0) this.resetState();
      this.channels = chans;
    }
  }

  /**
   * Zeitkonstanten in Sekunden; rechnet die Koeffizienten nur bei Änderung neu
   * (pro Block aufrufbar, ohne `Math.exp` im eingeschwungenen Zustand).
   */
  setTimes(compAttackSec: number, compReleaseSec: number, limiterReleaseSec: number): void {
    if (compAttackSec !== this.attackSec) {
      this.attackSec = compAttackSec;
      this.compAttackCoef = smoothingCoefficient(compAttackSec, this.sr);
    }
    if (compReleaseSec !== this.compReleaseSec) {
      this.compReleaseSec = compReleaseSec;
      this.compReleaseCoef = smoothingCoefficient(compReleaseSec, this.sr);
    }
    if (limiterReleaseSec !== this.limiterReleaseSec) {
      this.limiterReleaseSec = limiterReleaseSec;
      this.limiterReleaseCoef = smoothingCoefficient(limiterReleaseSec, this.sr);
    }
  }

  /** Setzt den Limiter-Release-Koeffizienten direkt (z. B. aus einer Lookup-Tabelle). */
  setLimiterReleaseCoefficient(coef: number, releaseSec: number): void {
    this.limiterReleaseSec = releaseSec;
    this.limiterReleaseCoef = coef;
  }

  /** Leert Delay-Line, Detektoren und Zähler (Speicher bleibt). */
  reset(): void {
    for (let ch = 0; ch < this.channels; ch++) {
      this.delay[ch].fill(0);
      this.tpHist[ch].fill(0);
    }
    this.tpFramePeak.fill(0);
    this.resetState();
  }

  private resetState(): void {
    this.delayPos = 0;
    this.tpPos = 0;
    this.compPeakDb = 0;
    this.compGrDb = 0;
    this.dqHead = 0;
    this.dqSize = 0;
    this.arrival = 0;
    this.env = 1;
    this.box.fill(1);
    this.boxPos = 0;
    this.boxSum = this.boxLen;
    this.boxBelow = 0;
    this.limiterGain = 1;
    this.safetyClipCount = 0;
  }

  /**
   * Verarbeitet die Samples [start, end) von `buf` in place. Es werden
   * höchstens so viele Kanäle verarbeitet, wie per `configure()` angelegt sind.
   * Allokationsfrei.
   */
  process(buf: Float32Array[], start: number, end: number): void {
    const chans = buf.length < this.channels ? buf.length : this.channels;
    if (chans === 0) return;
    const L = this.lookahead;
    const threshold = this.threshold;
    const ratio = this.ratio;
    const knee = this.knee;
    const kneeLow = threshold - Math.max(0, knee) / 2;
    // Unterhalb des Knies ist die Gain-Reduction 0 – dort entfällt der log10.
    const kneeLowLin = Math.exp(kneeLow * DB_TO_LN);
    const makeup = Number.isFinite(this.makeup) ? this.makeup : 1;
    const ceiling = this.ceiling > 0 ? this.ceiling : 1e-6;
    const safetyLimit = ceiling * (1 + SAFETY_REL_EPS);
    const aA = this.compAttackCoef;
    const aR = this.compReleaseCoef;
    const lr = this.limiterReleaseCoef;
    const W = this.window;
    const B = this.boxLen;
    const cap = this.dqVal.length;
    const dqVal = this.dqVal;
    const dqIdx = this.dqIdx;
    const box = this.box;
    const delay = this.delay;
    const delayed = this.delayed;
    const tpHist = this.tpHist;
    const truePeak = this.truePeak;
    let y1 = this.compPeakDb;
    let yL = this.compGrDb;

    for (let i = start; i < end; i++) {
      // 1) Eingang säubern, Pegel = Maximum |x| über alle Kanäle.
      let peak = 0;
      for (let ch = 0; ch < chans; ch++) {
        const x = buf[ch][i];
        if (!Number.isFinite(x)) {
          buf[ch][i] = 0;
          continue;
        }
        const a = x < 0 ? -x : x;
        if (a > peak) peak = a;
      }

      // 2) Gain-Computer im log-Bereich (Soft-Knee), xG = Ziel-Gain-Reduction.
      let xG = 0;
      if (peak > kneeLowLin) {
        const levelDb = toDb(peak);
        if (levelDb > kneeLow) {
          xG = levelDb - compressorCurveDb(levelDb, threshold, ratio, knee);
          if (!(xG > 0)) xG = 0;
        }
      }

      // 3) Smooth decoupled peak detector (Giannoulis et al. 2012, Gl. 17).
      const relaxed = y1 + aR * (xG - y1);
      y1 = xG > relaxed ? xG : relaxed;
      yL += aA * (y1 - yL);
      if (y1 < GR_FLOOR_DB) y1 = 0;
      if (yL < GR_FLOOR_DB) yL = 0;
      const compGain = yL === 0 ? makeup : makeup * Math.exp(-yL * DB_TO_LN);

      // 4) Delay-Line (read-before-write) + Limiter-Detektor auf dem EINGANG.
      const pos = this.delayPos;
      const tpPos = this.tpPos;
      let detector = 0;
      for (let ch = 0; ch < chans; ch++) {
        const line = delay[ch];
        const y = Math.fround(buf[ch][i] * compGain);
        delayed[ch] = line[pos];
        line[pos] = y;
        const a = y < 0 ? -y : y;
        if (a > detector) detector = a;
        if (truePeak) {
          const hist = tpHist[ch];
          hist[tpPos] = y;
          hist[tpPos + TP_TAPS] = y;
        }
      }
      this.delayPos = pos + 1 === L ? 0 : pos + 1;
      if (truePeak) {
        // detector ist hier max|y[n]|; True-Peak bewertet das Intervall [n−6, n−5].
        const framePeak = this.tpFramePeak;
        framePeak[tpPos] = detector;
        let recent = 0;
        for (let k = 0; k < TP_TAPS; k++) if (framePeak[k] > recent) recent = framePeak[k];
        let p5 = tpPos - TP_DELAY_MIN;
        if (p5 < 0) p5 += TP_TAPS;
        let p6 = tpPos - TP_DELAY_MAX;
        if (p6 < 0) p6 += TP_TAPS;
        detector = framePeak[p5] > framePeak[p6] ? framePeak[p5] : framePeak[p6];
        if (recent * TP_ABS_GAIN > ceiling) {
          // Nur wenn ein Inter-Sample-Peak das Ceiling erreichen KANN: 4×-FIR.
          // hist[tpPos + TAPS − k] = y[n − k]
          const base = tpPos + TP_TAPS;
          for (let ch = 0; ch < chans; ch++) {
            const hist = tpHist[ch];
            for (let p = 0; p < TP_PHASES; p++) {
              const off = p * TP_TAPS;
              let s = 0;
              for (let k = 0; k < TP_TAPS; k++) s += TP_COEFFS[off + k] * hist[base - k];
              if (s < 0) s = -s;
              if (s > detector) detector = s;
            }
          }
        }
        this.tpPos = tpPos + 1 === TP_TAPS ? 0 : tpPos + 1;
      }

      // 5) Ziel-Gain und gleitendes Minimum (monotone Deque, Kapazität = Fenster).
      const target = detector > ceiling ? ceiling / detector : 1;
      const n = this.arrival;
      let head = this.dqHead;
      let size = this.dqSize;
      // Erst Verfallenes entfernen (Index ≤ n − W), dann einfügen: so liegen
      // höchstens W − 1 alte + 1 neuer Eintrag in der Deque (Kapazität W) –
      // auch bei streng steigenden Zielwerten über das ganze Fenster.
      while (size > 0 && dqIdx[head] <= n - W) {
        head = head + 1 === cap ? 0 : head + 1;
        size--;
      }
      while (size > 0) {
        let back = head + size - 1;
        if (back >= cap) back -= cap;
        if (dqVal[back] < target) break;
        size--;
      }
      let slot = head + size;
      if (slot >= cap) slot -= cap;
      dqVal[slot] = target;
      dqIdx[slot] = n;
      size++;
      this.dqHead = head;
      this.dqSize = size;
      this.arrival = n + 1;
      const windowMin = dqVal[head];

      // 6) Exponentielles Release (Attack sofort – die Rampe macht Schritt 7).
      let env = this.env;
      if (windowMin <= env) env = windowMin;
      else {
        env += lr * (windowMin - env);
        if (windowMin - env < 1e-12) env = windowMin;
      }
      this.env = env;

      // 7) Attack-Rampe: gleitender Mittelwert über das Lookahead.
      const bp = this.boxPos;
      const old = box[bp];
      box[bp] = env;
      this.boxSum += env - old;
      if (old < 1) this.boxBelow--;
      if (env < 1) this.boxBelow++;
      this.boxPos = bp + 1 === B ? 0 : bp + 1;
      let gain: number;
      if (this.boxBelow === 0) {
        this.boxSum = B; // Rundungsdrift verwerfen: exakt transparent.
        gain = 1;
      } else {
        gain = this.boxSum / B;
        if (gain > 1) gain = 1;
      }
      this.limiterGain = gain;

      // 8) Ausgang = verzögertes Signal · Gain, harte Sicherung ±ceiling.
      for (let ch = 0; ch < chans; ch++) {
        let v = delayed[ch] * gain;
        if (v > ceiling) {
          if (v > safetyLimit) this.safetyClipCount++;
          v = ceiling;
        } else if (v < -ceiling) {
          if (v < -safetyLimit) this.safetyClipCount++;
          v = -ceiling;
        }
        buf[ch][i] = v;
      }
    }

    this.compPeakDb = y1;
    this.compGrDb = yL;
  }
}
