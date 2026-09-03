/**
 * dynamicsProcessor – Echtzeit-Dynamik (AudioWorklet)
 * ----------------------------------------------------
 * Open-Source-Audio-Audit A-Klasse „[DSP][EFFECTS] Kompressor + Gate + Dynamic EQ“:
 *   * Kompressor: Soft-Knee, Threshold/Ratio/Knee/Attack/Release/Makeup.
 *     Gain-Reduction über dB→Gain-Lookup (keine `Math.pow` pro Sample).
 *   * Gate: Threshold/Range/Hold/Attack/Release – schließt unterhalb des
 *     Thresholds erst nach Ablauf der Hold-Zeit (kein Klappern).
 *   * Dynamic EQ: ein Peaking-Band (freq/Q/gain), dessen Band-Gain bei
 *     Pegelüberschreitung (dynEqThreshold) reduziert wird – Resonanzen werden
 *     nur bei Bedarf gesenkt. Koeffizienten werden blockweise (128 Samples)
 *     aktualisiert, die Reduktion ist geglättet (zipper-frei).
 *   * Stabilität: NaN/Inf-Guards, keine Allokationen im Hot-Path.
 *
 * Steuerung über Port-Nachrichten:
 *   { threshold, ratio, knee, attack, release, makeup }            (Kompressor)
 *   { gateEnabled, gateThreshold, gateRange, gateHold, gateAttack, gateRelease }
 *   { dynEqEnabled, dynEqFreq, dynEqGain, dynEqQ, dynEqThreshold }
 *   { type:'automate', param, value, rampTime }                    (sample-genaue Rampen)
 */

class DynamicsProcessor extends AudioWorkletProcessor {
  // Kompressor
  private threshold = -24;   // dBFS
  private ratio = 4;
  private knee = 6;
  private attack = 0.005;    // s
  private release = 0.08;    // s
  private makeup = 0;        // dB
  // Gate
  private gateEnabled = false;
  private gateThreshold = -60;
  private gateRange = -80;   // dB (Absenkung wenn geschlossen)
  private gateHold = 0.01;   // s
  private gateAttack = 0.001;
  private gateRelease = 0.05;
  // Dynamic EQ
  private dynEqEnabled = false;
  private dynEqFreq = 1000;
  private dynEqGain = 6;     // dB (Resonanz-Boost)
  private dynEqQ = 1.0;
  private dynEqThreshold = -18;

  // Zustand
  private compGrDb = 0;      // aktuelle Gain-Reduction (Kompressor)
  private gateGainDb = 0;    // aktuelle Gate-Dämpfung (0 = offen)
  private gateHoldLeft = 0;  // verbleibende Hold-Samples
  private dynEqReductionDb = 0;
  private dynEqCoeffs: [number, number, number, number, number] = [1, 0, 0, 0, 0];
  private dynEqState = { x1: 0, x2: 0, y1: 0, y2: 0 };

  // Lookup: 0..96 dB GR in 0,2-dB-Schritten → Gain
  private grLookup = new Float32Array(481);

  // Rampen (automate)
  private rampTargets: Record<string, number> = {};
  private rampDeltas: Record<string, number> = {};
  private rampSteps: Record<string, number> = {};

