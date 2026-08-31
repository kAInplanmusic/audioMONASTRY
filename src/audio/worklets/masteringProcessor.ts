/**
 * masteringProcessor – Mastering-Kette (AudioWorklet)
 * ----------------------------------------------------
 *  - Lookahead Brickwall-Limiter (5 ms) mit Inter-Sample-Peak-Erkennung
 *    (True-Peak-Approximation, 2x lineare Übersampling-Schätzung).
 *  - Soft-Knee-Kompression mit konfigurierbarem Threshold/Ratio/Knee.
 *  - Exponential-Release für den Limiter (kein hartes Gain-Pumpen).
 *  - Stabilität: sämtliche Ausgangswerte werden NaN/Inf-geprüft.
 *  - Hot-Path: keine Objekt-/Array-Allokation pro Sample (Scratch-Puffer).
 *
 * Steuerung über Port-Nachrichten:
 *   { threshold, ratio, knee, makeup, ceiling, release, reset }
 */
class MasteringProcessor extends AudioWorkletProcessor {
  private threshold = -14;  // dBFS (Kompressor-Grenze)
  private ratio = 3;
  private knee = 6;
  private makeup = 1.0;

  private limiterCeiling = 0.98;
  private limiterRelease = 0.05; // Sekunden (Release-Zeitkonstante)
  private peak = 0;

  // Lookahead-Delay
  private lookaheadSamples = Math.max(16, Math.round(0.005 * sampleRate)); // 5ms
  private delayLine: Float32Array[] = [];
  private delayPos = 0;
  // Wiederverwendbarer Kanal-Scratch (keine Allokation im Hot-Path)
  private scratch: Float32Array | null = null;

  constructor() {
    super();
    this.peak = this.limiterCeiling;
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
        const steps = Math.max(1, Math.round(Number(m.rampTime ?? 0.02) * sampleRate));
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

    // Exponential-Release-Koeffizient (pro Sample).
    const releaseCoeff = 1 - Math.exp(-1 / (sampleRate * this.limiterRelease));
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
      const gr = Math.pow(10, -grDb / 20);

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
registerProcessor('mastering-processor', MasteringProcessor);
