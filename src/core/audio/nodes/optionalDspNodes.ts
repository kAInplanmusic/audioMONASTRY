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
import { BaseNode } from './basicNodes';
import { clampModulation, modRouteContribution } from '../../dsp/modMatrix';
import { HighQualityReverb } from '../../dsp/hqReverb';
import { ensureBufferSet } from '../PortBuffers';
import type { IProcessingContext } from '../types';
import type { AutomatableV2Node } from '../state/v2NodeAutomation';

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

  setEnabled(active: boolean): void {
    this.enabled.setValue(active ? 1 : 0);
  }

  process(ctx: IProcessingContext): void {
    const block = this.prepareProcess(ctx);
    if (!block) return;
    const { out, len } = block;
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
      // RT-AUDIT-P0-002: derselbe Rechenkern wie `applyModMatrix` (eine Route
      // lfo1 → master.gain, Summe 0 + Beitrag, Klemmung −1..1), aber ohne
      // Objekt-/Array-Literale pro Sample. depth > 0 ist hier garantiert.
      const lfo1 = 0.5 + 0.5 * Math.sin(this.phase);
      const modulation = clampModulation(0 + modRouteContribution(lfo1, depth, 'bipolar'), -1, 1);
      const gain = Math.min(2, Math.max(0, 1 + modulation));
      for (let ch = 0; ch < out.length; ch++) {
        const s = out[ch][i] * gain;
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
  /** Konfiguration der aktuellen Hall-Zustände (Zahlen statt String-Schlüssel pro Block). */
  private cfgChannels = -1;
  private cfgSampleRate = Number.NaN;
  private cfgDecayS = Number.NaN;
  private cfgDamping = Number.NaN;
  private cfgSizeScale = Number.NaN;
  /** RT-AUDIT-P0-002: fester Nass-Puffer je Kanal (vorher neues Array pro Block). */
  private wetBlock: Float32Array[] | null = null;

  constructor(id: string) {
    super(id, 'hq-reverb', 1, 1);
    this.enabled = new AudioParameter('enabled', 0, 1, 0);
    this.mix = new AudioParameter('mix', 0, 1, 0.3);
    this.decayS = new AudioParameter('decayS', 0.05, 30, 2);
    this.damping = new AudioParameter('damping', 0, 1, 0.35);
    this.sizeScale = new AudioParameter('sizeScale', 0.2, 3, 1);
    this.parameters.push(this.enabled, this.mix, this.decayS, this.damping, this.sizeScale);
  }

  setEnabled(active: boolean): void {
    this.enabled.setValue(active ? 1 : 0);
  }

  /** Legt die Hall-Zustände neu an, wenn sich die Konfiguration ändert. */
  private ensureReverbs(channels: number, sampleRate: number, decayS: number, damping: number, sizeScale: number): void {
    if (
      channels === this.cfgChannels && sampleRate === this.cfgSampleRate && decayS === this.cfgDecayS
      && damping === this.cfgDamping && sizeScale === this.cfgSizeScale && this.reverbs.length === channels
    ) return;
    // Nur bei Parameteränderung (nicht pro Block): neue Delay-Längen erfordern neue Leitungen.
    this.cfgChannels = channels;
    this.cfgSampleRate = sampleRate;
    this.cfgDecayS = decayS;
    this.cfgDamping = damping;
    this.cfgSizeScale = sizeScale;
    this.reverbs = Array.from({ length: channels }, () => new HighQualityReverb({ sampleRate, decayS, damping, sizeScale, mix: 1 }));
  }

  process(ctx: IProcessingContext): void {
    const block = this.prepareProcess(ctx);
    if (!block) return;
    const { out, len } = block;
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
    const wetBlocks = ensureBufferSet(this.wetBlock, out.length, len);
    this.wetBlock = wetBlocks;

    for (let ch = 0; ch < out.length; ch++) {
      const reverb = this.reverbs[ch];
      if (!reverb) continue;
      const wetBlock = wetBlocks[ch];
      reverb.processInto(out[ch], wetBlock);
      // Interner Reverb-Mix = 1 (nur nass); der Dry-Anteil kommt hier dazu.
      for (let i = 0; i < len; i++) {
        const dry = out[ch][i];
        const s = dry * (1 - wet) + wetBlock[i] * wet;
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
    this.cfgChannels = -1;
    this.outputs[0].buffer = null;
  }
}
