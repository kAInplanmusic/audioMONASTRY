/**
 * audioMONASTRY · V2SinkEngine
 * =============================
 * Backend-unabhängige Render-Engine für den V2-Live-Output-Sink (Phase 1).
 *
 * Sie kapselt eine V2StudioGraph-Instanz und erzeugt wahlweise einen
 * phasen-kontinuierlichen Testton auf channel1, der durch den kompletten
 * V2-Graph (Source → Gain → Pan → MasterSum) läuft. Der gerenderte Stereo-Block
 * kann anschließend im AudioWorklet direkt auf die AudioContext-Destination
 * geschrieben werden.
 *
 * Die Klasse enthält KEINE WebAudio-/AudioWorklet-API und ist damit sowohl im
 * AudioWorklet (über den v2SinkProcessor) als auch in Node-Tests nutzbar.
 */
import { V2StudioGraph, V2Channel, V2_CHANNELS } from '../V2StudioGraph';
import type { IProcessingContext } from '../types';

export interface V2SinkMessage {
  type: 'test-tone' | 'gain-db' | 'pan' | 'master-gain' | 'transport' | 'pattern';
  active?: boolean;
  freq?: number;
  amplitude?: number;
  channel?: V2Channel;
  db?: number;
  pan?: number;
  value?: number;
  playing?: boolean;
  bpm?: number;
  swing?: number;
  gate?: number;
  stepCount?: 16 | 32;
  steps?: boolean[];
}

/** Ein sample-genau getriggerter Step-Burst innerhalb eines Render-Blocks. */
export interface V2StepRenderEvent {
  track: V2Channel;
  /** Sample-Offset innerhalb des aktuellen Blocks (0..bufferSize-1). */
  startSample: number;
  /** Velocity 0..1 (Amplitude). */
  velocity: number;
  /** Grundfrequenz des Bursts in Hz. */
  freq: number;
}

const DEFAULT_TEST_FREQ = 440;
const DEFAULT_TEST_AMPLITUDE = 0.2;
const SILENCE_CHANNEL_COUNT = 1;
const STEP_DECAY_PER_SEC = 28; // schneller, nicht-zippernder Step-Burst

export class V2SinkEngine {
  readonly studio: V2StudioGraph;

  private testToneActive = false;
  private freq = DEFAULT_TEST_FREQ;
  private amplitude = DEFAULT_TEST_AMPLITUDE;
  private phase = 0;
  private currentTime = 0;
  private lastBlockSize = 0;
  /** Wiederverwendeter Stille-Buffer (keine Allokation im inaktiven Hot-Path). */
  private silenceBuffer = new Float32Array(0);

  constructor(sampleRate = 48000, blockSize = 128) {
    this.studio = new V2StudioGraph(sampleRate, blockSize);
    this.lastBlockSize = blockSize;
  }

  get isTestToneActive(): boolean {
    return this.testToneActive;
  }

  /** Schaltet den V2-Testton auf channel1 ein/aus. */
  setTestTone(active: boolean, freq = DEFAULT_TEST_FREQ, amplitude = DEFAULT_TEST_AMPLITUDE): void {
    this.testToneActive = active;
    if (active) {
      this.freq = Number.isFinite(freq) && freq > 0 ? Math.max(20, Math.min(20000, freq)) : DEFAULT_TEST_FREQ;
      this.amplitude = Number.isFinite(amplitude) ? Math.max(0, Math.min(0.9, amplitude)) : DEFAULT_TEST_AMPLITUDE;
    }
  }

  /** Setzt den Kanal-Gain in dB auf der V2-Graph-Instanz. */
  setChannelGainDb(channel: V2Channel, db: number): void {
    this.studio.setGainDb(channel, db);
  }

  /** Setzt das Stereo-Pan (-1..1) auf der V2-Graph-Instanz. */
  setChannelPan(channel: V2Channel, pan: number): void {
    this.studio.setPan(channel, pan);
  }

  /** Setzt den Master-Gain (linear, 0..2) auf der V2-Graph-Instanz. */
  setMasterGain(value: number): void {
    this.studio.setMasterGain(value);
  }

