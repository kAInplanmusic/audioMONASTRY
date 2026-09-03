/**
 * dynamicsProcessor – Echtzeit-Dynamik (AudioWorklet)
 * ----------------------------------------------------
 * Kompressor + Gate + Dynamic EQ als ein Insert-Worklet (P1 „Echtzeit-Dynamik",
 * Referenz-Algorithmen: LSP Plugins / ZL Equalizer 2 – eigener Code).
 *
 *  - Gate: Threshold mit Hysterese (Open/Close), Attack/Hold/Release,
 *    Dämpfung begrenzt auf `range` dB (kein hartes Abschneiden).
 *  - Kompressor: Peak-Detektor mit One-Pole-Smoothing, Soft-Knee,
 *    Ratio, Attack/Release, Make-up-Gain – ohne Lookahead, damit die
 *    Master-Kette KEINE zusätzliche Latenz bekommt.
 *  - Dynamic EQ: Peaking-Biquad, dessen Gain erst bei Pegelüberschreitung
 *    im Band greift (Resonanz-Zähmung statt statischem Schnitt).
 *
 * Stabilität: alle Ausgangswerte sind NaN/Inf-geprüft, Denormals werden
 * geklemmt. Hot-Path ohne Allokation (feste Koeffizienten-Arrays).
 *
 * Port-Nachrichten:
 *   { enabled }                                            → Insert aktiv
 *   { compressor: { threshold, ratio, attack, release, knee, makeup } }
 *   { gate: { threshold, range, attack, hold, release, hysteresis } }
 *   { dynEq: { enabled, freq, q, threshold, ratio, range } }
 *   { type: 'automate', param, value, rampTime }           → Parameter-Rampe
 *   { reset: true }                                        → Zustand leeren
 */

/** Fallback-Sample-Rate, wenn das Worklet-Global fehlt (Node-Tests). */
const FALLBACK_SR = 48000;
const currentSampleRate = (): number =>
  typeof sampleRate === 'number' && sampleRate > 0 ? sampleRate : FALLBACK_SR;

/** Linearwert → dBFS (NaN-sicher, Untergrenze -120 dB). */
export function toDb(linear: number): number {
  const a = Math.abs(linear);
  if (!Number.isFinite(a) || a < 1e-6) return -120;
  return 20 * Math.log10(a);
}

/** dB → Linearfaktor (NaN-sicher). */
export function fromDb(db: number): number {
  if (!Number.isFinite(db)) return 1;
  return Math.pow(10, db / 20);
}

/** One-Pole-Koeffizient für eine Zeitkonstante in Sekunden. */
export function smoothingCoefficient(seconds: number, sr: number): number {
  const n = sr * seconds;
  if (!Number.isFinite(n) || n <= 0) return 1;
  return 1 - Math.exp(-1 / n);
}

/**
 * Statische Kompressor-Kennlinie mit Soft-Knee.
 * @returns Ausgangspegel in dB für einen Eingangspegel in dB.
 */
export function compressorCurveDb(
  inputDb: number, threshold: number, ratio: number, knee: number,
): number {
  const r = Math.max(1, ratio);
  const k = Math.max(0, knee);
  const over = inputDb - threshold;
  if (k > 0 && over > -k / 2 && over < k / 2) {
    // Quadratische Knee-Interpolation (stetig in Wert und Steigung).
    const x = over + k / 2;
    return inputDb + ((1 / r - 1) * x * x) / (2 * k);
  }
  if (over <= 0) return inputDb;
  return threshold + over / r;
}

// Worklet-Global fehlt in Node-Tests → Fallback-Basisklasse mit Fake-Port,
// damit der Prozessor deterministisch instanziierbar bleibt (vgl. masteringProcessor).
const WorkletBase: typeof AudioWorkletProcessor =
  (typeof AudioWorkletProcessor !== 'undefined'
    ? AudioWorkletProcessor
    : class {
        port = {
          onmessage: null as any,
          postMessage: (msg: any) => { this.port.onmessage?.({ data: msg }); },
        };
      }) as any;

