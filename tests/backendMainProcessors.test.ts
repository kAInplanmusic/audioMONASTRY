import { describe, expect, it } from 'vitest';
import { AudioPort } from '../src/core/audio/AudioGraph';
import { EffectNode } from '../src/core/audio/nodes/processingNodes';
import { BackendMainProcessors, type ProcessorSnapshot } from '../server/backendMainProcessors';

const on = (parameters: Record<string, unknown> = {}, epoch = 1) => ({ active: true, parameters, epoch });
const source = (values: number[]) => new Map([['song', Float32Array.from(values)]]);
const mix = (params: Record<string, unknown>): ProcessorSnapshot => ({ mixer: on({ sources: { song: params } }) });

describe('backend main processors', () => {
  it('preserves headroom and applies source gain, pan, mute and master gain', () => {
    const processor = new BackendMainProcessors(48000);
    expect([...processor.process(source([1, 1]), {})]).toEqual([1, 1]);
    expect([...new BackendMainProcessors(48000).process(source([1, 1]), { ...mix({ gain: 2, pan: 0.5 }), master: on({ gain: 1.5 }) })]).toEqual([1.5, 3]);
    expect([...new BackendMainProcessors(48000).process(source([1, 1]), mix({ mute: true }))]).toEqual([0, 0]);
    expect(processor.lastReport.sourceIds).toEqual(['song']);
    expect(new BackendMainProcessors(48000).process(source([1, 1]), { master: on({ masterVolumeDb: -6 }) })[0]).toBeCloseTo(10 ** (-6 / 20));
  });

  it('changes frequency response with EQ and signal with DSP, respecting targets', () => {
    const input = Array.from({ length: 2048 }, (_, i) => Math.sin(2 * Math.PI * 1000 * Math.floor(i / 2) / 48000) * 0.3);
    const dry = new BackendMainProcessors(48000).process(source(input), {});
    const boosted = new BackendMainProcessors(48000).process(source(input), { eq: on({ mid: 12 }) });
    const excluded = new BackendMainProcessors(48000).process(source(input), { eq: on({ mid: 12, targets: ['voice'] }) });
    const filtered = new BackendMainProcessors(48000).process(source(input), { dsp: on({ depth: 1, cutoff: 100, drive: 0 }) });
    expect(boosted[1500]).not.toBeCloseTo(dry[1500], 2);
    expect([...excluded]).toEqual([...dry]);
    expect(filtered[1500]).not.toBeCloseTo(dry[1500], 2);
  });

  it('aligns spatial dry and return at the impulse sample', () => {
    const input = [0, 0, 0.5, 0.25, 0, 0];
    const out = new BackendMainProcessors(48000).process(source(input), { ...mix({ sendSpatial: 1 }), spatial: on({ pan: 1 }) });
    expect([...out]).toEqual([0, 0, 0, 0.25, 0, 0]);
  });

  it('aligns the nonlinear effect return and nulls against one direct EffectNode processing of the send', () => {
    const values = [0, 0, 0.37, -0.21, 0.13, 0.41, 0.24, -0.35, 0, 0];
    const params = { wet: 0.7, feedback: 0.2, rate: 0.5, depth: 0.5, bits: 3, sampleReduction: 1 };
    const output = new BackendMainProcessors(48000).process(source(values), { ...mix({ sendEffect: 1 }), effect: on(params) });
    const node = new EffectNode('reference');
    for (const [key, value] of Object.entries(params)) node.getParameter(key)?.setValue(value);
    const port = new AudioPort(node, 'output', 'reference-input');
    port.buffer = [Float32Array.from(values.filter((_, i) => i % 2 === 0)), Float32Array.from(values.filter((_, i) => i % 2 === 1))];
    node.inputs[0].connections[0] = port;
    node.process({ sampleRate: 48000, bufferSize: values.length / 2, quantum: values.length / 2, currentTime: 0 });
    const expected = node.outputs[0].buffer!;
    for (let i = 0; i < values.length; i++) expect(output[i] - expected[i % 2][Math.floor(i / 2)]).toBeCloseTo(0, 7);
    expect(output[0]).toBe(0);
    expect(output[2]).not.toBe(0);
  });


  it('ramps mixer and master changes over five milliseconds', () => {
    const input = source(Array(480).fill(1));
    for (const [before, after] of [
      [mix({ gain: 1 }), mix({ gain: 0 })],
      [mix({ pan: 0 }), mix({ pan: 1 })],
      [{ master: on({ gain: 1 }) }, { master: on({ gain: 0 }) }],
    ] as [ProcessorSnapshot, ProcessorSnapshot][]) {
      const processor = new BackendMainProcessors(48000);
      processor.process(input, before);
      const out = processor.process(input, after);
      expect(out[0]).toBeGreaterThan(0.99);
      expect(out[478]).toBeCloseTo(0, 6);
    }
  });

  it('crossfades EQ and DSP insertion over five milliseconds', () => {
    const values = Array.from({ length: 480 }, (_, i) => Math.sin(2 * Math.PI * 1000 * Math.floor(i / 2) / 48000) * 0.5);
    const input = source(values);
    for (const [plugin, params] of [['eq', { mid: 12 }], ['dsp', { depth: 1, cutoff: 100 }]] as const) {
      const processor = new BackendMainProcessors(48000);
      processor.process(input, { [plugin]: { ...on(params), active: false } });
      const out = processor.process(input, { [plugin]: on(params) });
      expect(Math.abs(out[2] - values[2])).toBeLessThan(0.01);
      expect(out.slice(-80).some((value, index) => Math.abs(value - values[400 + index]) > 0.05)).toBe(true);
    }
  });

  it('ramps spatial and effect return activation without shifting dry samples', () => {
    const input = source(Array(480).fill(0.5));
    for (const plugin of ['effect', 'spatial'] as const) {
      const params = plugin === 'effect' ? { wet: 1, bits: 2 } : { pan: 1 };
      const mixer = mix({ sendEffect: 1, sendSpatial: 1 });
      const processor = new BackendMainProcessors(48000);
      processor.process(input, { ...mixer, [plugin]: { ...on(params), active: false } });
      const out = processor.process(input, { ...mixer, [plugin]: on(params) });
      expect(out[0]).toBeCloseTo(0.5, 2);
      expect(Math.abs(out[478] - 0.5)).toBeGreaterThan(0.05);
    }
  });

  it('resets effect state when its epoch changes', () => {
    const processor = new BackendMainProcessors(48000);
    const snapshot = { ...mix({ sendEffect: 1 }), effect: on({ wet: 1, sampleReduction: 4 }) };
    processor.process(source([0.8, 0.8]), snapshot);
    const actual = processor.process(source([0.2, 0.2]), { ...snapshot, effect: on({ wet: 1, sampleReduction: 4 }, 2) });
    const fresh = new BackendMainProcessors(48000).process(source([0.2, 0.2]), snapshot);
    expect([...actual]).toEqual([...fresh]);
  });
});