  /**
   * Rendert genau einen Audio-Block durch den V2-Graph.
   * `events` können sample-genaue Step-Bursts auf beliebigen Kanälen auslösen
   * (Phase 2). Liefert einen Stereo-Output (Float32Array[2]) – auch bei
   * inaktivem Testton (Stille), damit der Worklet-Output nie `null` ist.
   */
  render(ctx: IProcessingContext, events: V2StepRenderEvent[] = []): Float32Array[] {
    this.ensureSourceBlockSize(ctx.bufferSize);

    const usedChannels = new Set<V2Channel>();
    for (const event of events) {
      if (!event || event.startSample < 0 || event.startSample >= ctx.bufferSize) continue;
      const burst = this.renderStepBurst(event, ctx.bufferSize, ctx.sampleRate);
      this.studio.setSourceBuffer(event.track, [burst]);
      usedChannels.add(event.track);
    }

    if (!usedChannels.has('channel1')) {
      if (this.testToneActive) {
        const tone = this.renderToneBlock(ctx.bufferSize, ctx.sampleRate);
        this.studio.setSourceBuffer('channel1', [tone]);
        usedChannels.add('channel1');
      } else {
        // Immer Stille setzen, damit ein zuvor aktiver Testton/Step nicht weitertönt.
        this.studio.setSourceBuffer('channel1', [this.silenceBuffer]);
      }
    }

    // Alle nicht durch Step-Events belegten Kanäle auf Stille setzen, damit
    // keine alten Bursts aus früheren Blöcken nachklingen.
    for (const channel of V2_CHANNELS) {
      if (usedChannels.has(channel)) continue;
      this.studio.setSourceBuffer(channel, [this.silenceBuffer]);
    }

    const rendered = this.studio.render(ctx);
    this.currentTime += ctx.quantum;
    this.lastBlockSize = ctx.bufferSize;

    return rendered ?? [new Float32Array(ctx.bufferSize), new Float32Array(ctx.bufferSize)];
  }

  /** Setzt Engine und V2-Graph in den Ausgangszustand. */
  reset(): void {
    this.studio.reset();
    this.testToneActive = false;
    this.freq = DEFAULT_TEST_FREQ;
    this.amplitude = DEFAULT_TEST_AMPLITUDE;
    this.phase = 0;
    this.currentTime = 0;
  }

  private renderStepBurst(event: V2StepRenderEvent, length: number, sampleRate: number): Float32Array {
    const buffer = new Float32Array(length);
    const start = Math.max(0, Math.min(length - 1, event.startSample));
    const freq = Number.isFinite(event.freq) && event.freq > 0 ? Math.max(20, Math.min(20000, event.freq)) : DEFAULT_TEST_FREQ;
    const amp = Math.max(0, Math.min(1, event.velocity)) * 0.8;
    for (let i = start; i < length; i++) {
      const t = (i - start) / sampleRate;
      buffer[i] = Math.sin(2 * Math.PI * freq * t) * amp * Math.exp(-t * STEP_DECAY_PER_SEC);
    }
    return buffer;
  }

  private renderToneBlock(length: number, sampleRate: number): Float32Array {
    const buffer = new Float32Array(length);
    const dt = this.freq / sampleRate;
    for (let i = 0; i < length; i++) {
      buffer[i] = Math.sin(2 * Math.PI * this.phase) * this.amplitude;
      this.phase = (this.phase + dt) % 1;
    }
    return buffer;
  }

  /** Hält alle V2-Source-Buffer auf der aktuellen Blockgröße (Robustheit). */
  private ensureSourceBlockSize(length: number): void {
    if (this.silenceBuffer.length !== length) {
      this.silenceBuffer = new Float32Array(length);
    }
    if (this.lastBlockSize === length) return;
    for (const channel of V2_CHANNELS) {
      const source = this.studio.sources.get(channel);
      if (!source) continue;
      const current = source.sourceBuffer;
      if (!current || current[0]?.length !== length || current.length !== SILENCE_CHANNEL_COUNT) {
        this.studio.setSourceBuffer(channel, [this.silenceBuffer]);
      }
    }
    this.lastBlockSize = length;
  }
}
