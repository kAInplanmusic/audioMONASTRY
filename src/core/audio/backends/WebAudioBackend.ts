import { AudioBuffer, AudioGraph } from '../AudioGraph';
import type { IAudioBuffer, IAudioGraph, IProcessingContext } from '../types';
import type { IAudioGraphBackend } from './types';

/**
 * WebAudio-Backend (Referenz).
 * Verdrahtet den Graph-Output mit der WebAudio-Destination (hörbarer Pfad).
 */
export class WebAudioBackend implements IAudioGraphBackend {
  readonly id = 'webaudio';
  readonly kind = 'webaudio' as const;

  private audioContext: AudioContext | null = null;

  get available(): boolean {
    return typeof AudioContext !== 'undefined';
  }

  async initialize(): Promise<void> {
    if (typeof AudioContext === 'undefined') return;
    if (!this.audioContext) this.audioContext = new AudioContext();
    await this.audioContext.resume();
  }

  createGraph(): IAudioGraph {
    return new AudioGraph();
  }

  createBuffer(sampleRate: number, length: number, channels: number): IAudioBuffer {
    return new AudioBuffer(sampleRate, length, channels);
  }

  /** Verarbeitet den Graph und spielt den letzten Output-Buffer hörbar ab. */
  async render(graph: IAudioGraph, ctx: IProcessingContext, output: IAudioBuffer): Promise<void> {
    graph.process(ctx);
    const last = graph.getLastOutput();
    if (!last) return;

    for (let ch = 0; ch < output.numberOfChannels; ch++) {
      const src = last[ch] ?? last[0];
      if (!src) continue;
      output.channelData[ch].set(src.subarray(0, Math.min(src.length, output.length)));
    }

    await this.playOutput(output);
  }

  /** Legt einen AudioBuffer auf die WebAudio-Destination (falls Browser-Kontext). */
  private async playOutput(buffer: IAudioBuffer): Promise<void> {
    if (typeof AudioContext === 'undefined') return;
    try {
      await this.initialize();
      const ctx = this.audioContext!;
      const audioBuffer = ctx.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
      for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
        audioBuffer.copyToChannel(buffer.channelData[ch], ch);
      }
      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(ctx.destination);
      source.start();
    } catch {
      // Kein hörbarer Output möglich (z.B. Node/jsdom) – Graph-Output bleibt im Buffer.
    }
  }

  async dispose(): Promise<void> {
    if (this.audioContext) {
      await this.audioContext.close();
      this.audioContext = null;
    }
  }
}
