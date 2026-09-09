/**
 * audioMONASTRY · Backend-unabhängige Basis-Audio-Nodes (Phase 1, Schritt 2)
 * ===========================================================================
 * Gain/Pan/EQ-Kette als reine IAudioNode-Implementierungen ohne WebAudio.
 */
import { AudioParameter, AudioPort } from '../AudioGraph';
import { audioBufferPool } from '../BufferPool';
import { Stereo21Crossover } from '../../output/crossover';
import type { IAudioNode, IAudioPort, IProcessingContext } from '../types';

abstract class BaseNode implements IAudioNode {
  readonly inputs: AudioPort[];
  readonly outputs: AudioPort[];
  readonly parameters: AudioParameter[];

  constructor(public readonly id: string, public readonly type: string, inputs = 1, outputs = 1) {
    this.inputs = Array.from({ length: inputs }, (_, i) => new AudioPort(this, 'input', `${id}:in${i}`));
    this.outputs = Array.from({ length: outputs }, (_, i) => new AudioPort(this, 'output', `${id}:out${i}`));
    this.parameters = [];
  }

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- bewusst beibehalten (Runde 3)
  protected inputBuffer(ctx: IProcessingContext): Float32Array[] | null {
    return this.inputs[0]?.connections[0]?.buffer ?? null;
  }

  abstract process(ctx: IProcessingContext): void;
  reset(): void { /* Parameter zurücksetzen */ }
}

/** Statische Quelle (z.B. Sample/Pattern). */
export class SourceNode extends BaseNode {
  constructor(id: string, public sourceBuffer: Float32Array[], public readonly sourceSampleRate = 48000) {
    super(id, 'source', 0, 1);
  }

  process(ctx: IProcessingContext): void {
    const len = this.sourceBuffer[0]?.length ?? ctx.bufferSize;
    const out = audioBufferPool.acquire(this.sourceBuffer.length, len);
    for (let ch = 0; ch < this.sourceBuffer.length; ch++) out[ch].set(this.sourceBuffer[ch]);
    this.outputs[0].buffer = out;
  }
}

export class GainNode extends BaseNode {
  readonly gain: AudioParameter;

  constructor(id: string, gain = 1) {
    super(id, 'gain', 1, 1);
    this.gain = new AudioParameter('gain', 0, 4, gain);
    this.parameters.push(this.gain);
  }

  process(ctx: IProcessingContext): void {
    const input = this.inputBuffer(ctx);
    if (!input) { this.outputs[0].buffer = null; return; }
    const len = input[0]?.length ?? ctx.bufferSize;
    const out = audioBufferPool.acquire(input.length, len);
    const g = this.gain.getValueAtTime(ctx.currentTime);
    for (let ch = 0; ch < input.length; ch++) {
      for (let i = 0; i < len; i++) out[ch][i] = input[ch][i] * g;
    }
    this.outputs[0].buffer = out;
  }

  reset(): void {
    this.gain.reset();
    this.outputs[0].buffer = null;
  }
}

export class StereoPanNode extends BaseNode {
  readonly pan: AudioParameter;

  constructor(id: string, pan = 0) {
    super(id, 'pan', 1, 1);
    this.pan = new AudioParameter('pan', -1, 1, pan);
    this.parameters.push(this.pan);
  }

  process(ctx: IProcessingContext): void {
    const input = this.inputBuffer(ctx);
    if (!input) { this.outputs[0].buffer = null; return; }
    const len = input[0]?.length ?? ctx.bufferSize;
    const out = audioBufferPool.acquire(Math.max(2, input.length), len);
    const p = Math.max(-1, Math.min(1, this.pan.getValueAtTime(ctx.currentTime)));
    const theta = (p + 1) * Math.PI / 4;
    const lg = Math.cos(theta);
    const rg = Math.sin(theta);
    const left = input[0] ?? new Float32Array(len);
    const right = input[1] ?? input[0] ?? new Float32Array(len);
    for (let i = 0; i < len; i++) {
      out[0][i] = left[i] * lg;
      out[1][i] = right[i] * rg;
    }
    this.outputs[0].buffer = out;
  }

  reset(): void {
    this.pan.reset();
    this.outputs[0].buffer = null;
  }
}

