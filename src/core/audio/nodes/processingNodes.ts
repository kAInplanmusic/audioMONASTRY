/**
 * audioMONASTRY · V2 Processing Nodes (Phase 5 – DSP/Effekt/Mastering)
 * ====================================================================
 * Backend-unabhängige IAudioNode-Implementierungen für den V2-AudioGraph:
 *
 *   ParametricEqNode    – 3-Band EQ (Low-Shelf / Peaking / High-Shelf)
 *   DspFilterNode       – dynamisches Lowpass + Soft-Clipper (DSP-Engine)
 *   EffectNode          – Reverb/Delay/Chorus/Bitcrusher (Effekt-Engine)
 *   DynamicsNode        – Soft-Knee-Kompressor (Dynamics-Insert)
 *   MasteringNode       – Soft-Knee-Kompression + Limiter/Makeup
 *
 * Alle Nodes sind deterministisch, ohne WebAudio-/Worklet-API und besitzen
 * `AudioParameter`-Objekte, die über `getParameter(paramId)` automatisierbar
 * sind (siehe `src/core/audio/state/v2NodeAutomation.ts`).
 */
import { AudioParameter } from '../AudioGraph';
import { audioBufferPool } from '../BufferPool';
import { BaseNode } from './basicNodes';
import type { IProcessingContext } from '../types';
import type { AutomatableV2Node } from '../state/v2NodeAutomation';

type BiquadType = 'peaking' | 'lowshelf' | 'highshelf' | 'highpass' | 'lowpass';
type BiquadCoefficients = [number, number, number, number, number];

// ---------------------------------------------------------------------------
// Pure DSP-Helfer (lokal, keine Abhängigkeit zu AudioWorklet-Dateien)
// ---------------------------------------------------------------------------

export function toDb(linear: number): number {
  const a = Math.abs(linear);
  if (!Number.isFinite(a) || a < 1e-6) return -120;
  return 20 * Math.log10(a);
}

export function fromDb(db: number): number {
  if (!Number.isFinite(db)) return 1;
  return Math.pow(10, db / 20);
}

export function smoothingCoefficient(seconds: number, sampleRate: number): number {
  const n = sampleRate * seconds;
  if (!Number.isFinite(n) || n <= 0) return 1;
  return 1 - Math.exp(-1 / n);
}

export function compressorCurveDb(
  inputDb: number,
  threshold: number,
  ratio: number,
  knee: number,
): number {
  const r = Math.max(1, ratio);
  const k = Math.max(0, knee);
  const over = inputDb - threshold;
  if (k > 0 && over > -k / 2 && over < k / 2) {
    const x = over + k / 2;
    return inputDb + ((1 / r - 1) * x * x) / (2 * k);
  }
  if (over <= 0) return inputDb;
  return threshold + over / r;
}

