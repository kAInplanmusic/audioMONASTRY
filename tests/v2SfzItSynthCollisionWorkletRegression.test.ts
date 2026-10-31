import { beforeAll, describe, expect, it } from 'vitest';
import { SfzVoiceBankCore } from '../src/core/instrument/sfzVoiceBankCore';
import { ItSynthBank } from '../src/core/instrument/itSynthVoice';

const RATE = 48000;
const N = 128;
type Worklet = {
  port: { onmessage: ((event: { data: unknown }) => void) | null; postMessage: (message: unknown) => void };
  engine: { setExternalSource(channel: 'channel5', block: Float32Array[]): void };
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
};
let Processor: new () => Worklet;
const def = { id: 1, name: 'test', kind: 'synth' as const, osc: 'sine', attack: 0.001, gain: 0.08 };
const region = { sample: 'wave', lokey: 0, hikey: 127, raw: {} };
const samples = Float32Array.from({ length: 4096 }, (_, i) => 0.1 * Math.sin(i / 13));
function send(p: Worklet, data: unknown) { p.port.onmessage?.({ data }); }
function render(p: Worklet, frame: number, length = N): Float32Array[] {
  Object.assign(globalThis, { currentFrame: frame, currentTime: frame / RATE });
  const output = [new Float32Array(length), new Float32Array(length)];
  expect(p.process([], [output])).toBe(true);
  return output;
}

