import { describe, expect, it } from 'vitest';
import { V2SinkEngine } from '../src/core/audio/live/V2SinkEngine';
import type { IProcessingContext } from '../src/core/audio/types';

const N = 128;
const ctx: IProcessingContext = { sampleRate: 48000, bufferSize: N, quantum: N / 48000, currentTime: 0 };

function compareBlocks(actual: Float32Array[], expected: Float32Array[]) {
  expect(actual.length).toBe(expected.length);
  for (let channel = 0; channel < actual.length; channel++) {
    for (let i = 0; i < N; i++) {
      expect(actual[channel][i], `channel ${channel}, sample ${i}`).toBeCloseTo(expected[channel][i], 6);
    }
  }
}

describe('V2 source contention', () => {
  it.each([
    { sampleStereo: false, externalStereo: false },
    { sampleStereo: true, externalStereo: false },
    { sampleStereo: false, externalStereo: true },
    { sampleStereo: true, externalStereo: true },
  ])('mixes sample, external and synth exactly once ($sampleStereo/$externalStereo)', ({ sampleStereo, externalStereo }) => {
    const engine = new V2SinkEngine(48000, N);
    const reference = new V2SinkEngine(48000, N);
    engine.setChannelGainDb('channel5', -9);
    reference.setChannelGainDb('channel5', -9);
    const sL = Float32Array.from({ length: N }, (_, i) => 0.013 * Math.sin(i / 6));
    const sR = Float32Array.from({ length: N }, (_, i) => 0.017 * Math.cos(i / 7));
    const eL = Float32Array.from({ length: N }, (_, i) => 0.011 * Math.cos(i / 9));
    const eR = Float32Array.from({ length: N }, (_, i) => 0.019 * Math.sin(i / 10));
    const rL = Float32Array.from(sL, (v, i) => v + eL[i]);
    const rR = Float32Array.from(sL, (v, i) => (sampleStereo ? sR[i] : v) + (externalStereo ? eR[i] : eL[i]));
    engine.setSampleBuffer('channel5', sL, sampleStereo ? sR : null, 48000);
    engine.triggerSample('channel5');
    engine.setExternalSource('channel5', externalStereo ? [eL, eR] : [eL]);
    reference.setSampleBuffer('channel5', rL, rR, 48000);
    reference.triggerSample('channel5');
    const event = [{ track: 'channel5' as const, startSample: 23, velocity: 0.4, freq: 330 }];
    let peak = 0;
    for (let b = 0; b < 5; b++) {
      const actual = engine.render(ctx, b === 0 ? event : undefined);
      const expected = reference.render(ctx, b === 0 ? event : undefined);
      compareBlocks(actual, expected);
      for (const channel of actual) for (const value of channel) peak = Math.max(peak, Math.abs(value));
    }
    expect(peak).toBeGreaterThan(0.001);
  });

  it('advances sample timing while muted instead of replaying stale audio after unmute', () => {
    const engine = new V2SinkEngine(48000, N);
    const sample = new Float32Array(N).fill(0.05);
    engine.setSampleBuffer('channel5', sample, null, 48000);
    engine.setChannelMuted('channel5', true);
    engine.triggerSample('channel5', { startSample: 31 });
    engine.setExternalSource('channel5', [new Float32Array(N).fill(0.03)]);
    engine.render(ctx);
    engine.render(ctx);
    expect(engine.isSamplePlaying('channel5')).toBe(false);
    engine.setChannelMuted('channel5', false);
    for (let b = 0; b < 5; b++) {
      const output = engine.render(ctx);
      for (const channel of output) for (const value of channel) expect(value).toBe(0);
    }
  });

  it('preserves stereo external audio when a synth voice shares the channel', () => {
    const engine = new V2SinkEngine(48000, N);
    const reference = new V2SinkEngine(48000, N);
    const left = Float32Array.from({ length: N }, (_, i) => 0.02 * Math.sin(i / 8));
    const right = Float32Array.from({ length: N }, (_, i) => 0.03 * Math.cos(i / 11));
    const originalL = left.slice();
    const originalR = right.slice();
    engine.setExternalSource('channel5', [left, right]);
    reference.setSampleBuffer('channel5', left.slice(), right.slice(), 48000);
    reference.triggerSample('channel5');
    const event = [{ track: 'channel5' as const, startSample: 19, velocity: 0.4, freq: 330 }];
    for (let b = 0; b < 5; b++) {
      compareBlocks(engine.render(ctx, b === 0 ? event : undefined), reference.render(ctx, b === 0 ? event : undefined));
    }
    expect(left).toEqual(originalL);
    expect(right).toEqual(originalR);
  });

  it('mixes an external stereo block and a sample at its scheduled offset without delaying playback', () => {
    const engine = new V2SinkEngine(48000, N);
    const reference = new V2SinkEngine(48000, N);
    engine.setChannelGainDb('channel5', -6);
    reference.setChannelGainDb('channel5', -6);
    const sampleL = Float32Array.from({ length: 200 }, (_, i) => 0.025 + (i % 7) * 0.002);
    const sampleR = Float32Array.from({ length: 200 }, (_, i) => -0.015 - (i % 5) * 0.003);
    const externalL = Float32Array.from({ length: N }, (_, i) => (i % 9) * 0.004);
    const externalR = Float32Array.from({ length: N }, (_, i) => -(i % 11) * 0.003);
    const originalL = externalL.slice();
    const originalR = externalR.slice();
    const mixedL = new Float32Array(N * 3);
    const mixedR = new Float32Array(N * 3);
    mixedL.set(externalL); mixedR.set(externalR);
    for (let i = 0; i < sampleL.length; i++) {
      mixedL[37 + i] += sampleL[i];
      mixedR[37 + i] += sampleR[i];
    }
    engine.setSampleBuffer('channel5', sampleL, sampleR, 48000);
    engine.triggerSample('channel5', { startSample: 37 });
    engine.setExternalSource('channel5', [externalL, externalR]);
    reference.setSampleBuffer('channel5', mixedL, mixedR, 48000);
    reference.triggerSample('channel5');
    for (let b = 0; b < 6; b++) {
      compareBlocks(engine.render(ctx), reference.render(ctx));
      if (b === 1) expect(engine.isSamplePlaying('channel5')).toBe(false);
    }
    expect(externalL).toEqual(originalL);
    expect(externalR).toEqual(originalR);
  });
});
