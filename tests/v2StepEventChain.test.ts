// @vitest-environment node
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { v2MasteringLookaheadSamples } from '../src/core/audio/live/v2Pdc';
import { V2LiveSink, type V2LiveStep } from '../src/core/audio/backends/V2LiveSink';
import { audioEngine } from '../src/utils/audioEngine';

const RATE = 48000;
const QUANTUM = 128;
type Listener = (event: { data: unknown }) => void;
type Processor = {
  port: { onmessage: ((event: { data: unknown }) => void) | null; postMessage: (message: unknown) => void };
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
};
let ProcessorClass: new () => Processor;

class FakeAudioWorkletNode {
  static latest: FakeAudioWorkletNode;
  readonly processor = new ProcessorClass();
  readonly listeners = new Set<Listener>();
  onprocessorerror = null;
  readonly port = {
    postMessage: (message: unknown) => this.processor.port.onmessage?.({ data: message }),
    addEventListener: (type: string, listener: Listener) => { if (type === 'message') this.listeners.add(listener); },
    removeEventListener: (type: string, listener: Listener) => { if (type === 'message') this.listeners.delete(listener); },
    start: () => {},
  };
  constructor() {
    FakeAudioWorkletNode.latest = this;
    this.processor.port.postMessage = (message) => {
      for (const listener of this.listeners) listener({ data: structuredClone(message) });
    };
  }
  connect(): void {}
  disconnect(): void {}
  render(frame: number): void {
    Object.assign(globalThis, { currentFrame: frame, currentTime: frame / RATE });
    this.processor.process([], [[new Float32Array(QUANTUM), new Float32Array(QUANTUM)]]);
  }
}

describe('V2 Step-Ereigniskette', () => {
  beforeAll(async () => {
    Object.assign(globalThis, {
      sampleRate: RATE, currentFrame: 0, currentTime: 0,
      AudioWorkletProcessor: class { port = { onmessage: null, postMessage: () => {} }; },
      registerProcessor: (_name: string, ctor: new () => Processor) => { ProcessorClass = ctor; },
    });
    await import('../src/audio/worklets/v2SinkProcessor');
  });
  afterEach(() => { audioEngine.v2LiveSink.disconnect(); vi.unstubAllGlobals(); });

  it('Worklet-Steps erreichen Engine und Listener mit unverändertem PDC-Frame', async () => {
    vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode);
    const state = audioEngine as unknown as { isPlaying: boolean };
    const oldPlaying = state.isPlaying;
    const oldStep = audioEngine.currentStep;
    const oldLegacy = audioEngine.onStepUpdate;
    const oldSinkCallback = audioEngine.v2LiveSink.onStep;
    const observed: number[] = [];
    const forwarded: V2LiveStep[] = [];
    const legacy = vi.fn();
    const off = audioEngine.addStepListener((step) => observed.push(step));
    const ctx = { sampleRate: RATE, destination: {}, audioWorklet: { addModule: async () => {} } } as unknown as AudioContext;
    try {
      state.isPlaying = true;
      audioEngine.onStepUpdate = legacy;
      audioEngine.v2LiveSink.onStep = (event) => { forwarded.push(event); oldSinkCallback?.(event); };
      expect(await audioEngine.v2LiveSink.connect(ctx)).toBe(true);
      const node = FakeAudioWorkletNode.latest;
      const raw: Array<{ step: number; frame: number; time: number }> = [];
      node.listeners.add((ev) => {
        const data = ev.data as { type: string; step: number; frame: number; time: number };
        if (data.type === 'step') { const { type: _type, ...event } = data; raw.push(event); }
      });
      expect(audioEngine.v2LiveSink.startTransport({ bpm: 120, stepCount: 16 })).toBe(true);
      for (let frame = 0; frame < 12288; frame += QUANTUM) node.render(frame);
      expect(raw.map((event) => event.step)).toEqual([0, 1]);
      expect(raw[0].frame).toBeGreaterThanOrEqual(5999 + v2MasteringLookaheadSamples(RATE));
      expect(raw[0].time).toBe(raw[0].frame / RATE);
      expect(forwarded).toEqual(raw);
      expect(audioEngine.getCaptureTransportStart()).toEqual({ frame: raw[0].frame, sec: raw[0].time });
      expect(observed).toEqual([0, 1]);
      expect(legacy.mock.calls.map(([step]) => step)).toEqual([0, 1]);
      expect(audioEngine.currentStep).toBe(1);
    } finally {
      off();
      audioEngine.onStepUpdate = oldLegacy;
      audioEngine.v2LiveSink.onStep = oldSinkCallback;
      audioEngine.currentStep = oldStep;
      state.isPlaying = oldPlaying;
    }
  });

  it('Sink verwirft defekte und veraltete Nachrichten und erhält alle Step-Metadaten', async () => {
    vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode);
    const seen: V2LiveStep[] = [];
    const sink = new V2LiveSink({ controlRing: false, onStep: (event) => seen.push(event) });
    const ctx = { sampleRate: RATE, destination: {}, audioWorklet: { addModule: async () => {} } } as unknown as AudioContext;
    await sink.connect(ctx);
    const oldNode = FakeAudioWorkletNode.latest;
    const event = { type: 'step', step: 31, frame: 10240, time: 10240 / RATE, swing: 0.5, gate: 0.9, secondsPerStep: 0.125 };
    const deliver = (data: unknown) => { for (const listener of oldNode.listeners) listener({ data }); };
    deliver(event);
    deliver({ ...event, step: -1 });
    deliver({ ...event, step: 32 });
    deliver({ ...event, frame: NaN });
    deliver({ ...event, secondsPerStep: Infinity });
    expect(seen).toEqual([{ step: 31, frame: event.frame, time: event.time, swing: event.swing, gate: event.gate, secondsPerStep: event.secondsPerStep }]);
    sink.disconnect();
    deliver(event);
    expect(seen).toHaveLength(1);
  });

  it('Engine ignoriert Steps nach Stopp und außerhalb des aktuellen Rasters', () => {
    const state = audioEngine as unknown as { isPlaying: boolean };
    const oldPlaying = state.isPlaying;
    const oldStep = audioEngine.currentStep;
    const seen: number[] = [];
    const off = audioEngine.addStepListener((step) => seen.push(step));
    const event = { step: 2, frame: 10000, time: 10000 / RATE, swing: 0, gate: 0.9, secondsPerStep: 0.125 };
    try {
      state.isPlaying = false;
      audioEngine.v2LiveSink.onStep?.(event);
      state.isPlaying = true;
      audioEngine.v2LiveSink.onStep?.({ ...event, step: audioEngine.stepCount });
      expect(seen).toEqual([]);
      expect(audioEngine.currentStep).toBe(oldStep);
    } finally {
      off();
      state.isPlaying = oldPlaying;
    }
  });
});