it.each(['effect', 'spatial'] as const)('%s return impulse peak has zero sample displacement against dry', plugin => {
  const values = new Float32Array(1024); values[128] = 0.37; values[129] = 0.23;
  const input = new Map([['song', values]]);
  const config = { mixer: on({ sources: { song: { sendEffect: 1, sendSpatial: 1 } } }),
    [plugin]: on(plugin === 'effect' ? { wet: 0.7, bits: 3, sampleReduction: 1, feedback: 0, depth: 0 } : { pan: 0.7, width: 0.5 }) };
  const result = new BackendMainProcessors(48000).process(input, config);
  const peak = (array: Float32Array) => { let best = 0; for (let i = 2; i < array.length; i += 2) if (Math.abs(array[i]) > Math.abs(array[best])) best = i; return best / 2; };
  const returned = result.map((value, i) => value - values[i]);
  expect(Math.abs(peak(returned) - peak(values))).toBeLessThan(1);
  expect(returned.some(value => value !== 0)).toBe(true);
});

it('empty target selection means all sources and a neutral return never doubles dry', () => {
  const values = Array.from({ length: 1024 }, (_, i) => Math.sin(Math.floor(i / 2) * 0.13) * 0.3);
  const input = source(values);
  const a = new BackendMainProcessors(48000).process(input, { eq: on({ mid: 12, targets: [] }) });
  const b = new BackendMainProcessors(48000).process(input, { eq: on({ mid: 12 }) });
  expect(a).toEqual(b);
  expect(new BackendMainProcessors(48000).process(input, { ...mix({ sendEffect: 1, sendSpatial: 1 }), effect: on({ wet: 0 }), spatial: on({ pan: 0, width: 1 }) })).toEqual(Float32Array.from(values));
});