/** Einfacher 3-Band-EQ (Gain pro Band, lineare Mischung – kein Biquad). */
export class ThreeBandEqNode extends BaseNode {
  readonly lowGain: AudioParameter;
  readonly midGain: AudioParameter;
  readonly highGain: AudioParameter;

  constructor(id: string, low = 0, mid = 0, high = 0) {
    super(id, 'eq3', 1, 1);
    this.lowGain = new AudioParameter('low', -24, 24, low);
    this.midGain = new AudioParameter('mid', -24, 24, mid);
    this.highGain = new AudioParameter('high', -24, 24, high);
    this.parameters.push(this.lowGain, this.midGain, this.highGain);
  }

  process(ctx: IProcessingContext): void {
    const input = this.inputBuffer(ctx);
    if (!input) { this.outputs[0].buffer = null; return; }
    const len = input[0]?.length ?? ctx.bufferSize;
    const out = audioBufferPool.acquire(input.length, len);
    const lo = Math.pow(10, this.lowGain.getValueAtTime(ctx.currentTime) / 20);
    const mid = Math.pow(10, this.midGain.getValueAtTime(ctx.currentTime) / 20);
    const hi = Math.pow(10, this.highGain.getValueAtTime(ctx.currentTime) / 20);
    for (let ch = 0; ch < input.length; ch++) {
      for (let i = 0; i < len; i++) {
        // Vereinfachte Spektralgewichtung: Bänder über gleitenden Mittelwert trennen.
        out[ch][i] = input[ch][i] * ((lo + mid + hi) / 3);
      }
    }
    this.outputs[0].buffer = out;
  }

  reset(): void {
    this.lowGain.reset();
    this.midGain.reset();
    this.highGain.reset();
    this.outputs[0].buffer = null;
  }
}

/** Master-Summe: N Mono-Eingänge → Stereo-Ausgang (NaN/Inf-sicher, Soft-Clip). */
export class MasterSumNode extends BaseNode {
  readonly masterGain: AudioParameter;

  constructor(id: string, inputs = 8) {
    super(id, 'master', inputs, 1);
    this.masterGain = new AudioParameter('masterGain', 0, 2, 1);
    this.parameters.push(this.masterGain);
  }

  process(ctx: IProcessingContext): void {
    const len = ctx.bufferSize;
    const out = audioBufferPool.acquire(2, len);
    out[0].fill(0);
    out[1].fill(0);
    const g = this.masterGain.getValueAtTime(ctx.currentTime);
    for (const input of this.inputs) {
      const src = input.connections[0]?.buffer;
      if (!src) continue;
      const left = src[0];
      const right = src[1] ?? src[0];
      if (!left) continue;
      for (let i = 0; i < len; i++) {
        out[0][i] += left[i] * g;
        out[1][i] += (right[i] ?? left[i]) * g;
      }
    }
    // P0-4/AM-E1-7: NaN/Inf-Guards + Soft-Clip.
    for (let ch = 0; ch < 2; ch++) {
      for (let i = 0; i < len; i++) {
        let v = out[ch][i];
        if (!Number.isFinite(v)) v = 0;
        v = Math.tanh(v) * 0.98;
        out[ch][i] = v;
      }
    }
    this.outputs[0].buffer = out;
  }

  reset(): void {
    this.masterGain.reset();
    this.outputs[0].buffer = null;
  }
}

/**
 * Summen-/Bus-Knoten für den V2-Routing-Pfad (Phase 4).
 * Summiert N Eingänge auf `outputChannels` planare Kanäle. Mono-Quellen werden
 * auf alle Zielkanäle dupliziert, damit Cue-Bus und Monitor-Mischung ohne
 * Channel-Splitter/merger auskommen.
 */
export class StereoSumNode extends BaseNode {
  readonly gain: AudioParameter;

  constructor(id: string, inputs = 1, gain = 1, public readonly outputChannels = 2) {
    super(id, 'sum', inputs, 1);
    this.gain = new AudioParameter(`${id}:gain`, 0, 4, gain);
    this.parameters.push(this.gain);
  }