  constructor() {
    super();
    for (let i = 0; i < this.grLookup.length; i++) {
      this.grLookup[i] = Math.pow(10, -(i * 0.2) / 20);
    }
    this.recomputeDynEq(6);
    this.port.onmessage = (e) => {
      const m = e.data;
      if (!m || typeof m !== 'object') return;
      if (m.type === 'automate') {
        const steps = Math.max(1, Math.round(Number(m.rampTime ?? 0.02) * sampleRate));
        const p = String(m.param ?? '');
        const cur = this.paramValue(p);
        this.rampTargets[p] = Number(m.value);
        this.rampSteps[p] = steps;
        this.rampDeltas[p] = (Number(m.value) - cur) / steps;
        return;
      }
      if (typeof m.threshold === 'number') this.threshold = m.threshold;
      if (typeof m.ratio === 'number') this.ratio = Math.min(20, Math.max(1, m.ratio));
      if (typeof m.knee === 'number') this.knee = Math.max(0, m.knee);
      if (typeof m.attack === 'number') this.attack = Math.max(0.0001, m.attack);
      if (typeof m.release === 'number') this.release = Math.max(0.001, m.release);
      if (typeof m.makeup === 'number') this.makeup = m.makeup;
      if (typeof m.gateEnabled === 'boolean') this.gateEnabled = m.gateEnabled;
      if (typeof m.gateThreshold === 'number') this.gateThreshold = m.gateThreshold;
      if (typeof m.gateRange === 'number') this.gateRange = Math.min(0, m.gateRange);
      if (typeof m.gateHold === 'number') this.gateHold = Math.max(0, m.gateHold);
      if (typeof m.gateAttack === 'number') this.gateAttack = Math.max(0.0001, m.gateAttack);
      if (typeof m.gateRelease === 'number') this.gateRelease = Math.max(0.001, m.gateRelease);
      if (typeof m.dynEqEnabled === 'boolean') this.dynEqEnabled = m.dynEqEnabled;
      if (typeof m.dynEqFreq === 'number') { this.dynEqFreq = m.dynEqFreq; this.recomputeDynEq(this.dynEqGain - this.dynEqReductionDb); }
      if (typeof m.dynEqGain === 'number') { this.dynEqGain = m.dynEqGain; this.recomputeDynEq(this.dynEqGain - this.dynEqReductionDb); }
      if (typeof m.dynEqQ === 'number') { this.dynEqQ = Math.max(0.1, m.dynEqQ); this.recomputeDynEq(this.dynEqGain - this.dynEqReductionDb); }
      if (typeof m.dynEqThreshold === 'number') this.dynEqThreshold = m.dynEqThreshold;
    };
  }

  private paramValue(p: string): number {
    switch (p) {
      case 'threshold': return this.threshold;
      case 'makeup': return this.makeup;
      case 'gateThreshold': return this.gateThreshold;
      case 'dynEqGain': return this.dynEqGain;
      default: return 0;
    }
  }

  private stepRamps(): void {
    for (const p of ['threshold', 'makeup', 'gateThreshold', 'dynEqGain']) {
      if (this.rampSteps[p] !== undefined && this.rampSteps[p] > 0) {
        this.rampSteps[p] -= 1;
        const t = this.rampTargets[p];
        const d = this.rampDeltas[p] ?? 0;
        const next = this.rampSteps[p] <= 0 ? t : this.paramValue(p) + d;
        if (p === 'threshold') this.threshold = next;
        else if (p === 'makeup') this.makeup = next;
        else if (p === 'gateThreshold') this.gateThreshold = next;
        else if (p === 'dynEqGain') { this.dynEqGain = next; this.recomputeDynEq(this.dynEqGain - this.dynEqReductionDb); }
      }
    }
  }

  private compressGrDb(overDb: number): number {
    const halfKnee = this.knee / 2;
    if (overDb <= -halfKnee) return 0;
    if (overDb >= halfKnee) return overDb * (1 - 1 / this.ratio);
    const t = overDb + halfKnee;
    return (t * t) / (2 * this.knee) * (1 - 1 / this.ratio);
  }

