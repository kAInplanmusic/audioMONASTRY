/**
 * audioMONASTRY · Optionale DSP-Nodes im V2-Graph (FEAT-P3-002)
 * ============================================================
 * Bindet die getesteten Kerne aus FEAT-P3-001 als echte `IAudioNode`s in den
 * V2-ProcessingPlan ein (Realtime-Worklet und Offline-Bounce nutzen denselben
 * Graphen):
 *
 *   ModMatrixNode  – LFO → Master-Gain; nutzt `applyModMatrix` (kein zweiter
 *                    Routing-Algorithmus, derselbe getestete Kern).
 *   HqReverbNode   – 4-Leitungs-FDN (`HighQualityReverb`), pro Kanal eigener
 *                    Zustand, damit L/R unabhängig klingen.
 *
 * Beide Nodes sind **bypass-transparent** (Default: deaktiviert), damit die
 * Einbindung die V2-Parität nicht verändert, solange der Nutzer sie nicht
 * einschaltet. Sie sind deterministisch und ohne WebAudio-API.
 */
import { AudioParameter } from '../AudioGraph';
import { audioBufferPool } from '../BufferPool';
import { BaseNode } from './basicNodes';
import { applyModMatrix, type ModRoute } from '../../dsp/modMatrix';
import { HighQualityReverb } from '../../dsp/hqReverb';
import type { IProcessingContext } from '../types';
import type { AutomatableV2Node } from '../state/v2NodeAutomation';

function copyInput(input: Float32Array[], len: number): Float32Array[] {
  const out = audioBufferPool.acquire(Math.max(1, input.length), len);
  for (let ch = 0; ch < input.length; ch++) out[ch].set(input[ch]);
  return out;
}

const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------
// ModMatrixNode
// ---------------------------------------------------------------------------

export class ModMatrixNode extends BaseNode implements AutomatableV2Node {
  readonly enabled: AudioParameter;
  readonly rate: AudioParameter;
  readonly depth: AudioParameter;
  private phase = 0;

  constructor(id: string) {
    super(id, 'mod-matrix', 1, 1);
    this.enabled = new AudioParameter('enabled', 0, 1, 0);
    this.rate = new AudioParameter('rate', 0.05, 10, 0.5);
    this.depth = new AudioParameter('depth', 0, 1, 0.35);
    this.parameters.push(this.enabled, this.rate, this.depth);
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
    const active = this.enabled.getValueAtTime(ctx.currentTime) > 0.5;
    const depth = this.depth.getValueAtTime(ctx.currentTime);
    // Tiefe 0 oder aus = bit-transparenter Bypass (kein Tremolo-Rest).
    if (!active || depth <= 0) {
      this.outputs[0].buffer = out;
      return;
    }
    const sr = Math.max(8000, ctx.sampleRate);
    const rate = this.rate.getValueAtTime(ctx.currentTime);
    const step = (TAU * rate) / sr;

    for (let i = 0; i < len; i++) {
      // 0..1-LFO als Quelle; die Matrix bildet sie bipolar auf −depth..+depth ab.
      const sources = { lfo1: 0.5 + 0.5 * Math.sin(this.phase) };
      const routes: ModRoute[] = [
        { id: 'lfo1->master.gain', source: 'lfo1', destination: 'master.gain', depth, polarity: 'bipolar' },
      ];
      const modulation = applyModMatrix(routes, sources, { clampMin: -1, clampMax: 1 }).values['master.gain'] ?? 0;
      const gain = Math.min(2, Math.max(0, 1 + modulation));
      for (let ch = 0; ch < out.length; ch++) {
        const s = (out[ch]?.[i] ?? 0) * gain;
        out[ch][i] = Number.isFinite(s) ? s : 0;
      }
      this.phase += step;
      if (this.phase >= TAU) this.phase -= TAU;
    }
    this.outputs[0].buffer = out;
  }

