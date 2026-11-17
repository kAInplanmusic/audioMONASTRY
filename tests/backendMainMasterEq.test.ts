import { describe, expect, it } from 'vitest';
import { BackendMainProcessors, MASTER_EQ_BANDS } from '../server/backendMainProcessors';

const SR = 48000;
const tone = (hz: number, seconds = 0.25, amp = 0.25) => {
  const frames = Math.round(SR * seconds);
  const interleaved = new Float32Array(frames * 2);
  for (let f = 0; f < frames; f++) {
    const v = Math.sin((2 * Math.PI * hz * f) / SR) * amp;
    interleaved[2 * f] = v;
    interleaved[2 * f + 1] = v;
  }
  return new Map([['song', interleaved]]);
};
const peak = (block: Float32Array) => {
  let max = 0;
  for (const v of block) if (Math.abs(v) > max) max = Math.abs(v);
  return max;
};
const masterOn = (parameters: Record<string, unknown>) => ({ master: { active: true, parameters, epoch: 1 } });

describe('R16 master 12-band EQ in the backend sum', () => {
  it('publishes exactly twelve bands in ascending frequency order', () => {
    expect(MASTER_EQ_BANDS).toHaveLength(12);
    const freqs = MASTER_EQ_BANDS.map((b) => b.freq);
    expect([...freqs].sort((a, b) => a - b)).toEqual(freqs);
    expect(new Set(freqs).size).toBe(12);
  });

  it('is a transparent bypass while the master module is off', () => {
    const input = tone(1000);
    const dry = [...input.get('song')!];
    const out = new BackendMainProcessors(SR).process(input, { master: { active: false, parameters: { bands: Array(12).fill(18) }, epoch: 1 } });
    expect([...out]).toEqual(dry);
  });

  it('is neutral when every band gain is zero', () => {
    const input = tone(1000);
    const dry = [...input.get('song')!];
    const out = new BackendMainProcessors(SR).process(input, masterOn({ gain: 1, bands: Array(12).fill(0) }));
    for (let i = 0; i < dry.length; i++) expect(out[i]).toBeCloseTo(dry[i], 6);
  });

  it('boosts the addressed low band and leaves a distant band untouched', () => {
    const low = tone(40);
    const high = tone(8000);
    const bands = Array(12).fill(0); bands[0] = 12;
    const lowOut = new BackendMainProcessors(SR).process(low, masterOn({ gain: 1, bands }));
    const highOut = new BackendMainProcessors(SR).process(high, masterOn({ gain: 1, bands }));
    const lowDry = new BackendMainProcessors(SR).process(tone(40), {});
    const highDry = new BackendMainProcessors(SR).process(tone(8000), {});
    // settle past the 5 ms activation ramp
    const tail = (a: Float32Array) => peak(a.subarray(a.length - 4096));
    expect(tail(lowOut)).toBeGreaterThan(tail(lowDry) * 2);
    expect(tail(highOut)).toBeCloseTo(tail(highDry), 2);
  });

  it('applies every one of the twelve bands independently', () => {
    for (let band = 0; band < MASTER_EQ_BANDS.length; band++) {
      const spec = MASTER_EQ_BANDS[band];
      const bands = Array(12).fill(0); bands[band] = 12;
      const wet = new BackendMainProcessors(SR).process(tone(spec.freq, 0.5), masterOn({ gain: 1, bands }));
      const dry = new BackendMainProcessors(SR).process(tone(spec.freq, 0.5), {});
      const tail = (a: Float32Array) => peak(a.subarray(a.length - 4096));
      expect(tail(wet)).toBeGreaterThan(tail(dry) * 1.15);
    }
  });

  it('ramps activation over five milliseconds instead of jumping', () => {
    const input = tone(1000, 0.12);
    const bands = Array(12).fill(0); bands[5] = 18;
    const processor = new BackendMainProcessors(SR);
    processor.process(input, { master: { active: false, parameters: {}, epoch: 1 } });
    const out = processor.process(input, masterOn({ gain: 1, bands }));
    const dry = input.get('song')!;
    const rmsRatio = (from: number, to: number) => {
      let wet = 0; let ref = 0;
      for (let f = from; f < to; f++) { wet += out[2 * f] ** 2; ref += dry[2 * f] ** 2; }
      return Math.sqrt(wet / Math.max(ref, 1e-12));
    };
    // the ramp starts at zero wet, so the very first frame is still the dry sample
    expect(out[0]).toBeCloseTo(dry[0], 9);
    expect(rmsRatio(0, 120)).toBeLessThan(rmsRatio(2400, 4800));
    expect(rmsRatio(2400, 4800)).toBeGreaterThan(2);
  });

  it('keeps the master gain behind the EQ and stays finite for extreme sends', () => {
    const input = tone(1000);
    const loud = new BackendMainProcessors(SR).process(input, masterOn({ gain: 2, bands: Array(12).fill(24) }));
    expect(loud.every((v) => Number.isFinite(v))).toBe(true);
    const half = new BackendMainProcessors(SR).process(tone(1000), masterOn({ gain: 0.5, bands: Array(12).fill(0) }));
    const unity = new BackendMainProcessors(SR).process(tone(1000), {});
    expect(peak(half.subarray(half.length - 4096))).toBeCloseTo(peak(unity.subarray(unity.length - 4096)) * 0.5, 2);
  });
});
