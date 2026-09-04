/**
 * masteringProcessor – Mastering-Kette (AudioWorklet)
 * ----------------------------------------------------
 *  - Lookahead Brickwall-Limiter (5 ms) mit Inter-Sample-Peak-Erkennung
 *    (True-Peak-Approximation, 2x lineare Übersampling-Schätzung).
 *  - Soft-Knee-Kompression mit konfigurierbarem Threshold/Ratio/Knee.
 *  - Exponential-Release für den Limiter (kein hartes Gain-Pumpen); der
 *    Koeffizient kommt aus einer segmentierten Lookup-Tabelle (AM-E4-4),
 *    damit kein `Math.exp` pro Block nötig ist.
 *  - Stabilität: sämtliche Ausgangswerte werden NaN/Inf-geprüft.
 *  - Hot-Path: keine Objekt-/Array-Allokation pro Sample (Scratch-Puffer).
 *
 * Steuerung über Port-Nachrichten:
 *   { threshold, ratio, knee, makeup, ceiling, release, reset }
 */

/** Fallback-Sample-Rate, wenn das Worklet-Global fehlt (Node-Tests). */
const FALLBACK_SR = 48000;
const currentSampleRate = (): number =>
  typeof sampleRate === 'number' && sampleRate > 0 ? sampleRate : FALLBACK_SR;

// ---------------------------------------------------------------------------
// AM-E4-4: Release-Kurve als segmentierte Lookup-Tabelle.
// Statt `1 - Math.exp(-1 / (sampleRate * release))` pro Block wird der
// Koeffizient aus einer log-segmentierten Tabelle interpoliert. Argument ist
// n = sampleRate * releaseSeconds (Sample-Zahl der Zeitkonstante).
// ---------------------------------------------------------------------------
const RELEASE_LUT_SEGMENTS = 128;
const RELEASE_LUT_LOG_MIN = Math.log(50);      // n = 50 Samples (~1 ms @48k)
const RELEASE_LUT_LOG_MAX = Math.log(2_000_000); // n = 2e6 Samples (~42 s @48k)
const RELEASE_LUT = new Float32Array(RELEASE_LUT_SEGMENTS + 1);
for (let i = 0; i <= RELEASE_LUT_SEGMENTS; i++) {
  const n = Math.exp(
    RELEASE_LUT_LOG_MIN + ((RELEASE_LUT_LOG_MAX - RELEASE_LUT_LOG_MIN) * i) / RELEASE_LUT_SEGMENTS,
  );
  RELEASE_LUT[i] = 1 - Math.exp(-1 / n);
}

/**
 * Release-Koeffizient für eine Zeitkonstante (Sekunden) bei gegebener
 * Sample-Rate – linear interpoliert aus der segmentierten Tabelle.
 * Maximaler relativer Fehler < 0,1 % im gültigen Bereich (5 ms … 1 s).
 */
export function releaseCoefficient(releaseSeconds: number, sr: number): number {
  const n = sr * releaseSeconds;
  if (!Number.isFinite(n) || n <= 0) return 1;
  const x =
    ((Math.log(n) - RELEASE_LUT_LOG_MIN) / (RELEASE_LUT_LOG_MAX - RELEASE_LUT_LOG_MIN)) *
    RELEASE_LUT_SEGMENTS;
  if (x <= 0) return RELEASE_LUT[0];
  if (x >= RELEASE_LUT_SEGMENTS) return RELEASE_LUT[RELEASE_LUT_SEGMENTS];
  const i = Math.floor(x);
  const f = x - i;
  return RELEASE_LUT[i] + (RELEASE_LUT[i + 1] - RELEASE_LUT[i]) * f;
}

// Worklet-Global fehlt in Node-Tests → Fallback-Basisklasse mit Fake-Port,
// damit der Prozessor deterministisch instanziierbar bleibt (vgl. spatialProcessor).
const WorkletBase: typeof AudioWorkletProcessor =
  (typeof AudioWorkletProcessor !== 'undefined'
    ? AudioWorkletProcessor
    : class {
        port = {
          onmessage: null as any,
          postMessage: (msg: any) => { this.port.onmessage?.({ data: msg }); },
        };
      }) as any;