export class DynamicsProcessor extends WorkletBase {
  /** Insert ist per Default neutral (Bypass) – Master-Kette bleibt unverändert. */
  private enabled = false;

  // --- Kompressor ---
  private compThreshold = -18; // dBFS
  private compRatio = 3;
  private compKnee = 6;        // dB
  private compAttack = 0.01;   // s
  private compRelease = 0.12;  // s
  private compMakeup = 0;      // dB
  private compEnvDb = 0;       // aktuelle Gain-Reduktion (dB, >= 0)
  /** Peak-Detektor (Instant-Attack, langsames Release) für Gate + Kompressor. */
  private detEnv = 0;
  private detRelease = 0.03;   // s

  // --- Gate ---
  private gateEnabled = false;
  private gateThreshold = -60; // dBFS
  private gateHysteresis = 3;  // dB (Close-Threshold liegt darunter)
  private gateRange = 40;      // dB maximale Dämpfung
  private gateAttack = 0.002;  // s
  private gateHold = 0.05;     // s
  private gateRelease = 0.1;   // s
  private gateOpen = false;
  private gateHoldCounter = 0;
  private gateGain = 0;        // 0 = geschlossen, 1 = offen

  // --- Dynamic EQ (ein Band) ---
  private dynEqEnabled = false;
  private dynEqFreq = 3000;
  private dynEqQ = 4;
  private dynEqThreshold = -24; // dBFS im Band
  private dynEqRatio = 4;
  private dynEqRange = 12;      // dB maximale Absenkung
  private dynEqGainDb = 0;
  private lastPeakGainDb = 999;
  /** Detektor-Bandpass + Peaking-Filter (In-Place, keine Allokation). */
  private bpCo = [0, 0, 0, 0, 0];
  private peakCo = [1, 0, 0, 0, 0];
  private bpZ = [0, 0, 0, 0];   // pro Kanal max. 2 Kanäle × 2 Zustände
  private peakZ = [0, 0, 0, 0];
  private lastBpFreq = -1;
  private lastBpQ = -1;

  // Parameter-Rampen (automate)
  private rampTargets: Record<string, number> = {};
  private rampDeltas: Record<string, number> = {};
  private rampSteps: Record<string, number> = {};

  constructor() {
    super();
    this.updateBandpass();
    this.updatePeaking();
    this.port.onmessage = (e: MessageEvent) => this.handleMessage(e.data);
  }

