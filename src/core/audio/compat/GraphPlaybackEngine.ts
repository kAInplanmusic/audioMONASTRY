/**
 * audioMONASTRY · V2 Playback Engine
 * ==================================
 * Rendert Source → Worklet-Kette blockweise über den AudioGraph.
 *
 * Phase 2: Der Live-Transport läuft NICHT mehr über `setInterval`. Der
 * sample-genaue Takt kommt aus dem AudioWorklet (`v2SinkProcessor` +
 * `V2SampleClock`); diese Engine ist der deterministische Offline-/Test-Renderer
 * und wird von außen Block für Block über `tick()` getrieben. `start()` setzt
 * nur den Transportzustand, es startet keinen Timer mehr.
 */
import type { IProcessingContext } from '../types';
import { V2_MASTERING_LOOKAHEAD_SEC, v2MasteringLookaheadSamples } from '../live/v2Pdc';

export type RenderBlockFn = (source: Float32Array[], ctx: IProcessingContext) => Float32Array[] | null;

export class GraphPlaybackEngine {
  playing = false;
  private source: Float32Array[] = [new Float32Array(128)];
  private currentTime = 0;

  constructor(
    private renderBlock: RenderBlockFn,
    public sampleRate = 48000,
    public blockSize = 128,
  ) {}

  /** Mastering-Lookahead in Sekunden (PDC-Bezug, identisch mit V1-Mastering). */
  readonly masteringLookaheadSec = V2_MASTERING_LOOKAHEAD_SEC;

  setSource(source: Float32Array[]): void {
    this.source = source;
  }

  get ctx(): IProcessingContext {
    return {
      sampleRate: this.sampleRate,
      bufferSize: this.blockSize,
      quantum: this.blockSize / this.sampleRate,
      currentTime: this.currentTime,
    };
  }

  /** Lookahead-Tiefe des V2-Masterings in Samples (PDC). */
  getLookaheadSamples(): number {
    return v2MasteringLookaheadSamples(this.sampleRate);
  }

  /**
   * Verarbeitet genau einen Block (auch für Tests/Offline).
   * Im Live-Betrieb wird `tick()` vom AudioWorklet-/Lookahead-Scheduler
   * getrieben – nicht von einem setInterval dieser Klasse.
   */
  tick(): Float32Array[] | null {
    if (!this.playing) return null;
    const ctx = this.ctx;
    const out = this.renderBlock(this.source, ctx);
    this.currentTime += this.blockSize / this.sampleRate;
    this.onAudioBlock?.(out ?? [], this.currentTime);
    return out;
  }

  onAudioBlock: ((block: Float32Array[], time: number) => void) | null = null;

  /** Aktiviert den Transport. Startet bewusst KEINEN Timer mehr. */
  start(): void {
    this.playing = true;
  }

  /** Deaktiviert den Transport und setzt die Zeit zurück. */
  stop(): void {
    this.playing = false;
    this.currentTime = 0;
  }

  /** Triggert einen kurzen Impuls (Sinus-Burst) über die Worklet-Kette. */
  trigger(velocity = 1): Float32Array[] | null {
    const sr = this.sampleRate;
    const len = this.blockSize;
    const source: Float32Array[] = [new Float32Array(len)];
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      source[0][i] = Math.sin(2 * Math.PI * 440 * t) * velocity * Math.exp(-t * 8);
    }
    this.setSource(source);
    this.playing = true;
    const out = this.renderBlock(this.source, this.ctx);
    this.playing = false;
    return out;
  }
}
