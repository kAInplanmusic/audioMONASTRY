import { describe, expect, it } from 'vitest';
import { BackendMainProcessors, type ProcessorSnapshot } from '../server/backendMainProcessors';

const on = (parameters: Record<string, unknown>) => ({ active: true, parameters, epoch: 1 });
const config: ProcessorSnapshot = {
  eq: on({ low: 18, mid: -12, high: 12 }), dsp: on({ cutoff: 250, resonance: 0.8, depth: 1, drive: 0.8, oversampling: 1 }),
  effect: on({ wet: 1, feedback: 0.6, rate: 1, depth: 0.8 }), spatial: on({ pan: 0.8, width: 0.3 }),
  mixer: on({ sources: { song: { gain: 0.4, sendEffect: 1, sendSpatial: 1 } } }), master: on({ gain: 0.4 }),
};
const source = (frames: number) => new Map([['song', Float32Array.from({ length: frames * 2 }, (_, i) => 0.2 * Math.sin(i * 0.13))]]);

describe('backend processor scratch storage', () => {
  it('keeps input and returned outputs independent while resizing and changing settings', () => {
    const p = new BackendMainProcessors(96000), first = source(128), inputCopy = [...first.get('song')!];
    const output = p.process(first, config), saved = [...output];
    const report = p.lastReport, reportCopy = JSON.stringify(report);
    p.process(source(37), config);
    p.process(first, { ...config, eq: on({ low: -12 }), master: on({ gain: 1 }) });
    expect([...first.get('song')!]).toEqual(inputCopy);
    expect([...output]).toEqual(saved);
    expect(JSON.stringify(report)).toEqual(reportCopy);
    expect(p.process(first, config)).not.toBe(output);
  });

  it('reuses warmed backend typed-array scratch for a bypass block', () => {
    const p = new BackendMainProcessors(96000), sources = source(128);
    p.process(sources, {});
    const original = globalThis.Float32Array;
    let allocations = 0;
    try {
      globalThis.Float32Array = new Proxy(original, { construct(target, args, newTarget) {
        allocations++; return Reflect.construct(target, args, newTarget);
      } });
      p.process(sources, {});
    } finally { globalThis.Float32Array = original; }
    // Only the public output is newly allocated for this warmed bypass block (or 0 with pre-allocated outputBuffer).
    expect(allocations).toBeLessThanOrEqual(1);
  });
});