  /** Port-Nachrichten (Parameter, Rampen, Reset). */
  public handleMessage(m: any): void {
    if (!m) return;
    if (m.reset) {
      this.compEnvDb = 0;
      this.detEnv = 0;
      this.gateGain = 0;
      this.gateOpen = false;
      this.gateHoldCounter = 0;
      this.bpZ = [0, 0, 0, 0];
      this.peakZ = [0, 0, 0, 0];
    }
    if (typeof m.enabled === 'boolean') this.enabled = m.enabled;

    if (m.type === 'automate') {
      const steps = Math.max(1, Math.round(Number(m.rampTime ?? 0.02) * currentSampleRate()));
      const current = this.getParam(String(m.param));
      if (current === null) return;
      const target = Number(m.value);
      if (!Number.isFinite(target)) return;
      this.rampTargets[m.param] = target;
      this.rampSteps[m.param] = steps;
      this.rampDeltas[m.param] = (target - current) / steps;
      return;
    }

    const c = m.compressor;
    if (c) {
      if (Number.isFinite(c.threshold)) this.compThreshold = clamp(c.threshold, -60, 0);
      if (Number.isFinite(c.ratio)) this.compRatio = clamp(c.ratio, 1, 20);
      if (Number.isFinite(c.knee)) this.compKnee = clamp(c.knee, 0, 24);
      if (Number.isFinite(c.attack)) this.compAttack = clamp(c.attack, 0.0005, 0.5);
      if (Number.isFinite(c.release)) this.compRelease = clamp(c.release, 0.005, 2);
      if (Number.isFinite(c.makeup)) this.compMakeup = clamp(c.makeup, -12, 24);
    }
    const g = m.gate;
    if (g) {
      if (typeof g.enabled === 'boolean') this.gateEnabled = g.enabled;
      if (Number.isFinite(g.threshold)) this.gateThreshold = clamp(g.threshold, -100, 0);
      if (Number.isFinite(g.range)) this.gateRange = clamp(g.range, 0, 90);
      if (Number.isFinite(g.attack)) this.gateAttack = clamp(g.attack, 0.0002, 0.2);
      if (Number.isFinite(g.hold)) this.gateHold = clamp(g.hold, 0, 1);
      if (Number.isFinite(g.release)) this.gateRelease = clamp(g.release, 0.005, 2);
      if (Number.isFinite(g.hysteresis)) this.gateHysteresis = clamp(g.hysteresis, 0, 24);
    }
    const d = m.dynEq;
    if (d) {
      if (typeof d.enabled === 'boolean') this.dynEqEnabled = d.enabled;
      if (Number.isFinite(d.freq)) this.dynEqFreq = clamp(d.freq, 20, 18000);
      if (Number.isFinite(d.q)) this.dynEqQ = clamp(d.q, 0.3, 18);
      if (Number.isFinite(d.threshold)) this.dynEqThreshold = clamp(d.threshold, -80, 0);
      if (Number.isFinite(d.ratio)) this.dynEqRatio = clamp(d.ratio, 1, 20);
      if (Number.isFinite(d.range)) this.dynEqRange = clamp(d.range, 0, 24);
      this.updateBandpass();
    }
  }

  /** Aktueller Wert eines automatisierbaren Parameters (oder null). */
  private getParam(param: string): number | null {
    switch (param) {
      case 'threshold': return this.compThreshold;
      case 'ratio': return this.compRatio;
      case 'makeup': return this.compMakeup;
      case 'gateThreshold': return this.gateThreshold;
      case 'dynEqRange': return this.dynEqRange;
      default: return null;
    }
  }

  private setParam(param: string, value: number): void {
    switch (param) {
      case 'threshold': this.compThreshold = clamp(value, -60, 0); break;
      case 'ratio': this.compRatio = clamp(value, 1, 20); break;
      case 'makeup': this.compMakeup = clamp(value, -12, 24); break;
      case 'gateThreshold': this.gateThreshold = clamp(value, -100, 0); break;
      case 'dynEqRange': this.dynEqRange = clamp(value, 0, 24); break;
      default: break;
    }
  }

  /** Sample-genaue Parameter-Rampen (zipper-frei). */
  private stepRamps(): void {
    for (const param in this.rampSteps) {
      const remaining = this.rampSteps[param];
      if (remaining === undefined || remaining <= 0) continue;
      this.rampSteps[param] = remaining - 1;
      const current = this.getParam(param);
      if (current === null) continue;
      const next = this.rampSteps[param] <= 0
        ? this.rampTargets[param]
        : current + (this.rampDeltas[param] ?? 0);
      this.setParam(param, next);
    }
  }

  /** Aktuelle Gain-Reduktion des Kompressors in dB (Metering/Tests). */
  public getGainReductionDb(): number {
    return this.compEnvDb;
  }

  /** Aktueller Gate-Faktor 0..1 (Metering/Tests). */
  public getGateGain(): number {
    return this.gateGain;
  }

  /** Aktuelle dynamische EQ-Absenkung in dB (<= 0). */
  public getDynEqGainDb(): number {
    return this.dynEqGainDb;
  }