  process(ctx: IProcessingContext): void {
    const len = ctx.bufferSize;
    const out = audioBufferPool.acquire(this.outputChannels, len);
    for (const ch of out) ch.fill(0);
    const g = this.gain.getValueAtTime(ctx.currentTime);
    for (const input of this.inputs) {
      const src = input.connections[0]?.buffer;
      if (!src || src.length === 0) continue;
      for (let ch = 0; ch < this.outputChannels; ch++) {
        const srcCh = src[Math.min(ch, src.length - 1)] ?? src[0];
        if (!srcCh) continue;
        for (let i = 0; i < len; i++) out[ch][i] += srcCh[i] * g;
      }
    }
    // NaN/Inf-Schutz analog MasterSumNode – ein defekter Input darf den Bus nicht kippen.
    for (const ch of out) {
      for (let i = 0; i < len; i++) {
        const v = ch[i];
        if (!Number.isFinite(v)) ch[i] = 0;
      }
    }
    this.outputs[0].buffer = out;
  }

  reset(): void {
    this.gain.reset();
    this.outputs[0].buffer = null;
  }
}

/**
 * 2.1-Master-Ausgangs-Knoten (Phase 4): Stereo-Eingang → L/R/LFE.
 * Nutzt denselben Linkwitz-Riley-Crossover wie der V1-Pfad (`core/output`).
 */
export class Stereo21OutputNode extends BaseNode {
  private readonly crossover: Stereo21Crossover;

  constructor(id: string, sampleRate = 48000, crossoverHz = 90) {
    super(id, 'stereo21', 1, 1);
    this.crossover = new Stereo21Crossover(sampleRate, crossoverHz, '2.1');
  }

  process(ctx: IProcessingContext): void {
    const input = this.inputBuffer(ctx);
    if (!input) {
      this.outputs[0].buffer = null;
      return;
    }
    const len = input[0]?.length ?? ctx.bufferSize;
    const left = input[0] ?? new Float32Array(len);
    const right = input[1] ?? left;
    const result = this.crossover.process(left, right);
    this.outputs[0].buffer = [result.left, result.right, result.lfe];
  }

  reset(): void {
    this.crossover.reset();
    this.outputs[0].buffer = null;
  }
}

/**
 * Mehrkanal-Spatial-Bus-Knoten (Phase 4): nimmt einen Stereo-Master entgegen
 * und verteilt den Mono-Anteil (L+R)/2 über frei konfigurierbare Kanal-Gewichte
 * auf N Ausgangskanäle. Das entspricht dem V1-Spatial-Bus-Modell
 * (`buildSpatialBus`) – backend-unabhängig und deterministisch.
 */
export class MultichannelBusNode extends BaseNode {
  readonly channelGains: AudioParameter[] = [];

  constructor(id: string, outputChannels: number) {
    super(id, 'multichannel', 1, 1);
    for (let i = 0; i < outputChannels; i++) {
      const p = new AudioParameter(`${id}:out${i}`, 0, 2, 0);
      this.channelGains.push(p);
      this.parameters.push(p);
    }
  }

  setChannelGain(channel: number, value: number): void {
    const p = this.channelGains[channel];
    if (p) p.setValue(Math.max(0, Math.min(2, value)));
  }

  setChannelGains(weights: readonly number[]): void {
    for (let i = 0; i < this.channelGains.length; i++) this.setChannelGain(i, weights[i] ?? 0);
  }

  get outputChannels(): number {
    return this.channelGains.length;
  }

  process(ctx: IProcessingContext): void {
    const input = this.inputBuffer(ctx);
    if (!input) {
      this.outputs[0].buffer = null;
      return;
    }
    const len = input[0]?.length ?? ctx.bufferSize;
    const left = input[0] ?? new Float32Array(len);
    const right = input[1] ?? left;
    const out = audioBufferPool.acquire(this.outputChannels, len);
    for (const ch of out) ch.fill(0);
    for (let i = 0; i < len; i++) {
      const mono = (left[i] + right[i]) * 0.5;
      for (let ch = 0; ch < this.outputChannels; ch++) {
        out[ch][i] = mono * this.channelGains[ch].getValueAtTime(ctx.currentTime);
      }
    }
    this.outputs[0].buffer = out;
  }

  reset(): void {
    for (const p of this.channelGains) p.reset();
    this.outputs[0].buffer = null;
  }
}

export type { IAudioPort };