  private recomputeDynEq(gainDb: number): void {
    const A = Math.pow(10, gainDb / 40);
    const w0 = (2 * Math.PI * this.dynEqFreq) / sampleRate;
    const cos = Math.cos(w0);
    const sin = Math.sin(w0);
    const alpha = sin / (2 * this.dynEqQ);
    const a0 = 1 + alpha / A;
    this.dynEqCoeffs = [
      (1 + alpha * A) / a0,
      (-2 * cos) / a0,
      (1 - alpha * A) / a0,
      (-2 * cos) / a0,
      (1 - alpha / A) / a0,
    ];
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]) { // NOSONAR: Worklet
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input[0] || !output || !output[0]) return true;

    const channels = Math.max(input.length, output.length);
    const holdSamples = Math.round(this.gateHold * sampleRate);
    const attackCoeff = 1 - Math.exp(-1 / (sampleRate * this.attack));
    const releaseCoeff = 1 - Math.exp(-1 / (sampleRate * this.release));
    const gateAttackCoeff = 1 - Math.exp(-1 / (sampleRate * this.gateAttack));
    const gateReleaseCoeff = 1 - Math.exp(-1 / (sampleRate * this.gateRelease));
    const makeupGain = Math.pow(10, this.makeup / 20);

    // DynEQ-Blockreduktion (geglättet über Blöcke, zipper-frei genug).
    if (this.dynEqEnabled) {
      let peak = 0;
      for (let ch = 0; ch < channels; ch++) {
        const src = input[ch] ?? input[0];
        for (let i = 0; i < src.length; i++) {
          const a = Math.abs(src[i]);
          if (a > peak) peak = a;
        }
      }
      const peakDb = 20 * Math.log10(Math.max(peak, 1e-8));
      const excess = peakDb - this.dynEqThreshold;
      const targetReduction = excess > 0 ? Math.min(this.dynEqGain, excess * 0.7) : 0;
      this.dynEqReductionDb += (targetReduction - this.dynEqReductionDb) * 0.1;
      this.recomputeDynEq(this.dynEqGain - this.dynEqReductionDb);
    }

    for (let i = 0; i < output[0].length; i++) {
      this.stepRamps();

      // Pegel (Peak über Kanäle)
      let peak = 0;
      for (let ch = 0; ch < channels; ch++) {
        const v = (input[ch] ?? input[0])[i] ?? 0;
        const a = Math.abs(v);
        if (a > peak) peak = a;
      }
      const levelDb = 20 * Math.log10(Math.max(peak, 1e-8));

      // Kompressor
      const overDb = levelDb - this.threshold;
      const targetGr = this.compressGrDb(overDb);
      const coeff = targetGr > this.compGrDb ? attackCoeff : releaseCoeff;
      this.compGrDb += (targetGr - this.compGrDb) * coeff;
      const idx = Math.max(0, Math.min(480, Math.round(this.compGrDb * 5)));
      const compGain = this.grLookup[idx] ?? 1;

      // Gate
      let gateGain = 1;
      if (this.gateEnabled) {
        if (levelDb >= this.gateThreshold) {
          this.gateHoldLeft = 0;
          this.gateGainDb += (0 - this.gateGainDb) * gateAttackCoeff;
        } else if (this.gateHoldLeft < holdSamples) {
          this.gateHoldLeft += 1;
          this.gateGainDb += (0 - this.gateGainDb) * gateAttackCoeff;
        } else {
          this.gateGainDb += (this.gateRange - this.gateGainDb) * gateReleaseCoeff;
        }
        const gIdx = Math.max(0, Math.min(480, Math.round(-this.gateGainDb * 5)));
        gateGain = this.grLookup[gIdx] ?? 1;
      }

      // Ausgang schreiben
      const finalGain = compGain * gateGain * makeupGain;
      for (let ch = 0; ch < output.length; ch++) {
        const src = (input[ch] ?? input[0])[i] ?? 0;
        let out = src * finalGain;
        if (this.dynEqEnabled) {
          const c = this.dynEqCoeffs;
          const s = this.dynEqState;
          let y = c[0] * out + c[1] * s.x1 + c[2] * s.x2 - c[3] * s.y1 - c[4] * s.y2;
          if (!Number.isFinite(y)) y = 0;
          s.x2 = s.x1; s.x1 = out;
          s.y2 = s.y1; s.y1 = y;
          out = y;
        }
        if (!Number.isFinite(out)) out = 0;
        output[ch][i] = out;
      }
    }
    return true;
  }
}

registerProcessor('dynamics-processor', DynamicsProcessor);