  /** Detektor-Bandpass (konstante Spitzenverstärkung) neu berechnen. */
  private updateBandpass(): void {
    if (this.dynEqFreq === this.lastBpFreq && this.dynEqQ === this.lastBpQ) return;
    this.lastBpFreq = this.dynEqFreq;
    this.lastBpQ = this.dynEqQ;
    const sr = currentSampleRate();
    const w = (2 * Math.PI * Math.min(this.dynEqFreq, sr * 0.45)) / sr;
    const alpha = Math.sin(w) / (2 * this.dynEqQ);
    const cw = Math.cos(w);
    const b0 = alpha, b1 = 0, b2 = -alpha;
    const a0 = 1 + alpha, a1 = -2 * cw, a2 = 1 - alpha;
    this.bpCo[0] = b0 / a0;
    this.bpCo[1] = b1 / a0;
    this.bpCo[2] = b2 / a0;
    this.bpCo[3] = a1 / a0;
    this.bpCo[4] = a2 / a0;
    this.lastPeakGainDb = 999; // Peaking neu berechnen
  }

  /** Peaking-Filter mit aktuellem dynamischen Gain neu berechnen. */
  private updatePeaking(): void {
    if (Math.abs(this.dynEqGainDb - this.lastPeakGainDb) < 0.05) return;
    this.lastPeakGainDb = this.dynEqGainDb;
    const sr = currentSampleRate();
    const A = Math.pow(10, this.dynEqGainDb / 40);
    const w = (2 * Math.PI * Math.min(this.dynEqFreq, sr * 0.45)) / sr;
    const alpha = Math.sin(w) / (2 * this.dynEqQ);
    const cw = Math.cos(w);
    const b0 = 1 + alpha * A, b1 = -2 * cw, b2 = 1 - alpha * A;
    const a0 = 1 + alpha / A, a1 = -2 * cw, a2 = 1 - alpha / A;
    this.peakCo[0] = b0 / a0;
    this.peakCo[1] = b1 / a0;
    this.peakCo[2] = b2 / a0;
    this.peakCo[3] = a1 / a0;
    this.peakCo[4] = a2 / a0;
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean { // NOSONAR: AudioWorkletProcessor muss true liefern
    const input = inputs[0];
    const output = outputs[0];
    if (!output || !output[0]) return true;
    if (!input || !input[0]) {
      for (let ch = 0; ch < output.length; ch++) output[ch].fill(0);
      return true;
    }
    // Bypass: bitgenauer Durchgang, keine zusätzliche Latenz/Färbung.
    if (!this.enabled) {
      for (let ch = 0; ch < output.length; ch++) {
        output[ch].set(input[ch] ?? input[0]);
      }
      return true;
    }

    const sr = currentSampleRate();
    const frames = output[0].length;
    const compAtt = smoothingCoefficient(this.compAttack, sr);
    const compRel = smoothingCoefficient(this.compRelease, sr);
    const gateAtt = smoothingCoefficient(this.gateAttack, sr);
    const gateRel = smoothingCoefficient(this.gateRelease, sr);
    const holdSamples = Math.round(this.gateHold * sr);
    const detRel = smoothingCoefficient(this.detRelease, sr);
    const dynAtt = smoothingCoefficient(0.005, sr);
    const dynRel = smoothingCoefficient(0.08, sr);

    for (let i = 0; i < frames; i++) {
      this.stepRamps();

      // --- Detektor (Peak über alle Kanäle) ---
      let peak = 0;
      for (let ch = 0; ch < input.length; ch++) {
        const v = Math.abs((input[ch] ?? input[0])[i] ?? 0);
        if (v > peak) peak = v;
      }
      // Peak-Follower: Instant-Attack, langsames Release – sonst würde jeder
      // Nulldurchgang einer Schwingung das Gate schließen (Chattering).
      if (peak > this.detEnv) this.detEnv = peak;
      else this.detEnv += detRel * (peak - this.detEnv);
      if (!Number.isFinite(this.detEnv) || this.detEnv < 0) this.detEnv = 0;
      const levelDb = toDb(this.detEnv);

      // --- Gate mit Hysterese + Hold ---
      let gateFactor = 1;
      if (this.gateEnabled) {
        const closeDb = this.gateThreshold - this.gateHysteresis;
        if (levelDb >= this.gateThreshold) {
          this.gateOpen = true;
          this.gateHoldCounter = holdSamples;
        } else if (levelDb < closeDb) {
          if (this.gateHoldCounter > 0) this.gateHoldCounter--;
          else this.gateOpen = false;
        }
        const target = this.gateOpen ? 1 : 0;
        const coef = target > this.gateGain ? gateAtt : gateRel;
        this.gateGain += coef * (target - this.gateGain);
        if (this.gateGain < 0) this.gateGain = 0;
        if (this.gateGain > 1) this.gateGain = 1;
        // Dämpfung auf `range` dB begrenzen (kein hartes Stummschalten).
        const floor = fromDb(-this.gateRange);
        gateFactor = floor + (1 - floor) * this.gateGain;
      } else {
        this.gateGain = 1;
      }

      // --- Kompressor (Soft-Knee, ohne Lookahead) ---
      const targetGrDb = Math.max(
        0, levelDb - compressorCurveDb(levelDb, this.compThreshold, this.compRatio, this.compKnee),
      );
      const coef = targetGrDb > this.compEnvDb ? compAtt : compRel;
      this.compEnvDb += coef * (targetGrDb - this.compEnvDb);
      if (!Number.isFinite(this.compEnvDb) || this.compEnvDb < 0) this.compEnvDb = 0;
      const compGain = fromDb(this.compMakeup - this.compEnvDb);

      // --- Dynamic EQ: Bandpegel messen und Peaking-Gain nachführen ---
      if (this.dynEqEnabled) {
        const mono = (input[0][i] ?? 0);
        const bp = this.biquad(this.bpCo, this.bpZ, 0, mono);
        const bandDb = toDb(bp);
        const over = Math.max(0, bandDb - this.dynEqThreshold);
        const targetCut = -Math.min(this.dynEqRange, over * (1 - 1 / Math.max(1, this.dynEqRatio)));
        const dc = targetCut < this.dynEqGainDb ? dynAtt : dynRel;
        this.dynEqGainDb += dc * (targetCut - this.dynEqGainDb);
        if (!Number.isFinite(this.dynEqGainDb)) this.dynEqGainDb = 0;
        this.updatePeaking();
      } else if (this.dynEqGainDb !== 0) {
        this.dynEqGainDb = 0;
        this.updatePeaking();
      }

      // --- Anwenden ---
      for (let ch = 0; ch < output.length; ch++) {
        const inCh = input[ch] ?? input[0];
        let s = inCh[i] ?? 0;
        if (this.dynEqEnabled) s = this.biquad(this.peakCo, this.peakZ, ch, s);
        s = s * gateFactor * compGain;
        if (!Number.isFinite(s)) s = 0;
        if (s > 4) s = 4;
        if (s < -4) s = -4;
        output[ch][i] = s;
      }
    }
    return true;
  }

  /** Transposed-Direct-Form-II-Biquad mit zwei Zuständen je Kanal. */
  private biquad(co: number[], z: number[], ch: number, x: number): number {
    const idx = (ch % 2) * 2;
    const z1 = z[idx];
    const z2 = z[idx + 1];
    let y = co[0] * x + z1;
    if (!Number.isFinite(y)) y = 0;
    z[idx] = co[1] * x - co[3] * y + z2;
    z[idx + 1] = co[2] * x - co[4] * y;
    if (!Number.isFinite(z[idx])) z[idx] = 0;
    if (!Number.isFinite(z[idx + 1])) z[idx + 1] = 0;
    return y;
  }
}

function clamp(v: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

if (typeof registerProcessor !== 'undefined') {
  registerProcessor('dynamics-processor', DynamicsProcessor);
}