function computeBiquadCoefficients(
  type: BiquadType,
  freq: number,
  gainDb: number,
  q: number,
  sampleRate: number,
): BiquadCoefficients {
  const sr = Math.max(8000, Number.isFinite(sampleRate) ? sampleRate : 48000);
  const f = Math.max(5, Math.min(sr / 2 - 1, Number.isFinite(freq) ? freq : 1000));
  const qq = Math.max(0.1, Math.min(18, Number.isFinite(q) ? q : 0.707));
  const g = Math.max(-24, Math.min(24, gainDb));
  // ARCH-AUDIO-002: Bei 0 dB Gain muss ein Shelf-/Peaking-Filter exakt
  // transparent sein (RBJ-Formeln degenerieren bei A=1 sonst zu b1≠a1).
  if (type !== 'highpass' && type !== 'lowpass' && Math.abs(g) < 1e-9) {
    return [1, 0, 0, 0, 0];
  }
  const w = (2 * Math.PI * f) / sr;
  const cw = Math.cos(w);
  const sn = Math.sin(w);
  let co: number[];
  if (type === 'highpass' || type === 'lowpass') {
    const alpha = sn / (2 * qq);
    const a0 = 1 + alpha;
    const b0 = (1 + (type === 'highpass' ? cw : -cw)) / 2;
    const b1 = (type === 'highpass' ? -1 : 1) * (1 + (type === 'highpass' ? cw : -cw));
    const b2 = b0;
    co = [b0 / a0, b1 / a0, b2 / a0, (-2 * cw) / a0, (1 - alpha) / a0];
  } else {
    const A = Math.pow(10, g / 40);
    const sign = type === 'lowshelf' ? -1 : 1;
    if (type === 'peaking') {
      const alpha = sn / (2 * qq);
      const b0 = 1 + alpha * A;
      const b1 = -2 * cw;
      const b2 = 1 - alpha * A;
      const a0 = 1 + alpha / A;
      const a1 = -2 * cw;
      const a2 = 1 - alpha / A;
      co = [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
    } else {
      // Low-/High-Shelf (RBJ)
      const alpha = (sn / 2) * Math.sqrt((A + 1 / A) * (1 / qq - 1) + 2);
      const twoSqrtAAlpha = 2 * Math.sqrt(A) * alpha;
      const b0 = A * ((A + 1) + sign * (A - 1) * cw + twoSqrtAAlpha);
      const b1 = sign < 0
        ? 2 * A * ((A - 1) - (A + 1) * cw)
        : -2 * A * ((A - 1) + (A + 1) * cw);
      const b2 = A * ((A + 1) + sign * (A - 1) * cw - twoSqrtAAlpha);
      const a0 = (A + 1) - sign * (A - 1) * cw + twoSqrtAAlpha;
      const a1 = sign < 0
        ? -2 * ((A + 1) + (A - 1) * cw)
        : 2 * ((A - 1) - (A + 1) * cw);
      const a2 = (A + 1) - sign * (A - 1) * cw - twoSqrtAAlpha;
      co = [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
    }
  }
  const out = co.slice(0, 5) as BiquadCoefficients;
  for (let i = 0; i < 5; i++) if (!Number.isFinite(out[i])) out[i] = 0;
  return out;
}

class BiquadState {
  private co: BiquadCoefficients = [1, 0, 0, 0, 0];
  private z1 = 0;
  private z2 = 0;

  setCoefficients(co: BiquadCoefficients): void {
    this.co = co;
  }

  reset(): void {
    this.z1 = 0;
    this.z2 = 0;
  }

  process(x: number): number {
    const [b0, b1, b2, a1, a2] = this.co;
    let y = b0 * x + this.z1;
    if (!Number.isFinite(y)) y = 0;
    let z1 = b1 * x - a1 * y + this.z2;
    let z2 = b2 * x - a2 * y;
    if (!Number.isFinite(z1)) z1 = 0;
    if (!Number.isFinite(z2)) z2 = 0;
    this.z1 = z1;
    this.z2 = z2;
    return y;
  }
}

function copyInput(input: Float32Array[], len: number): Float32Array[] {
  const out = audioBufferPool.acquire(Math.max(1, input.length), len);
  for (let ch = 0; ch < input.length; ch++) out[ch].set(input[ch]);
  return out;
}

// ---------------------------------------------------------------------------
// ParametricEqNode
// ---------------------------------------------------------------------------

export interface EqBandSpec {
  id: string;
  type: BiquadType;
  freq: number;
  q: number;
}

const DEFAULT_EQ_BANDS: EqBandSpec[] = [
  { id: 'low', type: 'lowshelf', freq: 220, q: 0.707 },
  { id: 'mid', type: 'peaking', freq: 1000, q: 1 },
  { id: 'high', type: 'highshelf', freq: 4000, q: 0.707 },
];

export class ParametricEqNode extends BaseNode implements AutomatableV2Node {
  readonly bandGains = new Map<string, AudioParameter>();
  private readonly states: BiquadState[][];
  private readonly bands: EqBandSpec[];

  constructor(id: string, bands: EqBandSpec[] = DEFAULT_EQ_BANDS) {
    super(id, 'eq', 1, 1);
    this.bands = bands;
    this.states = bands.map(() => []);
    for (const band of bands) {
      const param = new AudioParameter(band.id, -24, 24, 0);
      this.bandGains.set(band.id, param);
      this.parameters.push(param);
    }
  }

  setBandGain(bandId: string, gainDb: number): void {
    const p = this.bandGains.get(bandId);
    if (p) p.setValue(gainDb);
  }

  getParameter(paramId: string): AudioParameter | undefined {
    return this.bandGains.get(paramId);
  }

  process(ctx: IProcessingContext): void {
    const input = this.inputBuffer(ctx);
    if (!input) {
      this.outputs[0].buffer = null;
      return;
    }
    const len = input[0]?.length ?? ctx.bufferSize;
    const out = copyInput(input, len);
    const coeffs = this.bands.map((band) =>
      computeBiquadCoefficients(
        band.type,
        band.freq,
        this.bandGains.get(band.id)?.getValueAtTime(ctx.currentTime) ?? 0,
        band.q,
        ctx.sampleRate,
      ));
    for (let ch = 0; ch < input.length; ch++) {
      if (!this.states[0][ch]) {
        for (let band = 0; band < this.bands.length; band++) {
          this.states[band][ch] = new BiquadState();
        }
      }
    }
    for (let ch = 0; ch < out.length; ch++) {
      for (let i = 0; i < len; i++) {
        let s = out[ch][i] ?? 0;
        for (let band = 0; band < this.bands.length; band++) {
          const state = this.states[band][ch];
          state.setCoefficients(coeffs[band]);
          s = state.process(s);
        }
        out[ch][i] = Number.isFinite(s) ? s : 0;
      }
    }
    this.outputs[0].buffer = out;
  }

  reset(): void {
    for (const band of this.states) {
      for (const state of band) state?.reset();
    }
    this.outputs[0].buffer = null;
  }
}

// ---------------------------------------------------------------------------
// DspFilterNode
// ---------------------------------------------------------------------------

export class DspFilterNode extends BaseNode implements AutomatableV2Node {
  readonly cutoff: AudioParameter;
  readonly resonance: AudioParameter;
  readonly depth: AudioParameter;
  readonly drive: AudioParameter;
  private readonly lowpassStates: BiquadState[] = [];
  private env = 0;

  constructor(id: string) {
    super(id, 'dsp', 1, 1);
    this.cutoff = new AudioParameter('cutoff', 20, 20000, 1000);
    this.resonance = new AudioParameter('resonance', 0.1, 1, 0.5);
    this.depth = new AudioParameter('depth', 0, 1, 0.4);
    this.drive = new AudioParameter('drive', 0, 1, 0);
    this.parameters.push(this.cutoff, this.resonance, this.depth, this.drive);
  }

  getParameter(paramId: string): AudioParameter | undefined {
    return this.parameters.find((p) => p.id === paramId);
  }

  process(ctx: IProcessingContext): void {
    const input = this.inputBuffer(ctx);
    if (!input) {
      this.outputs[0].buffer = null;
      return;
    }
    const len = input[0]?.length ?? ctx.bufferSize;
    const out = copyInput(input, len);
    const sr = ctx.sampleRate;
    const att = smoothingCoefficient(0.02, sr);
    const rel = smoothingCoefficient(0.08, sr);
    const drive = this.drive.getValueAtTime(ctx.currentTime);
    const baseCutoff = this.cutoff.getValueAtTime(ctx.currentTime);
    const q = this.resonance.getValueAtTime(ctx.currentTime);
    const depth = this.depth.getValueAtTime(ctx.currentTime);
    // AUDIO-P0-004: Tiefe 0 + Drive 0 = bit-transparenter Bypass (kein Filter-Tail).
    if (drive <= 0 && depth <= 0) {
      this.outputs[0].buffer = out;
      return;
    }
    const driveNorm = Math.tanh(1 + drive * 1.6);

    for (let ch = 0; ch < out.length; ch++) {
      if (!this.lowpassStates[ch]) this.lowpassStates[ch] = new BiquadState();
    }

    let lastCutoff = -1;
    for (let i = 0; i < len; i++) {
      let mono = 0;
      for (let ch = 0; ch < input.length; ch++) mono += Math.abs(input[ch]?.[i] ?? 0);
      mono /= Math.max(1, input.length);
      const coef = mono > this.env ? att : rel;
      this.env += coef * (mono - this.env);
      if (this.env < 0) this.env = 0;
      const modCutoff = Math.min(sr / 2 - 1, Math.max(20, baseCutoff + depth * this.env * 4000));
      if (Math.abs(modCutoff - lastCutoff) > 0.1) {
        lastCutoff = modCutoff;
        for (const state of this.lowpassStates) state.setCoefficients(computeBiquadCoefficients('lowpass', modCutoff, 0, q, sr));
      }
      for (let ch = 0; ch < out.length; ch++) {
        let s = out[ch]?.[i] ?? 0;
        s = this.lowpassStates[ch]?.process(s) ?? s;
        if (drive > 0) s = Math.tanh(s * (1 + drive * 2)) / driveNorm;
        out[ch][i] = Number.isFinite(s) ? s : 0;
      }
    }
    this.outputs[0].buffer = out;
  }

  reset(): void {
    for (const state of this.lowpassStates) state?.reset();
    this.env = 0;
    this.outputs[0].buffer = null;
  }
}

// ---------------------------------------------------------------------------
// EffectNode (Delay/Reverb/Chorus/Bitcrusher)
// ---------------------------------------------------------------------------

const COMB1 = 1200;
const COMB2 = 1513;
const ALL1 = 583;
const ALL2 = 311;
const CHORUS_LEN = 4000;

export class EffectNode extends BaseNode implements AutomatableV2Node {
  readonly wet: AudioParameter;
  readonly feedback: AudioParameter;
  readonly rate: AudioParameter;
  readonly depth: AudioParameter;
  readonly bits: AudioParameter;
  readonly sampleReduction: AudioParameter;

  private comb1 = new Float32Array(COMB1);
  private comb2 = new Float32Array(COMB2);
  private all1 = new Float32Array(ALL1);
  private all2 = new Float32Array(ALL2);
  private comb1Pos = 0;
  private comb2Pos = 0;
  private all1Pos = 0;
  private all2Pos = 0;
  private chorus = new Float32Array(CHORUS_LEN);
  private chorusPos = 0;
  private chorusPhase = 0;
  private crushCounter = 0;
  private crushHold = 0;

  constructor(id: string) {
    super(id, 'effect', 1, 1);
    this.wet = new AudioParameter('wet', 0, 1, 0.3);
    this.feedback = new AudioParameter('feedback', 0, 0.9, 0.6);
    this.rate = new AudioParameter('rate', 0.05, 10, 0.5);
    this.depth = new AudioParameter('depth', 0, 1, 0.5);
    this.bits = new AudioParameter('bits', 2, 16, 8);
    this.sampleReduction = new AudioParameter('sampleReduction', 1, 64, 1);
    this.parameters.push(this.wet, this.feedback, this.rate, this.depth, this.bits, this.sampleReduction);
  }

  getParameter(paramId: string): AudioParameter | undefined {
    return this.parameters.find((p) => p.id === paramId);
  }

  process(ctx: IProcessingContext): void {
    const input = this.inputBuffer(ctx);
    if (!input) {
      this.outputs[0].buffer = null;
      return;
    }
    const len = input[0]?.length ?? ctx.bufferSize;
    const out = copyInput(input, len);
    const sr = ctx.sampleRate;
    const wetAmt = this.wet.getValueAtTime(ctx.currentTime);
    // AUDIO-P0-004: Wet 0 = bit-transparenter Bypass (kein Reverb-/Chorus-Tail).
    if (wetAmt <= 0) {
      this.outputs[0].buffer = out;
      return;
    }
    const fb = this.feedback.getValueAtTime(ctx.currentTime);
    const chorusRate = this.rate.getValueAtTime(ctx.currentTime);
    const chorusDepth = this.depth.getValueAtTime(ctx.currentTime);
    const crushLevels = Math.pow(2, Math.round(this.bits.getValueAtTime(ctx.currentTime)));
    const crushReduction = Math.max(1, Math.round(this.sampleReduction.getValueAtTime(ctx.currentTime)));

    for (let i = 0; i < len; i++) {
      const t = (i / sr) + ctx.currentTime;
      for (let ch = 0; ch < out.length; ch++) {
        const x = out[ch]?.[i] ?? 0;
        const rvb = this.reverb(x, fb);
        const chrs = this.chorusProcess(x, chorusRate, chorusDepth, t, sr);
        const crs = this.crush(x, crushLevels, crushReduction);
        const eff = rvb * 0.6 + chrs * 0.2 + crs * 0.2;
        out[ch][i] = Number.isFinite(x * (1 - wetAmt) + eff * wetAmt) ? x * (1 - wetAmt) + eff * wetAmt : 0;
      }
    }
    this.outputs[0].buffer = out;
  }

  private reverb(x: number, feedback: number): number {
    x = Math.abs(x) < 1e-20 ? 0 : x;
    const c1out = this.comb1[this.comb1Pos];
    this.comb1[this.comb1Pos] = x + c1out * feedback;
    this.comb1Pos = (this.comb1Pos + 1) % COMB1;
    const c2out = this.comb2[this.comb2Pos];
    this.comb2[this.comb2Pos] = x + c2out * feedback;
    this.comb2Pos = (this.comb2Pos + 1) % COMB2;
    const diff = c1out + c2out;
    const a1read = this.all1[this.all1Pos];
    this.all1[this.all1Pos] = diff + a1read * 0.5;
    this.all1Pos = (this.all1Pos + 1) % ALL1;
    const a2read = this.all2[this.all2Pos];
    this.all2[this.all2Pos] = diff + a2read * 0.5;
    this.all2Pos = (this.all2Pos + 1) % ALL2;
    return (a1read + a2read) * 0.5;
  }

  private chorusProcess(x: number, rate: number, depth: number, time: number, sr: number): number {
    this.chorusPhase = (this.chorusPhase + 2 * Math.PI * rate / sr) % (2 * Math.PI);
    const lfo = Math.sin(this.chorusPhase + time * rate * 0.1);
    this.chorus[this.chorusPos] = x;
    const delaySamples = 1 + depth * 1500 * (0.5 + 0.5 * lfo);
    const readPos = (this.chorusPos - Math.round(delaySamples) + CHORUS_LEN) % CHORUS_LEN;
    const delayed = this.chorus[readPos];
    this.chorusPos = (this.chorusPos + 1) % CHORUS_LEN;
    return delayed;
  }

  private crush(x: number, levels: number, reduction: number): number {
    if (--this.crushCounter <= 0) {
      this.crushCounter = reduction;
      this.crushHold = x;
    }
    return Math.round(this.crushHold * levels) / levels;
  }

  reset(): void {
    this.comb1.fill(0);
    this.comb2.fill(0);
    this.all1.fill(0);
    this.all2.fill(0);
    this.chorus.fill(0);
    this.comb1Pos = this.comb2Pos = this.all1Pos = this.all2Pos = 0;
    this.chorusPos = 0;
    this.chorusPhase = 0;
    this.crushCounter = 0;
    this.crushHold = 0;
    this.outputs[0].buffer = null;
  }
}

// ---------------------------------------------------------------------------
// DynamicsNode
// ---------------------------------------------------------------------------

export class DynamicsNode extends BaseNode implements AutomatableV2Node {
  readonly enabled: AudioParameter;
  readonly threshold: AudioParameter;
  readonly ratio: AudioParameter;
  readonly knee: AudioParameter;
  readonly makeup: AudioParameter;
  readonly attack: AudioParameter;
  readonly release: AudioParameter;
  private compEnvDb = 0;

  constructor(id: string) {
    super(id, 'dynamics', 1, 1);
    this.enabled = new AudioParameter('enabled', 0, 1, 1);
    this.threshold = new AudioParameter('threshold', -60, 0, -18);
    this.ratio = new AudioParameter('ratio', 1, 20, 3);
    this.knee = new AudioParameter('knee', 0, 24, 6);
    this.makeup = new AudioParameter('makeup', -12, 24, 0);
    this.attack = new AudioParameter('attack', 0.0005, 0.5, 0.01);
    this.release = new AudioParameter('release', 0.005, 2, 0.12);
    this.parameters.push(this.enabled, this.threshold, this.ratio, this.knee, this.makeup, this.attack, this.release);
  }

  getParameter(paramId: string): AudioParameter | undefined {
    return this.parameters.find((p) => p.id === paramId);
  }

  setEnabled(active: boolean): void {
    this.enabled.setValue(active ? 1 : 0);
  }

  process(ctx: IProcessingContext): void {
    const input = this.inputBuffer(ctx);
    if (!input) {
      this.outputs[0].buffer = null;
      return;
    }
    const len = input[0]?.length ?? ctx.bufferSize;
    const out = copyInput(input, len);
    if (this.enabled.getValueAtTime(ctx.currentTime) <= 0.5) {
      this.outputs[0].buffer = out;
      return;
    }
    const sr = ctx.sampleRate;
    const threshold = this.threshold.getValueAtTime(ctx.currentTime);
    const ratio = this.ratio.getValueAtTime(ctx.currentTime);
    const knee = this.knee.getValueAtTime(ctx.currentTime);
    const makeupDb = this.makeup.getValueAtTime(ctx.currentTime);
    const att = smoothingCoefficient(this.attack.getValueAtTime(ctx.currentTime), sr);
    const rel = smoothingCoefficient(this.release.getValueAtTime(ctx.currentTime), sr);

    for (let i = 0; i < len; i++) {
      let peak = 0;
      for (let ch = 0; ch < input.length; ch++) peak = Math.max(peak, Math.abs(input[ch]?.[i] ?? 0));
      const levelDb = toDb(peak);
      const targetGrDb = Math.max(0, levelDb - compressorCurveDb(levelDb, threshold, ratio, knee));
      const coef = targetGrDb > this.compEnvDb ? att : rel;
      this.compEnvDb += coef * (targetGrDb - this.compEnvDb);
      if (this.compEnvDb < 0) this.compEnvDb = 0;
      const gain = fromDb(makeupDb - this.compEnvDb);
      for (let ch = 0; ch < out.length; ch++) {
        let s = (out[ch]?.[i] ?? 0) * gain;
        if (!Number.isFinite(s)) s = 0;
        out[ch][i] = Math.max(-4, Math.min(4, s));
      }
    }
    this.outputs[0].buffer = out;
  }

  reset(): void {
    this.compEnvDb = 0;
    this.outputs[0].buffer = null;
  }
}

// ---------------------------------------------------------------------------
// MasteringNode
// ---------------------------------------------------------------------------

export class MasteringNode extends BaseNode implements AutomatableV2Node {
  readonly threshold: AudioParameter;
  readonly ratio: AudioParameter;
  readonly knee: AudioParameter;
  readonly makeup: AudioParameter;
  readonly ceiling: AudioParameter;
  readonly release: AudioParameter;
  private peak = 0.98;

  constructor(id: string) {
    super(id, 'mastering', 1, 1);
    this.threshold = new AudioParameter('threshold', -60, 0, -14);
    this.ratio = new AudioParameter('ratio', 1, 20, 3);
    this.knee = new AudioParameter('knee', 0, 24, 6);
    this.makeup = new AudioParameter('makeup', 0, 4, 1);
    this.ceiling = new AudioParameter('ceiling', 0.1, 1, 0.98);
    this.release = new AudioParameter('release', 0.005, 1, 0.05);
    this.parameters.push(this.threshold, this.ratio, this.knee, this.makeup, this.ceiling, this.release);
  }

  getParameter(paramId: string): AudioParameter | undefined {
    return this.parameters.find((p) => p.id === paramId);
  }

  process(ctx: IProcessingContext): void {
    const input = this.inputBuffer(ctx);
    if (!input) {
      this.outputs[0].buffer = null;
      return;
    }
    const len = input[0]?.length ?? ctx.bufferSize;
    const out = copyInput(input, len);
    const sr = ctx.sampleRate;
    const threshold = this.threshold.getValueAtTime(ctx.currentTime);
    const ratio = this.ratio.getValueAtTime(ctx.currentTime);
    const knee = this.knee.getValueAtTime(ctx.currentTime);
    const makeup = this.makeup.getValueAtTime(ctx.currentTime);
    const ceiling = this.ceiling.getValueAtTime(ctx.currentTime);
    const releaseCoef = smoothingCoefficient(this.release.getValueAtTime(ctx.currentTime), sr);
    if (this.peak < ceiling) this.peak = ceiling;

    for (let i = 0; i < len; i++) {
      let peak = 0;
      for (let ch = 0; ch < input.length; ch++) peak = Math.max(peak, Math.abs(input[ch]?.[i] ?? 0));
      const dbPeak = toDb(peak);
      const grDb = Math.max(0, dbPeak - compressorCurveDb(dbPeak, threshold, ratio, knee));
      const gr = fromDb(-grDb);
      if (peak > this.peak) this.peak = peak;
      else this.peak = Math.max(ceiling, this.peak - (this.peak - ceiling) * releaseCoef);
      const limiterGain = Math.min(1, ceiling / Math.max(this.peak, 1e-8));
      const gain = gr * limiterGain * makeup;
      for (let ch = 0; ch < out.length; ch++) {
        let s = (out[ch]?.[i] ?? 0) * gain;
        if (!Number.isFinite(s)) s = 0;
        out[ch][i] = Math.max(-1, Math.min(1, s));
      }
    }
    this.outputs[0].buffer = out;
  }

  reset(): void {
    this.peak = this.ceiling.defaultValue;
    this.outputs[0].buffer = null;
  }
}
