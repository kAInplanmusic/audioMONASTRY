// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { InstrumentBackend } from '../src/core/instrument/InstrumentBackend';
import { audioEngine } from '../src/utils/audioEngine';

const RATE = 48000;
const QUANTUM = 128;
type Processor = {
  port: { onmessage: ((event: { data: unknown }) => void) | null; postMessage: (message: unknown) => void };
  engine: { itSynth: { hasActiveVoices(): boolean } };
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
};
let ProcessorClass: new () => Processor;
class FakeWorkletNode {
  static latest: FakeWorkletNode;
  readonly processor = new ProcessorClass();
  readonly messages: Array<{ type: string; [key: string]: unknown }> = [];
  onprocessorerror = null;
  readonly port = {
    postMessage: (message: { type: string; [key: string]: unknown }) => {
      this.messages.push(structuredClone(message));
      this.processor.port.onmessage?.({ data: message });
    },
    addEventListener: () => {}, removeEventListener: () => {}, start: () => {},
  };
  constructor() { FakeWorkletNode.latest = this; }
  connect(): void {}
  disconnect(): void {}
  render(frame: number): Float32Array {
    Object.assign(globalThis, { currentFrame: frame, currentTime: frame / RATE });
    const output = [new Float32Array(QUANTUM), new Float32Array(QUANTUM)];
    this.processor.process([], [output]);
    return output[0];
  }
}

describe('event-time snapshot on the live synth path', () => {
  beforeAll(async () => {
    Object.assign(globalThis, {
      sampleRate: RATE, currentFrame: 0, currentTime: 0,
      AudioWorkletProcessor: class { port = { onmessage: null, postMessage: () => {} }; },
      registerProcessor: (_name: string, ctor: new () => Processor) => { ProcessorClass = ctor; },
    });
    await import('../src/audio/worklets/v2SinkProcessor');
  });
  afterEach(() => { audioEngine.v2LiveSink.disconnect(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  it('renders the event-time instrument and pitch before releasing the voice', async () => {
    vi.stubGlobal('AudioWorkletNode', FakeWorkletNode);
    vi.spyOn(audioEngine as unknown as { ensureInitialized(): Promise<void> }, 'ensureInitialized').mockResolvedValue();
    const ctx = { sampleRate: RATE, destination: {}, audioWorklet: { addModule: async () => {} } } as unknown as AudioContext;
    expect(await audioEngine.v2LiveSink.connect(ctx)).toBe(true);
    const backend = new InstrumentBackend();
    await backend.load(102);
    backend.setParam('transpose', 1);
    backend.noteOn(60, 0.8);
    const next = backend.load(101);
    backend.setParam('transpose', -1);
    await next;
    const node = FakeWorkletNode.latest;
    await vi.waitFor(() => expect(node.processor.engine.itSynth.hasActiveVoices()).toBe(true));
    expect(node.messages.find((m) => m.type === 'it-config')?.def).toEqual(expect.objectContaining({ id: 102 }));
    expect(node.messages.find((m) => m.type === 'it-note-on')?.note).toBe(61);
    let peak = 0;
    for (let frame = 0; frame < 12000; frame += QUANTUM) {
      for (const sample of node.render(frame)) peak = Math.max(peak, Math.abs(sample));
    }
    expect(peak).toBeGreaterThan(0.0001);
    backend.noteOff();
    await vi.waitFor(() => expect(node.messages.some((m) => m.type === 'it-note-off')).toBe(true));
    for (let frame = 12032; frame < 96000; frame += QUANTUM) node.render(frame);
    expect(node.processor.engine.itSynth.hasActiveVoices()).toBe(false);
  });
});
