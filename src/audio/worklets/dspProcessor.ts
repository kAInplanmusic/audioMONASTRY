/**
 * dspProcessor – DSP-Engine (AudioWorklet)
 * -----------------------------------------
 * Funktionen:
 *  - Phasenkorrektur im Bassbereich via Allpass 1. Ordnung (PhaseAlignmentTilt).
 *  - Dynamisches Filter: Envelope Follower glättet das Eingangssignal und
 *    moduliert in Echtzeit die Cutoff-Frequenz (Auto-Filter / Dynamic EQ).
 *  - Optionaler Soft-Clipper (Waveshaper) für harmonische Sättigung.
 *
 * Port-Nachrichten:
 *   { phase: <0..1> }                       → Allpass-Stärke
 *   { filterCutoff, resonance, depth }      → dynamisches Filter
 *   { drive: <0..1> }                       → Soft-Clipping
 */
import { computeLowpassCoefficients } from '../dsp/biquad';

class DspProcessor extends AudioWorkletProcessor {
  // Allpass (1. Ordnung)
  private apCoef = 0.2;
  private ap1Z = 0;
  // Envelope Follower Zustand
  private env = 0;
  private envAttack = 0.02;
  private envRelease = 0.08;
  // Dynamisches Filter
  private filterCo = [1,0,0,0,0]; // lowpass biquad (In-Place-Update, keine Allokation im Hot-Path)
  private filterZ = [0,0];
  private lastCutoff = -1;
  private lastQ = -1;
  private baseCutoff = 1000;
  private resonance = 0.5;
  private depth = 0.4;
  private drive = 0;

  constructor() {
    super();
    this.port.onmessage = (e) => {
      const m = e.data; if (!m) return;
      if (m.reset) { this.ap1Z=0; this.filterZ=[0,0]; this.env=0; }
      if (m.type === 'automate') {
        const steps = Math.max(1, Math.round(Number(m.rampTime ?? 0.02) * sampleRate));
        const start = (p: string, cur: number): void => {
          this.rampTargets[p] = Number(m.value);
          this.rampSteps[p] = steps;
          this.rampDeltas[p] = (Number(m.value) - cur) / steps;
        };
        if (m.param === 'drive') start('drive', this.drive);
        if (m.param === 'depth') start('depth', this.depth);
        if (m.param === 'resonance') start('resonance', this.resonance);
        if (m.param === 'phase') start('phase', this.apCoef);
        return;
      }
      if (typeof m.phase === 'number') this.apCoef = (m.phase - 0.5); // -0.5..0.5
      if (typeof m.filterCutoff === 'number') this.baseCutoff = m.filterCutoff;
      if (typeof m.resonance === 'number') this.resonance = Math.max(0.1, Math.min(1, m.resonance));
      if (typeof m.depth === 'number') this.depth = Math.max(0, Math.min(1, m.depth));
      if (typeof m.drive === 'number') this.drive = Math.max(0, Math.min(1, m.drive));
    };
  }

  // Rampen-State (automate)
  private rampTargets: Record<string, number> = {};
  private rampDeltas: Record<string, number> = {};
  private rampSteps: Record<string, number> = {};

