/**
 * audioMONASTRY · V2 Processing Nodes (Phase 5 – DSP/Effekt/Mastering)
 * ====================================================================
 * Backend-unabhängige IAudioNode-Implementierungen für den V2-AudioGraph:
 *
 *   ParametricEqNode    – 3-Band EQ (Low-Shelf / Peaking / High-Shelf)
 *   DspFilterNode       – dynamisches Lowpass + Soft-Clipper (DSP-Engine)
 *   EffectNode          – Reverb/Delay/Chorus/Bitcrusher (Effekt-Engine)
 *   DynamicsNode        – Soft-Knee-Kompressor (Dynamics-Insert)
 *   MasteringNode       – Kompressor (Attack/Release) + Lookahead-True-Peak-Limiter
 *
 * Alle Nodes sind deterministisch, ohne WebAudio-/Worklet-API und besitzen
 * `AudioParameter`-Objekte, die über `getParameter(paramId)` automatisierbar
 * sind (siehe `src/core/audio/state/v2NodeAutomation.ts`).
 */
import { AudioParameter } from '../AudioGraph';
import { BaseNode } from './basicNodes';
// Gemeinsamer Dynamics-Rechenkern (auch das Worklet dynamicsProcessor nutzt ihn).
import {
  compressorCurveDb,
  fromDb,
  smoothingCoefficient,
  toDb,
} from '../../dsp/dynamicsMath';
import {
  MASTERING_DEFAULTS,
  MasteringDynamics,
  type MasteringDynamicsOptions,
} from '../../dsp/masteringDynamics';
import type { IProcessingContext } from '../types';
import type { AutomatableV2Node } from '../state/v2NodeAutomation';

type BiquadType = 'peaking' | 'lowshelf' | 'highshelf' | 'highpass' | 'lowpass';
/**
 * b0, b1, b2, a1, a2 (normiert auf a0). RT-AUDIT-P0-002: ein vorhandenes
 * Float64Array(5) statt eines neuen Arrays pro Berechnung – Float64 hält die
 * Double-Werte exakt, der Klang bleibt bitgleich.
 */
type BiquadCoefficients = Float64Array;

function createBiquadCoefficients(): BiquadCoefficients {
  const co = new Float64Array(5);
  co[0] = 1;
  return co;
}

// ---------------------------------------------------------------------------
// Pure DSP-Helfer: Rechenkern in src/core/dsp/dynamicsMath.ts, hier re-exportiert
// (die V2-Paritaetstests lesen toDb/fromDb von diesem Modul).
// ---------------------------------------------------------------------------

export { compressorCurveDb, fromDb, smoothingCoefficient, toDb } from '../../dsp/dynamicsMath';

/**
 * Berechnet die RBJ-Biquad-Koeffizienten und schreibt sie in `out`
 * (RT-AUDIT-P0-002/P2-017: allokationsfrei, kein Array-Literal/`slice`).
 */
