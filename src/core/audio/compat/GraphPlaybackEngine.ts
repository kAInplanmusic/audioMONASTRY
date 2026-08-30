/**
 * audioMONASTRY · V2 Playback Engine
 * ==================================
 * Voller Ersatzpfad für den V1-Transport: rendert Source → Worklet-Kette
 * blockweise über den AudioGraph und meldet Audio-Blöcke an den Backend-Adapter.
 */
import type { IProcessingContext } from '../types';

export type RenderBlockFn = (source: Float32Array[], ctx: IProcessingContext) => Float32Array[] | null;

export class GraphPlaybackEngine {
  playing = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private source: Float32Array[] = [new Float32Array(128)];
  private currentTime = 0;

  constructor(
    private renderBlock: RenderBlockFn,
    public sampleRate = 48000,
    public blockSize = 128,
  ) {}

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

  /** Verarbeitet genau einen Block (auch für Tests/Offline). */
  tick(): Float32Array[] | null {
    if (!this.playing) return null;
    const ctx = this.ctx;
    const out = this.renderBlock(this.source, ctx);
    this.currentTime += this.blockSize / this.sampleRate;
    this.onAudioBlock?.(out ?? [], this.currentTime);
    return out;
  }

  onAudioBlock: ((block: Float32Array[], time: number) => void) | null = null;

  start(): void {
    if (this.playing) return;
    this.playing = true;
    const ms = Math.max(1, Math.round((this.blockSize / this.sampleRate) * 1000));
    this.timer = setInterval(() => this.tick(), ms);
  }

  stop(): void {
    this.playing = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
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