  reset(): void {
    this.enabled.reset();
    this.rate.reset();
    this.depth.reset();
    this.phase = 0;
    this.outputs[0].buffer = null;
  }
}

// ---------------------------------------------------------------------------
// HqReverbNode
// ---------------------------------------------------------------------------

export class HqReverbNode extends BaseNode implements AutomatableV2Node {
  readonly enabled: AudioParameter;
  readonly mix: AudioParameter;
  readonly decayS: AudioParameter;
  readonly damping: AudioParameter;
  readonly sizeScale: AudioParameter;
  private reverbs: HighQualityReverb[] = [];
  private configKey = '';

  constructor(id: string) {
    super(id, 'hq-reverb', 1, 1);
    this.enabled = new AudioParameter('enabled', 0, 1, 0);
    this.mix = new AudioParameter('mix', 0, 1, 0.3);
    this.decayS = new AudioParameter('decayS', 0.05, 30, 2);
    this.damping = new AudioParameter('damping', 0, 1, 0.35);
    this.sizeScale = new AudioParameter('sizeScale', 0.2, 3, 1);
    this.parameters.push(this.enabled, this.mix, this.decayS, this.damping, this.sizeScale);
  }

  getParameter(paramId: string): AudioParameter | undefined {
    return this.parameters.find((p) => p.id === paramId);
  }

  setEnabled(active: boolean): void {
    this.enabled.setValue(active ? 1 : 0);
  }

  /** Legt die Hall-Zustände neu an, wenn sich die Konfiguration ändert. */
  private ensureReverbs(channels: number, sampleRate: number, decayS: number, damping: number, sizeScale: number): void {
    const key = `${channels}|${sampleRate}|${decayS}|${damping}|${sizeScale}`;
    if (key === this.configKey && this.reverbs.length === channels) return;
    this.configKey = key;
    this.reverbs = Array.from({ length: channels }, () => new HighQualityReverb({ sampleRate, decayS, damping, sizeScale, mix: 1 }));
  }

  process(ctx: IProcessingContext): void {
    const input = this.inputBuffer(ctx);
    if (!input) {
      this.outputs[0].buffer = null;
      return;
    }
    const len = input[0]?.length ?? ctx.bufferSize;
    const out = copyInput(input, len);
    const active = this.enabled.getValueAtTime(ctx.currentTime) > 0.5;
    const wet = this.mix.getValueAtTime(ctx.currentTime);
    // Aus oder Mix 0 = bit-transparenter Bypass (kein Hall-Tail, keine Kosten).
    if (!active || wet <= 0) {
      this.outputs[0].buffer = out;
      return;
    }
    const decayS = this.decayS.getValueAtTime(ctx.currentTime);
    const damping = this.damping.getValueAtTime(ctx.currentTime);
    const sizeScale = this.sizeScale.getValueAtTime(ctx.currentTime);
    this.ensureReverbs(out.length, Math.max(8000, ctx.sampleRate), decayS, damping, sizeScale);

    for (let ch = 0; ch < out.length; ch++) {
      const reverb = this.reverbs[ch];
      if (!reverb) continue;
      const wetBlock = reverb.process(out[ch]);
      // Interner Reverb-Mix = 1 (nur nass); der Dry-Anteil kommt hier dazu.
      for (let i = 0; i < len; i++) {
        const dry = out[ch]?.[i] ?? 0;
        const s = dry * (1 - wet) + (wetBlock[i] ?? 0) * wet;
        out[ch][i] = Number.isFinite(s) ? s : 0;
      }
    }
    this.outputs[0].buffer = out;
  }

  reset(): void {
    this.enabled.reset();
    this.mix.reset();
    this.decayS.reset();
    this.damping.reset();
    this.sizeScale.reset();
    for (const reverb of this.reverbs) reverb.reset();
    this.reverbs = [];
    this.configKey = '';
    this.outputs[0].buffer = null;
  }
}
