import { Buffer } from 'node:buffer';
import { AudioBuffer, AudioGraph } from '../AudioGraph';
import type { IAudioBuffer, IAudioGraph, IProcessingContext } from '../types';
import { NativeRuntimeClient } from '../runtime/NativeRuntimeClient';
import { NativeRuntimeSpawner } from '../runtime/NativeRuntimeSpawner';
import { RuntimeProcessManager } from '../runtime/RuntimeProcessManager';
import type { IAudioGraphBackend } from './types';

/**
 * Native-Backend (Phase 2): spricht per IPC mit dem kompilierten
 * audioMONASTRY-runtime Prozess (Rust).
 */
export class NativeBackend implements IAudioGraphBackend {
  readonly id = 'native';
  readonly kind = 'native' as const;

  private manager = new RuntimeProcessManager();
  private spawner = new NativeRuntimeSpawner();
  private client: NativeRuntimeClient | null = null;

  get available(): boolean {
    return this.spawner.available;
  }

  async initialize(): Promise<void> {
    if (this.client) return;
    const process = await this.manager.start(this.spawner);
    const transport = (process as unknown as { transport?: NativeRuntimeClient['transport'] }).transport;
    if (!transport) return;
    this.client = new NativeRuntimeClient(transport);
    this.client.connect();
  }

  async listDevices(): Promise<{ devices: unknown[] }> {
    await this.initialize();
    if (this.client) return this.client.listDevices();
    return { devices: [] };
  }

  createGraph(): IAudioGraph {
    return new AudioGraph();
  }

  createBuffer(sampleRate: number, length: number, channels: number): IAudioBuffer {
    return new AudioBuffer(sampleRate, length, channels);
  }

  async render(graph: IAudioGraph, ctx: IProcessingContext, output: IAudioBuffer): Promise<void> {
    graph.process(ctx);
    const last = graph.getLastOutput();
    if (!last) return;

    if (await this.renderViaNative(last, ctx, output)) return;
    this.copyGraphOutput(last, output);
  }

  /** Echter V2-Pfad: Graph-Output durch die Rust-Mastering-Kette (EQ/Drive/Ceiling). */
  private async renderViaNative(last: Float32Array[], ctx: IProcessingContext, output: IAudioBuffer): Promise<boolean> {
    if (!this.client || !last[0]) return false;
    const channels = Math.min(2, last.length);
    const interleaved = this.interleave(last, channels);
    const processed = await this.processGraphDsp(interleaved, {
      gain: 1,
      drive: 1,
      ceiling: 1,
      sample_rate: ctx.sampleRate,
      channels,
    });
    if (!processed) return false;

    const len = Math.min(processed.length, output.length);
    if (channels === 2) {
      for (let i = 0; i < len; i++) {
        output.channelData[0][i] = processed[i * 2] ?? 0;
        output.channelData[1][i] = processed[i * 2 + 1] ?? 0;
      }
    } else {
      output.channelData[0].set(processed.subarray(0, len));
    }
    return true;
  }

  /** Interleaved Stereo (bzw. Mono-Durchreichung) für die Runtime-IPC. */
  private interleave(last: Float32Array[], channels: number): Float32Array {
    if (channels === 2 && last[1]) {
      const len = Math.min(last[0].length, last[1].length);
      const interleaved = new Float32Array(len * 2);
      for (let i = 0; i < len; i++) {
        interleaved[i * 2] = last[0][i];
        interleaved[i * 2 + 1] = last[1][i];
      }
      return interleaved;
    }
    return last[0];
  }

  /** Fallback ohne Runtime: Graph-Output direkt übernehmen. */
  private copyGraphOutput(last: Float32Array[], output: IAudioBuffer): void {
    for (let ch = 0; ch < output.numberOfChannels; ch++) {
      const src = last[ch] ?? last[0];
      if (src) output.channelData[ch].set(src.subarray(0, Math.min(src.length, output.length)));
    }
  }

  /** Echte DSP-Verarbeitung über die Rust-Runtime (3-Band-EQ + Drive + Ceiling). */
  async processGraphDsp(
    input: Float32Array,
    options: { gain?: number; drive?: number; ceiling?: number; eq_low_db?: number; eq_mid_db?: number; eq_high_db?: number; sample_rate?: number; channels?: number } = {},
  ): Promise<Float32Array | null> {
    await this.initialize();
    if (!this.client) return null;

    const inBase64 = Buffer.from(input.buffer, input.byteOffset, input.byteLength).toString('base64');
    const res = await this.client.processGraph({
      input_base64: inBase64,
      gain: options.gain ?? 1,
      drive: options.drive ?? 1,
      ceiling: options.ceiling ?? 1,
      eq_low_db: options.eq_low_db ?? 0,
      eq_mid_db: options.eq_mid_db ?? 0,
      eq_high_db: options.eq_high_db ?? 0,
      sample_rate: options.sample_rate ?? 48000,
      channels: options.channels ?? 1,
    });
    const outBytes = Buffer.from(res.output_base64, 'base64');
    return new Float32Array(outBytes.buffer, outBytes.byteOffset, outBytes.byteLength / 4);
  }

  async dispose(): Promise<void> {
    this.client?.disconnect();
    this.client = null;
    await this.manager.stop();
  }
}