function computeBiquadCoefficients(
  type: BiquadType,
  freq: number,
  gainDb: number,
  q: number,
  sampleRate: number,
  out: BiquadCoefficients,
): BiquadCoefficients {
  const sr = Math.max(8000, Number.isFinite(sampleRate) ? sampleRate : 48000);
  const f = Math.max(5, Math.min(sr / 2 - 1, Number.isFinite(freq) ? freq : 1000));
  const qq = Math.max(0.1, Math.min(18, Number.isFinite(q) ? q : 0.707));
  const g = Math.max(-24, Math.min(24, gainDb));
  // ARCH-AUDIO-002: Bei 0 dB Gain muss ein Shelf-/Peaking-Filter exakt
  // transparent sein (RBJ-Formeln degenerieren bei A=1 sonst zu b1≠a1).
  if (type !== 'highpass' && type !== 'lowpass' && Math.abs(g) < 1e-9) {
    out[0] = 1;
    out[1] = 0;
    out[2] = 0;
    out[3] = 0;
    out[4] = 0;
    return out;
  }
  const w = (2 * Math.PI * f) / sr;
  const cw = Math.cos(w);
  const sn = Math.sin(w);
  if (type === 'highpass' || type === 'lowpass') {
    const alpha = sn / (2 * qq);
    const a0 = 1 + alpha;
    const b0 = (1 + (type === 'highpass' ? cw : -cw)) / 2;
    const b1 = (type === 'highpass' ? -1 : 1) * (1 + (type === 'highpass' ? cw : -cw));
    const b2 = b0;
    out[0] = b0 / a0;
    out[1] = b1 / a0;
    out[2] = b2 / a0;
    out[3] = (-2 * cw) / a0;
    out[4] = (1 - alpha) / a0;
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
      out[0] = b0 / a0;
      out[1] = b1 / a0;
      out[2] = b2 / a0;
      out[3] = a1 / a0;
      out[4] = a2 / a0;
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
      out[0] = b0 / a0;
      out[1] = b1 / a0;
      out[2] = b2 / a0;
      out[3] = a1 / a0;
      out[4] = a2 / a0;
    }
  }
  for (let i = 0; i < 5; i++) if (!Number.isFinite(out[i])) out[i] = 0;
  return out;
}

class BiquadState {
  /**
   * Referenz auf einen GETEILTEN Koeffizientensatz (je Band bzw. je Filter);
   * Neuberechnungen schreiben dort hinein, die Zustände sehen sie sofort.
   */
  private readonly co: BiquadCoefficients;
  private z1 = 0;
  private z2 = 0;

  constructor(co: BiquadCoefficients) {
    this.co = co;
  }

  reset(): void {
    this.z1 = 0;
    this.z2 = 0;
  }

