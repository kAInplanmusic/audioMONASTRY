import type { PluginAudioBlock } from '../../plugins/plugin_interface';
import type { V2Channel } from './V2StudioGraph';

const CHANNELS = 8, CAPACITY = 32768, WORDS = 4;
const HEADER_BYTES = CHANNELS * WORDS * 4;
/** One bounded SPSC lane per existing V2 source. No monitor/bus signal is captured. */
export class BackendMainSourceRing {
  readonly buffer: SharedArrayBuffer;
  private readonly header: Int32Array;
  private readonly samples: Float32Array;
  constructor(buffer = new SharedArrayBuffer(HEADER_BYTES + CHANNELS * CAPACITY * 2 * 4)) {
    if (buffer.byteLength !== HEADER_BYTES + CHANNELS * CAPACITY * 2 * 4) throw new Error('Invalid source ring');
    this.buffer = buffer;
    this.header = new Int32Array(buffer, 0, CHANNELS * WORDS);
    this.samples = new Float32Array(buffer, HEADER_BYTES);
  }
  enable(channel: V2Channel, enabled: boolean): void {
    const h = (Number(channel.slice(7)) - 1) * WORDS;
    Atomics.store(this.header, h, 0);
    if (enabled) {
      Atomics.store(this.header, h + 2, Atomics.load(this.header, h + 1));
      Atomics.store(this.header, h + 3, 0);
      Atomics.store(this.header, h, 1);
    }
  }
  /** Called only by the worklet; no allocation, networking or source mutation. */
  write(index: number, block: Float32Array[] | undefined, frames: number): void {
    const h = index * WORDS;
    if (!Atomics.load(this.header, h)) return;
    const write = Atomics.load(this.header, h + 1) >>> 0;
    const read = Atomics.load(this.header, h + 2) >>> 0;
    if (((write - read) >>> 0) + frames > CAPACITY) {
      Atomics.add(this.header, h + 3, 1); Atomics.store(this.header, h, 0); return;
    }
    const base = index * CAPACITY * 2;
    const left = block?.[0], right = block?.[1] ?? left;
    for (let i = 0; i < frames; i++) {
      const at = base + ((write + i) % CAPACITY) * 2;
      this.samples[at] = left?.[i] ?? 0;
      this.samples[at + 1] = right?.[i] ?? 0;
    }
    Atomics.store(this.header, h + 1, (write + frames) | 0);
  }
  /** Main-thread allocation is outside DSP. Overflow is an explicit failure, never a hidden drop. */
  read(channel: V2Channel, sampleRate: number): PluginAudioBlock | null {
    const index = Number(channel.slice(7)) - 1, h = index * WORDS;
    if (Atomics.load(this.header, h + 3)) throw new Error('Backend Main source capture overflow');
    const read = Atomics.load(this.header, h + 2) >>> 0;
    const write = Atomics.load(this.header, h + 1) >>> 0;
    const available = (write - read) >>> 0;
    const count = Math.min(available, Math.floor(sampleRate / 20));
    if (!count) return null;
    if (available > CAPACITY) throw new Error('Invalid source capture cursor');
    const left = new Float32Array(count), right = new Float32Array(count), base = index * CAPACITY * 2;
    for (let i = 0; i < count; i++) {
      const at = base + ((read + i) % CAPACITY) * 2;
      left[i] = this.samples[at]; right[i] = this.samples[at + 1];
    }
    Atomics.store(this.header, h + 2, (read + count) | 0);
    return { channels: [left, right], frameCount: count, sampleRate, timestamp: read / sampleRate };
  }
}