export class MasteringProcessor extends WorkletBase {
  private threshold = -14;  // dBFS (Kompressor-Grenze)
  private ratio = 3;
  private knee = 6;
  private makeup = 1.0;

  private limiterCeiling = 0.98;
  private limiterRelease = 0.05; // Sekunden (Release-Zeitkonstante)
  private peak = 0;

  // Lookahead-Delay
  private lookaheadSamples = Math.max(16, Math.round(0.005 * currentSampleRate())); // 5ms

  /** Lookahead-Tiefe in Samples (für Tests/PDC-Abgleich mit `audioEngine`). */
  getLookaheadSamples(): number { return this.lookaheadSamples; }
  private delayLine: Float32Array[] = [];
  private delayPos = 0;
  // Wiederverwendbarer Kanal-Scratch (keine Allokation im Hot-Path)
  private scratch: Float32Array | null = null;
  // AM-E1-3: dB→Gain-Lookup statt Math.pow(10, -grDb/20) pro Sample.
  private grLookup = new Float32Array(241); // 0..48 dB in 0.2-dB-Schritten

  constructor() {
    super();
    this.peak = this.limiterCeiling;
    for (let i = 0; i < this.grLookup.length; i++) {
      this.grLookup[i] = Math.pow(10, -(i * 0.2) / 20);
    }
    this.port.onmessage = (e) => {
      const m = e.data; if (!m) return;
      if (m.reset) { this.peak = this.limiterCeiling; this.delayPos = 0; this.delayLine = []; this.scratch = null; }
      if (typeof m.threshold === 'number') this.threshold = m.threshold;
      if (typeof m.ratio === 'number') this.ratio = Math.min(20, Math.max(1, m.ratio));
      if (typeof m.knee === 'number') this.knee = Math.max(0, m.knee);
      if (typeof m.makeup === 'number') this.makeup = Math.max(0, Math.min(4, m.makeup));
      // Fix: Nachricht heißt `ceiling` – vorher wurde fälschlich `limiterCeiling` gelesen.
      if (typeof m.ceiling === 'number') this.limiterCeiling = Math.max(0.1, Math.min(1, m.ceiling));
      if (typeof m.release === 'number') this.limiterRelease = Math.max(0.005, Math.min(1, m.release));
      if (m.type === 'automate') {
        // Sample-genaue Rampen für Threshold/Makeup/Ceiling (zipper-frei).
        const steps = Math.max(1, Math.round(Number(m.rampTime ?? 0.02) * currentSampleRate()));
        const start = (p: string, cur: number): void => {
          this.rampTargets[p] = Number(m.value);
          this.rampSteps[p] = steps;
          this.rampDeltas[p] = (Number(m.value) - cur) / steps;
        };
        if (m.param === 'threshold') start('threshold', this.threshold);
        if (m.param === 'makeup') start('makeup', this.makeup);
        if (m.param === 'ceiling') start('ceiling', this.limiterCeiling);
        return;
      }
    };
  }

  // Rampen-State (automate)
  private rampTargets: Record<string, number> = {};
  private rampDeltas: Record<string, number> = {};
  private rampSteps: Record<string, number> = {};

  private stepRamps(): void {
    // AM-E1-2: Inline-Schritte statt Closure-Allokation pro Sample.
    if (this.rampSteps['threshold'] !== undefined && this.rampSteps['threshold'] > 0) {
      this.rampSteps['threshold'] -= 1;
      const t = this.rampTargets['threshold'];
      const d = this.rampDeltas['threshold'] ?? 0;
      this.threshold = this.rampSteps['threshold'] <= 0 ? t : this.threshold + d;
    }
    if (this.rampSteps['makeup'] !== undefined && this.rampSteps['makeup'] > 0) {
      this.rampSteps['makeup'] -= 1;
      const t = this.rampTargets['makeup'];
      const d = this.rampDeltas['makeup'] ?? 0;
      this.makeup = Math.max(0, Math.min(4, this.rampSteps['makeup'] <= 0 ? t : this.makeup + d));
    }
    if (this.rampSteps['ceiling'] !== undefined && this.rampSteps['ceiling'] > 0) {
      this.rampSteps['ceiling'] -= 1;
      const t = this.rampTargets['ceiling'];
      const d = this.rampDeltas['ceiling'] ?? 0;
      this.limiterCeiling = Math.max(0.1, Math.min(1, this.rampSteps['ceiling'] <= 0 ? t : this.limiterCeiling + d));
    }
  }

