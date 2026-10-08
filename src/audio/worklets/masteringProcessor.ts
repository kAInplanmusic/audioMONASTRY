/**
 * masteringProcessor – Mastering-Kette (AudioWorklet, Legacy)
 * -----------------------------------------------------------
 * RT-AUDIT-P0-004: rechnet mit DEMSELBEN Kern wie der V2-`MasteringNode`
 * (`src/core/dsp/masteringDynamics.ts`) – vorher eine eigene Logik mit
 * Momentanpegel-Kompression (Waveshaper-Verhalten) und einem Limiter-Detektor,
 * der das VERZÖGERTE statt des kommenden Signals las:
 *  - Kompressor mit Attack/Release-Detektor im dB-Bereich (Soft-Knee).
 *  - Lookahead-Limiter (5 ms) mit True-Peak-Detektor (4×-FIR, BS.1770-4),
 *    gleitendem Minimum, Attack-Rampe und exponentiellem Release.
 *  - Harte Sicherung ±ceiling hinter dem Limiter, NaN/Inf-sicher.
 *  - Hot-Path ohne Allokation; der Limiter-Release-Koeffizient kommt aus einer
 *    segmentierten Lookup-Tabelle (AM-E4-4), nur bei Änderung berechnet.
 *
 * Der Prozessor wird vom audioEngine erzeugt, hängt aber NICHT im hörbaren
 * Pfad (der läuft über den v2SinkProcessor). Er bleibt, weil audioEngine,
 * workletParamBridge, C0-Bindung und Plugin-Manifest ihn adressieren.
 *
 * Steuerung über Port-Nachrichten:
 *   { threshold, ratio, knee, makeup, ceiling, release, compAttack, compRelease, reset }
 *   { type: 'automate', param: 'threshold'|'makeup'|'ceiling', value, rampTime }
 */
import { MASTERING_DEFAULTS, MasteringDynamics } from '../../core/dsp/masteringDynamics';

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
  private threshold: number = MASTERING_DEFAULTS.threshold; // dBFS (Kompressor-Grenze)
  private ratio: number = MASTERING_DEFAULTS.ratio;
  private knee: number = MASTERING_DEFAULTS.knee;
  private makeup: number = MASTERING_DEFAULTS.makeup;

  private limiterCeiling: number = MASTERING_DEFAULTS.ceiling;
  private limiterRelease: number = MASTERING_DEFAULTS.release; // Sekunden (Limiter-Release)
  private compAttack: number = MASTERING_DEFAULTS.compAttack; // Sekunden (10 ms)
  private compRelease: number = MASTERING_DEFAULTS.compRelease; // Sekunden (100 ms)

  /** Gemeinsamer Rechenkern (identisch zum V2-MasteringNode). */
  private readonly core = new MasteringDynamics(currentSampleRate(), 2);

  /** Lookahead-Tiefe in Samples (für Tests/PDC-Abgleich mit `audioEngine`). */
  getLookaheadSamples(): number { return this.core.lookaheadSamples; }

  constructor() {
    super();
    this.port.onmessage = (e) => {
      const m = e.data; if (!m) return;
      if (m.reset) this.core.reset();
      if (typeof m.threshold === 'number') this.threshold = m.threshold;
      if (typeof m.ratio === 'number') this.ratio = Math.min(20, Math.max(1, m.ratio));
      if (typeof m.knee === 'number') this.knee = Math.max(0, m.knee);
      if (typeof m.makeup === 'number') this.makeup = Math.max(0, Math.min(4, m.makeup));
      // Fix: Nachricht heißt `ceiling` – vorher wurde fälschlich `limiterCeiling` gelesen.
      if (typeof m.ceiling === 'number') this.limiterCeiling = Math.max(0.1, Math.min(1, m.ceiling));
      if (typeof m.release === 'number') this.limiterRelease = Math.max(0.005, Math.min(1, m.release));
      if (typeof m.compAttack === 'number') this.compAttack = Math.max(0.0005, Math.min(0.5, m.compAttack));
      if (typeof m.compRelease === 'number') this.compRelease = Math.max(0.005, Math.min(2, m.compRelease));
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

  private rampsActive(): boolean {
    return (this.rampSteps['threshold'] ?? 0) > 0
      || (this.rampSteps['makeup'] ?? 0) > 0
      || (this.rampSteps['ceiling'] ?? 0) > 0;
  }

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

  /** Überträgt die Parameter in den Kern (Koeffizienten nur bei Änderung). */
  private syncCore(): void {
    const core = this.core;
    core.threshold = this.threshold;
    core.ratio = this.ratio;
    core.knee = this.knee;
    core.makeup = this.makeup;
    core.ceiling = this.limiterCeiling;
    core.setTimes(this.compAttack, this.compRelease, this.limiterRelease);
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]) { // NOSONAR: AudioWorkletProcessor muss true liefern
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input[0] || !output || !output[0]) return true;

    const len = output[0].length;
    const core = this.core;
    // Speicher nur beim ersten Block bzw. bei mehr Kanälen (kein Hot-Path-Fall).
    core.configure(currentSampleRate(), output.length);
    // Eingang in den Ausgang kopieren (fehlende Kanäle = Kanal 0, NaN → 0);
    // der Kern rechnet in place.
    for (let ch = 0; ch < output.length; ch++) {
      const src = input[ch] || input[0];
      const dst = output[ch];
      for (let i = 0; i < len; i++) dst[i] = src[i] || 0;
    }
    // Limiter-Release aus der Lookup-Tabelle (AM-E4-4), nur bei Änderung.
    if (this.limiterRelease !== this.lastLimiterRelease) {
      this.lastLimiterRelease = this.limiterRelease;
      core.setLimiterReleaseCoefficient(releaseCoefficient(this.limiterRelease, currentSampleRate()), this.limiterRelease);
    }
    this.syncCore();
    if (!this.rampsActive()) {
      core.process(output, 0, len);
      return true;
    }
    // Sample-genaue Parameter-Rampen (automate): Kern Sample für Sample.
    for (let i = 0; i < len; i++) {
      this.stepRamps();
      this.syncCore();
      core.process(output, i, i + 1);
    }
    return true;
  }

  private lastLimiterRelease = Number.NaN;
}
if (typeof registerProcessor !== 'undefined') {
  registerProcessor('mastering-processor', MasteringProcessor as any);
}
