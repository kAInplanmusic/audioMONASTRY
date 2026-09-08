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
  type: 'test-tone' | 'gain-db' | 'pan' | 'master-gain' | 'transport' | 'pattern'
    | 'sample-set' | 'sample-trigger' | 'sample-stop' | 'synth-source';
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
  left?: Float32Array;
  right?: Float32Array | null;
  sourceRate?: number;
  loop?: boolean;
  rate?: number;
  offset?: number;
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

/** Optionen für einen V2-Sample-Trigger (Phase 3). */
export interface V2SampleTriggerOptions {
  loop?: boolean;
  /** Playback-Rate (1 = Originaltempo). */
  rate?: number;
  /** Start-Offset in Sekunden. */
  offset?: number;
}

interface V2LoadedSample {
  left: Float32Array;
  right?: Float32Array;
  sourceRate: number;
}

interface V2SamplePlaybackState extends V2LoadedSample {
  playing: boolean;
  loop: boolean;
  rate: number;
  /** Leseposition in Source-Samples. */
  position: number;
}

/** Konfigurierbare Synthese-/Step-Quelle je Kanal (Synth-Source-Registry). */
export interface V2SynthSourceConfig {
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
  /** Hochgeladene Sample-Quellen je Kanal (Phase 3). */
  private readonly sampleBuffers = new Map<V2Channel, V2LoadedSample>();
  /** Aktive Sample-Playback-Zustände je Kanal. */
  private readonly samplePlayback = new Map<V2Channel, V2SamplePlaybackState>();
  /** Synth-/Step-Quellen je Kanal (Phase 3, V2-Source-Registry). */
  private readonly synthSources = new Map<V2Channel, V2SynthSourceConfig>();

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

  /** Registriert eine Sample-Quelle für einen Kanal (Phase 3). */
  setSampleBuffer(channel: V2Channel, left: Float32Array, right?: Float32Array | null, sourceRate = 48000): void {
    if (!left) return;
    this.stopSample(channel);
    this.sampleBuffers.set(channel, {
      left,
      right: right ?? undefined,
      sourceRate: Math.max(8000, Math.min(192000, sourceRate)),
    });
  }

  /** Entfernt die Sample-Quelle eines Kanals. */
  clearSampleBuffer(channel: V2Channel): void {
    this.stopSample(channel);
    this.sampleBuffers.delete(channel);
  }

  /** Hat der Kanal eine Sample-Quelle? */
  hasSample(channel: V2Channel): boolean {
    return this.sampleBuffers.has(channel);
  }

  /** Startet die Sample-Wiedergabe eines Kanals (retrigger-fähig). */
  triggerSample(channel: V2Channel, options: V2SampleTriggerOptions = {}): boolean {
    const sample = this.sampleBuffers.get(channel);
    if (!sample) return false;
    const offsetSec = Math.max(0, options.offset ?? 0);
    const position = Math.min(sample.left.length - 1, Math.round(offsetSec * sample.sourceRate));
    this.samplePlayback.set(channel, {
      ...sample,
      playing: true,
      loop: Boolean(options.loop),
      rate: Math.max(0.25, Math.min(4, options.rate ?? 1)),
      position,
    });
    return true;
  }

  /** Stoppt die Sample-Wiedergabe eines Kanals. */
  stopSample(channel: V2Channel): void {
    const state = this.samplePlayback.get(channel);
    if (state) state.playing = false;
  }

  /** Läuft auf dem Kanal gerade eine Sample-Wiedergabe? */
  isSamplePlaying(channel: V2Channel): boolean {
    return this.samplePlayback.get(channel)?.playing === true;
  }

  /** Registriert eine Synth-/Step-Quelle für einen Kanal (Source-Registry). */
  setSynthSource(channel: V2Channel, config: V2SynthSourceConfig): void {
    if (config && Number.isFinite(config.freq) && config.freq > 0) {
      this.synthSources.set(channel, { freq: Math.max(20, Math.min(20000, config.freq)) });
    }
  }

  /** Liefert die registrierte Synth-Quelle (fallback Standard-Frequenz). */
  getSynthSource(channel: V2Channel): V2SynthSourceConfig {
    return this.synthSources.get(channel) ?? { freq: DEFAULT_TEST_FREQ };
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

    // Phase 3: laufende Sample-Quellen zuerst rendern (Sample-Player als V2-Source).
    for (const channel of V2_CHANNELS) {
      const state = this.samplePlayback.get(channel);
      if (!state?.playing) continue;
      const block = this.renderSampleBlock(state, ctx.bufferSize, ctx.sampleRate);
      this.studio.setSourceBuffer(channel, block);
      usedChannels.add(channel);
    }

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
    this.samplePlayback.clear();
    this.sampleBuffers.clear();
    this.synthSources.clear();
  }

  /** Rendert den nächsten Block einer laufenden Sample-Quelle. */
  private renderSampleBlock(state: V2SamplePlaybackState, length: number, ctxSampleRate: number): Float32Array[] {
    const outL = new Float32Array(length);
    const outR = state.right ? new Float32Array(length) : null;
    const advance = state.rate * (state.sourceRate / ctxSampleRate);
    let ended = false;

    for (let i = 0; i < length; i++) {
      let idx = Math.floor(state.position);
      if (idx >= state.left.length) {
        if (!state.loop) {
          ended = true;
          break;
        }
        state.position %= state.left.length;
        idx = Math.floor(state.position);
      }
      outL[i] = state.left[idx] ?? 0;
      if (outR) outR[i] = state.right?.[idx] ?? state.left[idx] ?? 0;
      state.position += advance;
    }

    if (!ended && !state.loop && state.position >= state.left.length) ended = true;
    if (ended) state.playing = false;
    return outR ? [outL, outR] : [outL];
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