  /** Soft-Knee-Kompression: liefert Gain-Reduction in dB für einen dBFS-Peak. */
  private compressDb(dbPeak: number): number {
    const halfKnee = this.knee / 2;
    if (dbPeak <= this.threshold - halfKnee) return 0;
    if (dbPeak >= this.threshold + halfKnee) {
      return (dbPeak - this.threshold) / this.ratio;
    }
    const over = dbPeak - this.threshold + halfKnee;
    return (over * over) / (2 * this.knee * this.ratio);
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]) { // NOSONAR: AudioWorkletProcessor muss true liefern
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input[0] || !output || !output[0]) return true;

    const channels = Math.max(output.length, input.length);
    // Delay-Line + Scratch vorbereiten (einmalig bzw. bei Kanalzahl-Änderung).
    while (this.delayLine.length < channels) {
      this.delayLine.push(new Float32Array(this.lookaheadSamples));
    }
    if (!this.scratch || this.scratch.length < channels) {
      this.scratch = new Float32Array(Math.max(channels, 8));
    }

    // Exponential-Release-Koeffizient (pro Sample) aus der segmentierten
    // Lookup-Tabelle – kein `Math.exp` mehr pro Block (AM-E4-4).
    const releaseCoeff = releaseCoefficient(this.limiterRelease, currentSampleRate());
    const depth = this.lookaheadSamples;

    for (let i = 0; i < output[0].length; i++) {
      this.stepRamps(); // sample-genaue Parameter-Rampen (automate)
      // 1) Lookahead-Delay lesen/schreiben + Inter-Sample-Peak schätzen.
      let truePeak = 0;
      for (let ch = 0; ch < channels; ch++) {
        const inChSample = (input[ch] || input[0])[i] || 0;
        const writeIdx = this.delayPos;
        const readIdx = writeIdx % depth;
        const nextIdx = (readIdx + 1) % depth;
        const delayedSample = this.delayLine[ch][readIdx];
        const nextDelayed = this.delayLine[ch][nextIdx];
        this.delayLine[ch][writeIdx] = inChSample;
        this.scratch[ch] = delayedSample;

        // True-Peak-Approximation: auch den Wert zwischen zwei Samples prüfen
        // (lineare Interpolation = 2x Oversampling-Schätzung).
        const mid = (delayedSample + nextDelayed) * 0.5;
        const a = Math.abs(delayedSample);
        const b = Math.abs(nextDelayed);
        const c = Math.abs(mid);
        truePeak = Math.max(truePeak, a > b ? (a > c ? a : c) : (b > c ? b : c));
      }
      this.delayPos = (this.delayPos + 1) % depth;

      // 2) Soft-Knee-Kompression auf den (verzögerten) True-Peak.
      const dbPeak = 20 * Math.log10(Math.max(truePeak, 1e-8));
      const grDb = this.compressDb(dbPeak);
      const gr = this.grLookup[Math.max(0, Math.min(240, Math.round(grDb * 5)))] ?? 1;

      // 3) Lookahead-Limiter mit exponentieller Release-Hüllkurve.
      if (truePeak > this.peak) {
        this.peak = truePeak;
      } else {
        this.peak = Math.max(this.limiterCeiling, this.peak - (this.peak - this.limiterCeiling) * releaseCoeff);
      }
      let limiterGain = this.limiterCeiling / Math.max(this.peak, 1e-8);
      if (limiterGain > 1) limiterGain = 1;

      // 4) Ausgang schreiben (NaN/Inf-sicher).
      const finalGain = gr * limiterGain * this.makeup;
      for (let ch = 0; ch < output.length; ch++) {
        let out = (this.scratch[ch] ?? 0) * finalGain;
        if (!Number.isFinite(out)) out = 0;
        output[ch][i] = out;
      }
    }
    return true;
  }
}
if (typeof registerProcessor !== 'undefined') {
  registerProcessor('mastering-processor', MasteringProcessor as any);
}