  process(x: number): number {
    // Indexzugriff statt Array-Destrukturierung (kein Iterator pro Sample).
    const co = this.co;
    const b0 = co[0];
    const b1 = co[1];
    const b2 = co[2];
    const a1 = co[3];
    const a2 = co[4];
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
  /** Gain-Parameter je Band in Bandreihenfolge (kein Map-Lookup pro Block). */
  private readonly bandParams: (AudioParameter | undefined)[];
  /**
   * RT-AUDIT-P0-002: Koeffizienten je Band, nur bei geändertem Gain bzw.
   * geänderter Sample-Rate neu berechnet (vorher `bands.map` + `slice` pro Block).
   */
  private readonly coeffs: BiquadCoefficients[];
  private readonly coeffGain: Float64Array;
  private coeffSampleRate = Number.NaN;

  constructor(id: string, bands: EqBandSpec[] = DEFAULT_EQ_BANDS) {
    super(id, 'eq', 1, 1);
    this.bands = bands;
    this.states = bands.map(() => []);
    for (const band of bands) {
      const param = new AudioParameter(band.id, -24, 24, 0);
      this.bandGains.set(band.id, param);
      this.parameters.push(param);
    }
    this.bandParams = bands.map((band) => this.bandGains.get(band.id));
    this.coeffs = bands.map(() => createBiquadCoefficients());
    this.coeffGain = new Float64Array(bands.length).fill(Number.NaN);
  }

  setBandGain(bandId: string, gainDb: number): void {
    const p = this.bandGains.get(bandId);
    if (p) p.setValue(gainDb);
  }

  getParameter(paramId: string): AudioParameter | undefined {
    return this.bandGains.get(paramId);
  }

  process(ctx: IProcessingContext): void {
    const block = this.prepareProcess(ctx);
    if (!block) return;
    const { input, out, len } = block;
    const sampleRateChanged = ctx.sampleRate !== this.coeffSampleRate;
    this.coeffSampleRate = ctx.sampleRate;
    for (let b = 0; b < this.bands.length; b++) {
      const gain = this.bandParams[b]?.getValueAtTime(ctx.currentTime) ?? 0;
      // Object.is: NaN-Startwert erzwingt die erste Berechnung, −0/+0 bleiben getrennt.
      if (!sampleRateChanged && Object.is(gain, this.coeffGain[b])) continue;
      this.coeffGain[b] = gain;
      const band = this.bands[b];
      computeBiquadCoefficients(band.type, band.freq, gain, band.q, ctx.sampleRate, this.coeffs[b]);
    }
    for (let ch = 0; ch < input.length; ch++) {
      if (!this.states[0][ch]) {
        for (let band = 0; band < this.bands.length; band++) {
          this.states[band][ch] = new BiquadState(this.coeffs[band]);
        }
      }
    }
    for (let ch = 0; ch < out.length; ch++) {
      for (let i = 0; i < len; i++) {
        let s = out[ch][i];
        for (let band = 0; band < this.bands.length; band++) {
          s = this.states[band][ch].process(s);
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

/** RT-AUDIT-P2-017: Koeffizienten-Update höchstens alle 16 Samples (16 − 1 als Bitmaske). */
const DSP_COEFF_INTERVAL_MASK = 15;

export class DspFilterNode extends BaseNode implements AutomatableV2Node {
  readonly cutoff: AudioParameter;
  readonly resonance: AudioParameter;
  readonly depth: AudioParameter;
  readonly drive: AudioParameter;
  private readonly lowpassStates: BiquadState[] = [];
  /** Geteilter Lowpass-Koeffizientensatz aller Kanäle (in-place aktualisiert). */
  private readonly lowpassCoeffs = createBiquadCoefficients();
  private env = 0;

  constructor(id: string) {
    super(id, 'dsp', 1, 1);
    this.cutoff = new AudioParameter('cutoff', 20, 20000, 1000);
    this.resonance = new AudioParameter('resonance', 0.1, 1, 0.5);
    this.depth = new AudioParameter('depth', 0, 1, 0.4);
    this.drive = new AudioParameter('drive', 0, 1, 0);
    this.parameters.push(this.cutoff, this.resonance, this.depth, this.drive);
  }

  process(ctx: IProcessingContext): void {
    const block = this.prepareProcess(ctx);
    if (!block) return;
    const { input, out, len, sr } = block;
    const drive = this.drive.getValueAtTime(ctx.currentTime);
    const depth = this.depth.getValueAtTime(ctx.currentTime);
    // AUDIO-P0-004: Tiefe 0 + Drive 0 = bit-transparenter Bypass (kein Filter-Tail).
    // RT-AUDIT-P0-002: Bypass vor den übrigen (reinen) Berechnungen prüfen.
    if (drive <= 0 && depth <= 0) {
      this.outputs[0].buffer = out;
      return;
    }
    const att = smoothingCoefficient(0.02, sr);
    const rel = smoothingCoefficient(0.08, sr);
    const baseCutoff = this.cutoff.getValueAtTime(ctx.currentTime);
    const q = this.resonance.getValueAtTime(ctx.currentTime);
    const driveNorm = Math.tanh(1 + drive * 1.6);

    for (let ch = 0; ch < out.length; ch++) {
      if (!this.lowpassStates[ch]) this.lowpassStates[ch] = new BiquadState(this.lowpassCoeffs);
    }

    let lastCutoff = -1;
    for (let i = 0; i < len; i++) {
      let mono = 0;
      for (let ch = 0; ch < input.length; ch++) {
        const inCh = input[ch];
        mono += Math.abs(i < inCh.length ? inCh[i] : 0);
      }
      mono /= Math.max(1, input.length);
      const coef = mono > this.env ? att : rel;
      this.env += coef * (mono - this.env);
      if (this.env < 0) this.env = 0;
      // RT-AUDIT-P2-017: Koeffizienten höchstens alle 16 Samples (die Hüllkurve
      // läuft weiter pro Sample) und in den vorhandenen Satz geschrieben – vorher
      // pro Sample mit neuem Array. Bei statischer Hüllkurve identisch (Sample 0).
      if ((i & DSP_COEFF_INTERVAL_MASK) === 0) {
        const modCutoff = Math.min(sr / 2 - 1, Math.max(20, baseCutoff + depth * this.env * 4000));
        if (Math.abs(modCutoff - lastCutoff) > 0.1) {
          lastCutoff = modCutoff;
          computeBiquadCoefficients('lowpass', modCutoff, 0, q, sr, this.lowpassCoeffs);
        }
      }
      for (let ch = 0; ch < out.length; ch++) {
        // Zustände existieren für alle Kanäle (oben angelegt); ohne `?.`/`??`,
        // die den Double-Wert pro Sample boxen würden (RT-AUDIT-P0-002).
        let s = this.lowpassStates[ch].process(out[ch][i]);
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

/**
 * RT-AUDIT-P1-011: Zustand EINES Kanals (Reverb-Combs/Allpässe, Chorus-Delay,
 * Crusher). Vorher teilten sich alle Kanäle einen Satz: L und R liefen
 * verschachtelt durch dieselben Delay-Lines → Stereo-Übersprechen, halbierte
 * Delay-Zeiten, doppelte Crusher-Rate. Wird einmal je Kanal angelegt (nur bei
 * geänderter Kanalzahl, nicht im Block-Takt).
 */
class FxChannelState {
  readonly comb1 = new Float32Array(COMB1);
  readonly comb2 = new Float32Array(COMB2);
  readonly all1 = new Float32Array(ALL1);
  readonly all2 = new Float32Array(ALL2);
  readonly chorus = new Float32Array(CHORUS_LEN);
  comb1Pos = 0;
  comb2Pos = 0;
  all1Pos = 0;
  all2Pos = 0;
  chorusPos = 0;
  crushCounter = 0;
  crushHold = 0;

  reset(): void {
    this.comb1.fill(0);
    this.comb2.fill(0);
    this.all1.fill(0);
    this.all2.fill(0);
    this.chorus.fill(0);
    this.comb1Pos = this.comb2Pos = this.all1Pos = this.all2Pos = 0;
    this.chorusPos = 0;
    this.crushCounter = 0;
    this.crushHold = 0;
  }
}

export class EffectNode extends BaseNode implements AutomatableV2Node {
  readonly wet: AudioParameter;
  readonly feedback: AudioParameter;
  readonly rate: AudioParameter;
  readonly depth: AudioParameter;
  readonly bits: AudioParameter;
  readonly sampleReduction: AudioParameter;

  /** RT-AUDIT-P1-011: ein Zustandssatz je Kanal (Index = Kanal). */
  private channelStates: FxChannelState[] = [new FxChannelState(), new FxChannelState()];
  /** Chorus-LFO ist kanalübergreifend EIN Oszillator (einmal pro Sample fortgeschrieben). */
  private chorusPhase = 0;

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

  process(ctx: IProcessingContext): void {
    const block = this.prepareProcess(ctx);
    if (!block) return;
    const { out, len, sr } = block;
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
    // Zustände nur bei geänderter Kanalzahl nachziehen (nicht im Block-Takt).
    while (this.channelStates.length < out.length) this.channelStates.push(new FxChannelState());
    const phaseStep = 2 * Math.PI * chorusRate / sr;

    for (let i = 0; i < len; i++) {
      const t = (i / sr) + ctx.currentTime;
      // RT-AUDIT-P1-011: LFO einmal pro Sample (vorher pro Kanal → doppelte Rate bei Stereo).
      this.chorusPhase = (this.chorusPhase + phaseStep) % (2 * Math.PI);
      const lfo = Math.sin(this.chorusPhase + t * chorusRate * 0.1);
      const delaySamples = Math.round(1 + chorusDepth * 1500 * (0.5 + 0.5 * lfo));
      for (let ch = 0; ch < out.length; ch++) {
        const st = this.channelStates[ch];
        const x = out[ch][i];
        const rvb = this.reverb(st, x, fb);
        const chrs = this.chorusProcess(st, x, delaySamples);
        const crs = this.crush(st, x, crushLevels, crushReduction);
        const eff = rvb * 0.6 + chrs * 0.2 + crs * 0.2;
        const y = x * (1 - wetAmt) + eff * wetAmt;
        out[ch][i] = Number.isFinite(y) ? y : 0;
      }
    }
    this.outputs[0].buffer = out;
  }

  private reverb(st: FxChannelState, x: number, feedback: number): number {
    x = Math.abs(x) < 1e-20 ? 0 : x;
    const c1out = st.comb1[st.comb1Pos];
    st.comb1[st.comb1Pos] = x + c1out * feedback;
    st.comb1Pos = (st.comb1Pos + 1) % COMB1;
    const c2out = st.comb2[st.comb2Pos];
    st.comb2[st.comb2Pos] = x + c2out * feedback;
    st.comb2Pos = (st.comb2Pos + 1) % COMB2;
    const diff = c1out + c2out;
    const a1read = st.all1[st.all1Pos];
    st.all1[st.all1Pos] = diff + a1read * 0.5;
    st.all1Pos = (st.all1Pos + 1) % ALL1;
    const a2read = st.all2[st.all2Pos];
    st.all2[st.all2Pos] = diff + a2read * 0.5;
    st.all2Pos = (st.all2Pos + 1) % ALL2;
    return (a1read + a2read) * 0.5;
  }

  private chorusProcess(st: FxChannelState, x: number, delaySamples: number): number {
    st.chorus[st.chorusPos] = x;
    const readPos = (st.chorusPos - delaySamples + CHORUS_LEN) % CHORUS_LEN;
    const delayed = st.chorus[readPos];
    st.chorusPos = (st.chorusPos + 1) % CHORUS_LEN;
    return delayed;
  }

  private crush(st: FxChannelState, x: number, levels: number, reduction: number): number {
    if (--st.crushCounter <= 0) {
      st.crushCounter = reduction;
      st.crushHold = x;
    }
    return Math.round(st.crushHold * levels) / levels;
  }

  reset(): void {
    for (const st of this.channelStates) st.reset();
    this.chorusPhase = 0;
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

  setEnabled(active: boolean): void {
    this.enabled.setValue(active ? 1 : 0);
  }

  process(ctx: IProcessingContext): void {
    const block = this.prepareProcess(ctx);
    if (!block) return;
    const { input, out, len } = block;
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
      for (let ch = 0; ch < input.length; ch++) {
        const inCh = input[ch];
        peak = Math.max(peak, Math.abs(i < inCh.length ? inCh[i] : 0));
      }
      const levelDb = toDb(peak);
      const targetGrDb = Math.max(0, levelDb - compressorCurveDb(levelDb, threshold, ratio, knee));
      const coef = targetGrDb > this.compEnvDb ? att : rel;
      this.compEnvDb += coef * (targetGrDb - this.compEnvDb);
      if (this.compEnvDb < 0) this.compEnvDb = 0;
      const gain = fromDb(makeupDb - this.compEnvDb);
      for (let ch = 0; ch < out.length; ch++) {
        let s = out[ch][i] * gain;
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

/**
 * Master-Dynamik (RT-AUDIT-P0-004): Feed-forward-Kompressor mit Attack/Release-
 * Detektor im dB-Bereich, Makeup, Lookahead-Limiter (5 ms) mit True-Peak-
 * Detektor und harter Sicherung ±ceiling. Der Rechenkern liegt in
 * `src/core/dsp/masteringDynamics.ts` (auch vom Legacy-Worklet genutzt).
 *
 * Parameter (alle automatisierbar über `getParameter`):
 *  - threshold (dBFS, Default −14), ratio (Default 3), knee (dB, Default 6)
 *  - makeup (linear 0…4, Default 1), ceiling (linear 0,1…1, Default 0,98)
 *  - release: LIMITER-Release in s (0,005…1, Default 0,05)
 *  - compAttack: Kompressor-Attack in s (0,0005…0,5, Default 0,01 = 10 ms)
 *  - compRelease: Kompressor-Release in s (0,005…2, Default 0,1 = 100 ms)
 *
 * Latenz: `lookaheadSamples` = round(0,005 · sampleRate) (mind. 16), identisch
 * zu `v2MasteringLookaheadSamples` (PDC) und `getLatencyBudgetMs`.
 */
export class MasteringNode extends BaseNode implements AutomatableV2Node {
  readonly threshold: AudioParameter;
  readonly ratio: AudioParameter;
  readonly knee: AudioParameter;
  readonly makeup: AudioParameter;
  readonly ceiling: AudioParameter;
  /** Limiter-Release (Sekunden). */
  readonly release: AudioParameter;
  /** Kompressor-Attack (Sekunden, Default 10 ms). */
  readonly compAttack: AudioParameter;
  /** Kompressor-Release (Sekunden, Default 100 ms). */
  readonly compRelease: AudioParameter;
  private readonly dynamics: MasteringDynamics;

  constructor(id: string, sampleRate = 48000, options: MasteringDynamicsOptions = {}) {
    super(id, 'mastering', 1, 1);
    const d = MASTERING_DEFAULTS;
    this.threshold = new AudioParameter('threshold', -60, 0, d.threshold);
    this.ratio = new AudioParameter('ratio', 1, 20, d.ratio);
    this.knee = new AudioParameter('knee', 0, 24, d.knee);
    this.makeup = new AudioParameter('makeup', 0, 4, d.makeup);
    this.ceiling = new AudioParameter('ceiling', 0.1, 1, d.ceiling);
    this.release = new AudioParameter('release', 0.005, 1, d.release);
    this.compAttack = new AudioParameter('compAttack', 0.0005, 0.5, d.compAttack);
    this.compRelease = new AudioParameter('compRelease', 0.005, 2, d.compRelease);
    this.parameters.push(
      this.threshold, this.ratio, this.knee, this.makeup, this.ceiling,
      this.release, this.compAttack, this.compRelease,
    );
    this.dynamics = new MasteringDynamics(sampleRate, 2, options);
  }

  /** Lookahead = Latenz des Knotens in Samples (bei der zuletzt genutzten Sample-Rate). */
  get lookaheadSamples(): number {
    return this.dynamics.lookaheadSamples;
  }

  /** Latenz in Sekunden (lookaheadSamples / sampleRate). */
  get latencySeconds(): number {
    return this.dynamics.latencySeconds;
  }

  /** Gain-Reduction des Kompressors in dB (Meter/Tests). */
  get gainReductionDb(): number {
    return this.dynamics.gainReductionDb;
  }

  /** Gain-Reduction des Limiters in dB (Meter/Tests). */
  get limiterGainReductionDb(): number {
    return this.dynamics.limiterGainReductionDb;
  }

  /** Eingriffe der harten Sicherung hinter dem Limiter (Soll: 0). */
  get safetyClipCount(): number {
    return this.dynamics.safetyClipCount;
  }

  process(ctx: IProcessingContext): void {
    const block = this.prepareProcess(ctx);
    if (!block) return;
    const { out, len, sr } = block;
    const t = ctx.currentTime;
    const d = this.dynamics;
    // Allokiert nur beim ersten Block bzw. bei Sample-Rate-/Kanalwechsel.
    d.configure(sr, out.length);
    d.threshold = this.threshold.getValueAtTime(t);
    d.ratio = this.ratio.getValueAtTime(t);
    d.knee = this.knee.getValueAtTime(t);
    d.makeup = this.makeup.getValueAtTime(t);
    d.ceiling = this.ceiling.getValueAtTime(t);
    d.setTimes(
      this.compAttack.getValueAtTime(t),
      this.compRelease.getValueAtTime(t),
      this.release.getValueAtTime(t),
    );
    d.process(out, 0, len);
    this.outputs[0].buffer = out;
  }

  reset(): void {
    this.dynamics.reset();
    this.outputs[0].buffer = null;
  }
}
