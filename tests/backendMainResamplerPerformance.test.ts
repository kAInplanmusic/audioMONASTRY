
import { expect, it } from 'vitest';
import { BackendMainResampler } from '../src/core/audio/backendMainResampler';

// Independent pre-optimization scalar implementation, including streaming state.
/** Stateful stereo windowed-sinc sample-rate conversion. Holds 32 source frames of lookahead. */
class ScalarReference {
  private channels: number[][] = [[], []];
  private base = 0;
  private total = 0;
  private outputIndex = 0;
  private readonly cutoff: number;
  constructor(readonly inputRate: number, readonly outputRate: number) {
    if (!Number.isInteger(inputRate) || !Number.isInteger(outputRate) || inputRate <= 0 || outputRate <= 0) throw new Error('Invalid resampling rate');
    this.cutoff = 0.94 * Math.min(1, outputRate / inputRate);
  }
  process(input: readonly Float32Array[], frames: number): [Float32Array, Float32Array] {
    if (input.length !== 2 || !Number.isSafeInteger(frames) || frames < 0 || input.some(c => c.length < frames)) throw new Error('Invalid resampler input');
    for (let i = 0; i < frames; i++) for (let c = 0; c < 2; c++) {
      if (!Number.isFinite(input[c][i])) throw new Error('Non-finite Main audio sample');
      this.channels[c].push(input[c][i]);
    }
    this.total += frames;
    const output: number[][] = [[], []];
    while (Math.floor(this.outputIndex * this.inputRate / this.outputRate) + 32 < this.total) {
      const position = this.outputIndex * this.inputRate / this.outputRate;
      const center = Math.floor(position);
      let weightSum = 0, left = 0, right = 0;
      for (let offset = -31; offset <= 32; offset++) {
        const index = center + offset, distance = position - index;
        const x = Math.PI * this.cutoff * distance;
        const sinc = x === 0 ? 1 : Math.sin(x) / x;
        const window = 0.5 + 0.5 * Math.cos(Math.PI * distance / 32);
        const weight = this.cutoff * sinc * window;
        weightSum += weight;
        if (index >= 0) { left += (this.channels[0][index - this.base] ?? 0) * weight; right += (this.channels[1][index - this.base] ?? 0) * weight; }
      }
      output[0].push(left / weightSum); output[1].push(right / weightSum); this.outputIndex++;
    }
    const retainFrom = Math.max(0, Math.floor(this.outputIndex * this.inputRate / this.outputRate) - 31);
    const discard = Math.min(this.total, retainFrom) - this.base;
    if (discard > 0) { this.channels[0].splice(0, discard); this.channels[1].splice(0, discard); this.base += discard; }
    return [Float32Array.from(output[0]), Float32Array.from(output[1])];
  }
}


function compare(inputRate: number, outputRate: number, length: number, split: number) {
  const actual = new BackendMainResampler(inputRate, outputRate);
  const reference = new ScalarReference(inputRate, outputRate);
  let seed = 0x12345678, maxError = 0, samples = 0;
  for (let start = 0; start < length; start += split) {
    const count = Math.min(split, length - start);
    const left = new Float32Array(count), right = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const t = (start + i) / length;
      left[i] = 0.7 * Math.sin(Math.PI * (start + i) * (0.01 + 0.48 * t));
      right[i] = (seed / 0xffffffff * 2 - 1) * 0.8;
    }
    const got = actual.process([left, right], count);
    const expected = reference.process([left, right], count);
    expect(got[0].length).toBe(expected[0].length);
    expect(got[1].length).toBe(expected[1].length);
    for (let channel = 0; channel < 2; channel++) for (let i = 0; i < got[channel].length; i++) {
      maxError = Math.max(maxError, Math.abs(got[channel][i] - expected[channel][i]));
      samples++;
    }
  }
  // Each result is rounded to Float32; 1e-7 permits about one float ULP near unity.
  console.info(`Scalar parity ${inputRate}->${outputRate}: ${samples} channel samples, max absolute error ${maxError}`);
  expect(maxError, `${inputRate}->${outputRate}, max absolute error`).toBeLessThanOrEqual(1e-7);
  expect(samples).toBeGreaterThan(0);
}

it('matches the original filter for random stereo and swept frequencies across rates', () => {
  for (const inputRate of [44100, 48000, 96000, 192000])
    for (const outputRate of [44100, 48000, 96000, 192000]) compare(inputRate, outputRate, 4096, 137);
});

it('keeps fractional phases aligned over a long split stream', () => compare(44100, 96000, 200000, 997));
it('uses bounded fallback for a large phase cycle', () => compare(44101, 96000, 2048, 127));
it('reuses the fallback coefficient buffer across output frames and blocks', () => {
  const resampler = new BackendMainResampler(44101, 96000);
  const internals = resampler as unknown as { fallback: { weights: Float64Array }; phases: Map<number, unknown> };
  const scratch = internals.fallback.weights;
  const block = new Float32Array(128).fill(0.25);
  resampler.process([block, block], block.length); // Warm the fallback.
  const NativeFloat64Array = globalThis.Float64Array;
  let allocations = 0;
  globalThis.Float64Array = new Proxy(NativeFloat64Array, { construct(target, args, newTarget) {
    if (args[0] === 64) allocations++;
    return Reflect.construct(target, args, newTarget);
  } });
  try {
    for (let i = 0; i < 3; i++) resampler.process([block, block], block.length);
  } finally { globalThis.Float64Array = NativeFloat64Array; }
  expect(allocations).toBe(0);
  expect(internals.fallback.weights).toBe(scratch);
  expect(internals.phases.size).toBe(0);
});
it('rejects non-finite input', () => {
  expect(() => new BackendMainResampler(44100, 96000).process([new Float32Array([NaN]), new Float32Array(1)], 1)).toThrow('Non-finite Main audio sample');
});