describe('SFZ and itSynth same-channel worklet contention', () => {
  beforeAll(async () => {
    Object.assign(globalThis, {
      sampleRate: RATE, currentFrame: 0, currentTime: 0,
      AudioWorkletProcessor: class { port = { onmessage: null, postMessage: () => {} }; },
      registerProcessor: (_name: string, ctor: new () => Worklet) => { Processor = ctor; },
    });
    await import('../src/audio/worklets/v2SinkProcessor');
  });

  it('matches real producer audio pre-mixed before the same output graph across contiguous blocks', () => {
    const actual = new Processor();
    const reference = new Processor();
    const errors: unknown[] = [];
    actual.port.postMessage = (msg: unknown) => { if ((msg as { type?: string }).type === 'render-error') errors.push(msg); };
    send(actual, { type: 'sfz-regions', channel: 'channel5', regions: [region], sources: { wave: samples } });
    send(actual, { type: 'sfz-note-on', channel: 'channel5', note: 60, velocity: 120 });
    send(actual, { type: 'it-config', def });
    send(actual, { type: 'it-note-on', note: 60, velocity: 0.6 });
    const sfz = new SfzVoiceBankCore(RATE, 0.002, 0.08);
    sfz.loadParsed([region], { wave: samples });
    sfz.noteOn(60, 120);
    const synth = new ItSynthBank();
    synth.config(def);
    synth.noteOn(60, 0.6);
    let peakSfz = 0;
    let peakSynth = 0;
    let peakOutput = 0;
    for (let b = 0; b < 12; b++) {
      const a = new Float32Array(N);
      const z = new Float32Array(N);
      sfz.renderBlock(a, N);
      synth.renderBlock(z);
      for (let i = 0; i < N; i++) {
        peakSfz = Math.max(peakSfz, Math.abs(a[i]));
        peakSynth = Math.max(peakSynth, Math.abs(z[i]));
        a[i] += z[i];
      }
      reference.engine.setExternalSource('channel5', [a]);
      const out = render(actual, b * N);
      const expected = render(reference, b * N);
      for (let ch = 0; ch < 2; ch++) for (let i = 0; i < N; i++) {
        peakOutput = Math.max(peakOutput, Math.abs(expected[ch][i]));
        expect(out[ch][i], `block ${b}, channel ${ch}, sample ${i}`).toBeCloseTo(expected[ch][i], 6);
      }
    }
    expect(peakSfz).toBeGreaterThan(0.01);
    expect(peakSynth).toBeGreaterThan(0.001);
    expect(peakOutput).toBeGreaterThan(0.001);
    expect(errors).toEqual([]);
  });

  it('preserves stereo samples, a second SFZ channel, mute progression and changing quantum sizes', () => {
    const actual = new Processor();
    const reference = new Processor();
    const errors: unknown[] = [];
    for (const p of [actual, reference]) {
      p.port.postMessage = (msg: unknown) => {
        if ((msg as { type?: string }).type === 'render-error') errors.push(msg);
      };
      const left = Float32Array.from({ length: 4096 }, (_, i) => 0.03 * Math.sin(i / 9));
      const right = Float32Array.from({ length: 4096 }, (_, i) => 0.02 * Math.cos(i / 15));
      send(p, { type: 'sample-load', id: 'stereo', left, right, sourceRate: RATE });
      send(p, { type: 'sample-assign', channel: 'channel5', id: 'stereo' });
      send(p, { type: 'sample-trigger', channel: 'channel5' });
      send(p, { type: 'sfz-regions', channel: 'channel4', regions: [region], sources: { wave: samples } });
      send(p, { type: 'sfz-note-on', channel: 'channel4', note: 60, velocity: 75 });
      send(p, { type: 'gain-db', channel: 'channel5', db: -7 });
    }
    send(actual, { type: 'sfz-regions', channel: 'channel5', regions: [region], sources: { wave: samples } });
    send(actual, { type: 'sfz-note-on', channel: 'channel5', note: 60, velocity: 120 });
    send(actual, { type: 'it-config', def });
    send(actual, { type: 'it-note-on', note: 60, velocity: 0.6 });
    const sfz = new SfzVoiceBankCore(RATE, 0.002, 0.08);
    sfz.loadParsed([region], { wave: samples });
    sfz.noteOn(60, 120);
    const synth = new ItSynthBank();
    synth.config(def);
    synth.noteOn(60, 0.6);
    let frame = 0;
    let stereoDifference = 0;
    for (const [b, length] of [128, 64, 256, 128, 128, 64, 256, 128, 128, 128].entries()) {
      if (b === 2 || b === 5) {
        for (const p of [actual, reference]) send(p, { type: 'mute', channel: 'channel5', muted: b === 2 });
      }
      const a = new Float32Array(length);
      const z = new Float32Array(length);
      sfz.renderBlock(a, length);
      synth.renderBlock(z);
      for (let i = 0; i < length; i++) a[i] += z[i];
      reference.engine.setExternalSource('channel5', [a]);
      const out = render(actual, frame, length);
      const expected = render(reference, frame, length);
      for (let i = 0; i < length; i++) {
        stereoDifference = Math.max(stereoDifference, Math.abs(expected[0][i] - expected[1][i]));
        for (let ch = 0; ch < 2; ch++) {
          expect(out[ch][i], `block ${b}, channel ${ch}, sample ${i}`).toBeCloseTo(expected[ch][i], 6);
        }
      }
      frame += length;
    }
    expect(stereoDifference).toBeGreaterThan(0.0001);
    expect(errors).toEqual([]);
  });

  it('keeps the surviving source audible as each producer stops and restarts', () => {
    const p = new Processor();
    const reference = new Processor();
    const shortWave = samples.slice(0, 330);
    send(p, { type: 'sfz-regions', channel: 'channel5', regions: [region], sources: { wave: shortWave } });
    send(p, { type: 'sfz-note-on', channel: 'channel5', note: 60, velocity: 120 });
    send(p, { type: 'it-config', def });
    send(p, { type: 'it-note-on', note: 60, velocity: 0.6 });
    const sfz = new SfzVoiceBankCore(RATE, 0.002, 0.08);
    sfz.loadParsed([region], { wave: shortWave });
    sfz.noteOn(60, 120);
    const synth = new ItSynthBank();
    synth.config(def);
    synth.noteOn(60, 0.6);
    for (let b = 0; b < 35; b++) {
      if (b === 7) { send(p, { type: 'it-note-off', note: 60, fast: true }); synth.noteOff(60, true); }
      if (b === 25) { send(p, { type: 'sfz-note-on', channel: 'channel5', note: 60, velocity: 120 }); sfz.noteOn(60, 120); }
      const a = new Float32Array(N);
      const z = new Float32Array(N);
      if (sfz.hasActiveVoices()) sfz.renderBlock(a, N);
      if (synth.hasActiveVoices()) synth.renderBlock(z);
      for (let i = 0; i < N; i++) a[i] += z[i];
      reference.engine.setExternalSource('channel5', [a]);
      const out = render(p, b * N);
      const expected = render(reference, b * N);
      for (let ch = 0; ch < 2; ch++) for (let i = 0; i < N; i++) {
        expect(out[ch][i], `block ${b}, channel ${ch}, sample ${i}`).toBeCloseTo(expected[ch][i], 6);
      }
    }
  });

  it('mutes both sources while their playback positions keep advancing', () => {
    const p = new Processor();
    const reference = new Processor();
    send(p, { type: 'sfz-regions', channel: 'channel5', regions: [region], sources: { wave: samples } });
    send(p, { type: 'sfz-note-on', channel: 'channel5', note: 60, velocity: 120 });
    send(p, { type: 'it-config', def });
    send(p, { type: 'it-note-on', note: 60, velocity: 0.6 });
    const sfz = new SfzVoiceBankCore(RATE, 0.002, 0.08);
    sfz.loadParsed([region], { wave: samples });
    sfz.noteOn(60, 120);
    const synth = new ItSynthBank();
    synth.config(def);
    synth.noteOn(60, 0.6);
    for (let b = 0; b < 14; b++) {
      if (b === 3 || b === 9) for (const item of [p, reference]) {
        send(item, { type: 'mute', channel: 'channel5', muted: b === 3 });
      }
      const a = new Float32Array(N);
      const z = new Float32Array(N);
      sfz.renderBlock(a, N);
      synth.renderBlock(z);
      for (let i = 0; i < N; i++) a[i] += z[i];
      reference.engine.setExternalSource('channel5', [a]);
      const out = render(p, b * N);
      const expected = render(reference, b * N);
      for (let ch = 0; ch < 2; ch++) for (let i = 0; i < N; i++) {
        expect(out[ch][i], `block ${b}, channel ${ch}, sample ${i}`).toBeCloseTo(expected[ch][i], 6);
        if (b >= 6 && b < 9) expect(out[ch][i]).toBe(0);
      }
    }
  });

  it('reuses both producer buffers without Float32Array constructions in warmed steady-state blocks', () => {
    const p = new Processor();
    send(p, { type: 'sfz-regions', channel: 'channel5', regions: [region], sources: { wave: samples } });
    send(p, { type: 'sfz-note-on', channel: 'channel5', note: 60, velocity: 120 });
    send(p, { type: 'it-config', def });
    send(p, { type: 'it-note-on', note: 60, velocity: 0.6 });
    const output = [new Float32Array(N), new Float32Array(N)];
    for (let b = 0; b < 4; b++) {
      Object.assign(globalThis, { currentFrame: b * N, currentTime: b * N / RATE });
      p.process([], [output]);
    }
    const native = globalThis.Float32Array;
    let constructions = 0;
    globalThis.Float32Array = new Proxy(native, {
      construct(target, args, newTarget) { constructions++; return Reflect.construct(target, args, newTarget); },
    });
    try {
      for (let b = 4; b < 16; b++) {
        Object.assign(globalThis, { currentFrame: b * N, currentTime: b * N / RATE });
        expect(p.process([], [output])).toBe(true);
      }
    } finally {
      globalThis.Float32Array = native;
    }
    expect(constructions).toBe(0);
  });
});
