import { expect, it } from 'vitest';
import { BackendMainResampler } from '../src/core/audio/backendMainResampler';

it('preserves DC after startup and is invariant to block boundaries', () => {
  const signal = Float32Array.from({ length: 4000 }, (_, i) => 0.4 + 0.2 * Math.sin(i * 0.06));
  const whole = new BackendMainResampler(48000, 96000).process([signal, signal], signal.length)[0];
  const split = new BackendMainResampler(48000, 96000);
  const chunks: number[] = [];
  for (let n = 0; n < signal.length; n += 137) { const part = signal.subarray(n, n + 137); chunks.push(...split.process([part, part], part.length)[0]); }
  expect(chunks).toEqual(Array.from(whole));
  const dc = new Float32Array(1000).fill(0.5);
  const output = new BackendMainResampler(48000, 96000).process([dc, dc], dc.length)[0];
  expect(Math.abs(output[500] - 0.5)).toBeLessThan(1e-6);
});
it('attenuates frequencies above the downsampled Nyquist limit', () => {
  const signal = Float32Array.from({ length: 5000 }, (_, i) => Math.sin(2 * Math.PI * 30000 * i / 96000));
  const output = new BackendMainResampler(96000, 48000).process([signal, signal], signal.length)[0];
  const samples = output.subarray(100); const rms = Math.sqrt(samples.reduce((sum, v) => sum + v * v, 0) / samples.length);
  expect(rms).toBeLessThan(0.01);
});

// Browser device rates can differ from the 96 kHz backend format.
it('converts a native 44.1 kHz source to the default backend rate', () => {
  const src = new BackendMainResampler(44100, 96000);
  const block = new Float32Array(4410).fill(.25);
  const out = src.process([block, block], block.length);
  expect(out[0].length).toBeGreaterThan(9400);
  expect(out[0].length).toBeLessThan(9600);
  expect(out[0][100]).toBeCloseTo(.25, 5);
});