  // AM-E1-2: keine Closure-Allokation pro Sample – Inline-Schritte.
  private stepRamps(): void {
    if (this.rampSteps['drive'] !== undefined && this.rampSteps['drive'] > 0) {
      this.rampSteps['drive'] -= 1;
      const t = this.rampTargets['drive'];
      const d = this.rampDeltas['drive'] ?? 0;
      this.drive = Math.max(0, Math.min(1, this.rampSteps['drive'] <= 0 ? t : this.drive + d));
    }
    if (this.rampSteps['depth'] !== undefined && this.rampSteps['depth'] > 0) {
      this.rampSteps['depth'] -= 1;
      const t = this.rampTargets['depth'];
      const d = this.rampDeltas['depth'] ?? 0;
      this.depth = Math.max(0, Math.min(1, this.rampSteps['depth'] <= 0 ? t : this.depth + d));
    }
    if (this.rampSteps['resonance'] !== undefined && this.rampSteps['resonance'] > 0) {
      this.rampSteps['resonance'] -= 1;
      const t = this.rampTargets['resonance'];
      const d = this.rampDeltas['resonance'] ?? 0;
      this.resonance = Math.max(0.1, Math.min(1, this.rampSteps['resonance'] <= 0 ? t : this.resonance + d));
    }
    if (this.rampSteps['phase'] !== undefined && this.rampSteps['phase'] > 0) {
      this.rampSteps['phase'] -= 1;
      const t = this.rampTargets['phase'];
      const d = this.rampDeltas['phase'] ?? 0;
      this.apCoef = this.rampSteps['phase'] <= 0 ? t : this.apCoef + d;
    }
  }

  private setLowpass(freq: number, q: number) {
    // AM-E1-1/E1-5: nur bei Parameter-Änderung neu berechnen; In-Place-Update.
    if (freq === this.lastCutoff && q === this.lastQ) return;
    this.lastCutoff = freq;
    this.lastQ = q;
    // Gemeinsame Biquad-Koeffizientenberechnung (kein Duplikat mehr).
    const co = computeLowpassCoefficients(freq, q, sampleRate);
    this.filterCo[0] = co[0];
    this.filterCo[1] = co[1];
    this.filterCo[2] = co[2];
    this.filterCo[3] = co[3];
    this.filterCo[4] = co[4];
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]) { // NOSONAR: AudioWorkletProcessor muss true liefern
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input[0]) return true;

    for (let i = 0; i < output[0].length; i++) {
      this.stepRamps(); // sample-genaue Parameter-Rampen (automate)
      // Envelope Follower (Average über Kanäle, Mono-Basis)
      let mono = 0;
      for (let ch = 0; ch < input.length; ch++) mono += Math.abs((input[ch]||input[0])[i]);
      mono /= Math.max(1, input.length);
      const dt = 1 / sampleRate;
      if (mono > this.env) this.env += dt/this.envAttack * (mono - this.env);
      else this.env -= dt/this.envRelease * (this.env - mono);
      if (this.env < 0) this.env = 0;

      // Dynamisches Filter: Cutoff wird vom Envelope moduliert
      const modCutoff = this.baseCutoff + this.depth * this.env * 4000;
      this.setLowpass(modCutoff, this.resonance);

      // Anwenden auf jeden Kanal
      for (let ch = 0; ch < output.length; ch++) {
        const inCh = input[ch] || input[0];
        let s = inCh[i] ?? 0;

        // 1) Tilt: Phasenkorrektur (schneller 1.Ordnung Allpass in Serie)
        const y1 = this.apCoef * s + this.ap1Z;
        this.ap1Z = s - this.apCoef * this.ap1Z;
        s = y1;

        // 2) Dynamisches Lowpass (AM-E1-7: Denormal-/NaN-Guard)
        const [b0,b1,b2,a1,a2] = this.filterCo;
        const yf = b0*s + this.filterZ[0];
        const z0 = b1*s - a1*yf + this.filterZ[1];
        const z1 = b2*s - a2*yf;
        this.filterZ[0] = Number.isFinite(z0) ? (Math.abs(z0) < 1e-20 ? 0 : z0) : 0;
        this.filterZ[1] = Number.isFinite(z1) ? (Math.abs(z1) < 1e-20 ? 0 : z1) : 0;
        s = Number.isFinite(yf) ? yf : 0;

        // 3) Optionaler Soft-Clipper (harmonische Sättigung)
        if (this.drive > 0) {
          s = Math.tanh(s * (1 + this.drive * 2)) / Math.tanh(1 + this.drive * 2 * 0.8);
        }

        output[ch][i] = Number.isFinite(s) ? s : 0;
      }
    }
    return true;
  }
}
registerProcessor('dsp-processor', DspProcessor);
