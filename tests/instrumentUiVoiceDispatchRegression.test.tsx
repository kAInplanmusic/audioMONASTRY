// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { UniversalKeyboard } from '../src/components/instrument/UniversalKeyboard';
import { instrumentBackend } from '../src/core/instrument/InstrumentBackend';
import { audioEngine } from '../src/utils/audioEngine';
import { V2SinkEngine } from '../src/core/audio/live/V2SinkEngine';
import type { InstrumentPitchDef } from '../src/core/instrument/itSynthVoice';

const RATE = 48000;
const QUANTUM = 128;
type Processor = {
  port: { onmessage: ((event: { data: unknown }) => void) | null; postMessage: (message: unknown) => void };
  engine: { itSynth: { hasActiveVoices(): boolean } };
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
};
let ProcessorClass: new () => Processor;

class FakeAudioWorkletNode {
  static latest: FakeAudioWorkletNode;
  readonly processor = new ProcessorClass();
  readonly listeners = new Set<(event: { data: unknown }) => void>();
  readonly messages: Array<{ type: string; [key: string]: unknown }> = [];
  onprocessorerror = null;
  readonly port = {
    postMessage: (message: { type: string; [key: string]: unknown }) => {
      this.messages.push(structuredClone(message));
      this.processor.port.onmessage?.({ data: message });
    },
    addEventListener: (type: string, listener: (event: { data: unknown }) => void) => { if (type === 'message') this.listeners.add(listener); },
    removeEventListener: (_type: string, listener: (event: { data: unknown }) => void) => { this.listeners.delete(listener); },
    start: () => {},
  };
  constructor() {
    FakeAudioWorkletNode.latest = this;
    this.processor.port.postMessage = (data) => { for (const listener of this.listeners) listener({ data }); };
  }
  connect(): void {}
  disconnect(): void {}
  render(frame: number): Float32Array[] {
    Object.assign(globalThis, { currentFrame: frame, currentTime: frame / RATE });
    const output = [new Float32Array(QUANTUM), new Float32Array(QUANTUM)];
    this.processor.process([], [output]);
    return output;
  }
}

describe('instrument UI synth note dispatch', () => {
  beforeAll(async () => {
    Object.assign(globalThis, {
      sampleRate: RATE, currentFrame: 0, currentTime: 0,
      AudioWorkletProcessor: class { port = { onmessage: null, postMessage: () => {} }; },
      registerProcessor: (_name: string, ctor: new () => Processor) => { ProcessorClass = ctor; },
    });
    await import('../src/audio/worklets/v2SinkProcessor');
  });
  afterEach(() => {
    cleanup();
    audioEngine.v2LiveSink.disconnect();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('releases a keyboard-triggered synth voice on pointer up', async () => {
    vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode);
    vi.stubGlobal('PointerEvent', MouseEvent);
    const engine = audioEngine as unknown as { ensureInitialized(): Promise<void> };
    vi.spyOn(engine, 'ensureInitialized').mockResolvedValue();
    const ctx = { sampleRate: RATE, destination: {}, audioWorklet: { addModule: async () => {} } } as unknown as AudioContext;
    expect(await audioEngine.v2LiveSink.connect(ctx)).toBe(true);
    await instrumentBackend.load(102);
    render(<UniversalKeyboard baseNote={60} octaves={1} />);
    const key = screen.getByRole('button', { name: 'Note 60' });
    vi.spyOn(key, 'getBoundingClientRect').mockReturnValue({ top: 0, height: 100 } as DOMRect);
    fireEvent.pointerDown(key, { clientY: 50 });
    const node = FakeAudioWorkletNode.latest;
    await waitFor(() => expect(node.processor.engine.itSynth.hasActiveVoices()).toBe(true));
    for (let frame = 0; frame < 12000; frame += QUANTUM) node.render(frame);
    fireEvent.pointerUp(key);
    // Backend dispatches asynchronously through its lazy engine reference.
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (let frame = 12032; frame < 36000; frame += QUANTUM) node.render(frame);
    expect(node.processor.engine.itSynth.hasActiveVoices()).toBe(false);
  });

  it('does not trigger a generic sequencer voice for a keyboard synth note', async () => {
    vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode);
    vi.stubGlobal('PointerEvent', MouseEvent);
    const engine = audioEngine as unknown as { ensureInitialized(): Promise<void> };
    vi.spyOn(engine, 'ensureInitialized').mockResolvedValue();
    const genericTrigger = vi.spyOn(audioEngine.v2LiveSink, 'synthTrigger');
    const ctx = { sampleRate: RATE, destination: {}, audioWorklet: { addModule: async () => {} } } as unknown as AudioContext;
    expect(await audioEngine.v2LiveSink.connect(ctx)).toBe(true);
    await instrumentBackend.load(102);
    render(<UniversalKeyboard baseNote={60} octaves={1} />);
    const key = screen.getByRole('button', { name: 'Note 60' });
    vi.spyOn(key, 'getBoundingClientRect').mockReturnValue({ top: 0, height: 100 } as DOMRect);
    fireEvent.pointerDown(key, { clientY: 50 });
    await waitFor(() => expect(FakeAudioWorkletNode.latest.processor.engine.itSynth.hasActiveVoices()).toBe(true));
    expect(genericTrigger).not.toHaveBeenCalled();
  });

  it('routes the instrument through its contract channel and obeys its mute', async () => {
    vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode);
    vi.stubGlobal('PointerEvent', MouseEvent);
    const engine = audioEngine as unknown as { ensureInitialized(): Promise<void> };
    vi.spyOn(engine, 'ensureInitialized').mockResolvedValue();
    const ctx = { sampleRate: RATE, destination: {}, audioWorklet: { addModule: async () => {} } } as unknown as AudioContext;
    expect(await audioEngine.v2LiveSink.connect(ctx)).toBe(true);
    await instrumentBackend.load(102);
    render(<UniversalKeyboard baseNote={60} octaves={1} />);
    const key = screen.getByRole('button', { name: 'Note 60' });
    vi.spyOn(key, 'getBoundingClientRect').mockReturnValue({ top: 0, height: 100 } as DOMRect);
    fireEvent.pointerDown(key, { clientY: 50 });
    const node = FakeAudioWorkletNode.latest;
    await waitFor(() => expect(node.processor.engine.itSynth.hasActiveVoices()).toBe(true));
    let frame = 0;
    const peak = (count: number) => {
      let max = 0;
      for (let i = 0; i < count; i++, frame += QUANTUM) {
        for (const value of node.render(frame)[0]) max = Math.max(max, Math.abs(value));
      }
      return max;
    };
    expect(peak(32)).toBeGreaterThan(0.0001);
    // channel4 belongs to syntisampler, not instrument.
    audioEngine.v2LiveSink.setChannelMuted('channel4', true);
    peak(16); // drain the existing MAIN lookahead/filter tail
    expect(peak(32)).toBeGreaterThan(0.0001);
    audioEngine.v2LiveSink.setChannelMuted('channel5', true);
    peak(16); // drain the existing MAIN lookahead/filter tail
    expect(peak(32)).toBeLessThan(1e-7);
    audioEngine.v2LiveSink.setChannelMuted('channel5', false);
    expect(peak(32)).toBeGreaterThan(0.0001);
  });

  it('matches a real synth fed directly to the graph without another quantum of delay', async () => {
    vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode);
    vi.stubGlobal('PointerEvent', MouseEvent);
    vi.spyOn(audioEngine as unknown as { ensureInitialized(): Promise<void> }, 'ensureInitialized').mockResolvedValue();
    const ctx = { sampleRate: RATE, destination: {}, audioWorklet: { addModule: async () => {} } } as unknown as AudioContext;
    expect(await audioEngine.v2LiveSink.connect(ctx)).toBe(true);
    await instrumentBackend.load(102);
    render(<UniversalKeyboard baseNote={60} octaves={1} />);
    const key = screen.getByRole('button', { name: 'Note 60' });
    vi.spyOn(key, 'getBoundingClientRect').mockReturnValue({ top: 0, height: 100 } as DOMRect);
    fireEvent.pointerDown(key, { clientY: 50 });
    const node = FakeAudioWorkletNode.latest;
    await waitFor(() => expect(node.processor.engine.itSynth.hasActiveVoices()).toBe(true));
    const config = node.messages.find((message) => message.type === 'it-config')!;
    const reference = new V2SinkEngine(RATE, QUANTUM);
    // The live sink synchronizes master gain before the note; apply the same
    // input to the reference graph before its nonlinear mastering stage.
    const masterGain = node.messages.filter((message) => message.type === 'master-gain').at(-1);
    expect(typeof masterGain?.value).toBe('number');
    reference.setMasterGain(masterGain!.value as number);
    reference.itConfig(config.def as InstrumentPitchDef);
    const noteOn = node.messages.find((message) => message.type === 'it-note-on')!;
    expect(noteOn.note).toBe(60);
    reference.itNoteOn(noteOn.note as number, noteOn.velocity as number);
    const mono = new Float32Array(QUANTUM);
    const source = [mono];
    let max = 0;
    for (let frame = 0; frame < 8192; frame += QUANTUM) {
      const actual = node.render(frame);
      reference.renderItSynth(mono);
      reference.setExternalSource('channel5', source);
      const expected = reference.render({ sampleRate: RATE, bufferSize: QUANTUM, quantum: QUANTUM / RATE, currentTime: frame / RATE });
      for (let ch = 0; ch < 2; ch++) {
        for (let i = 0; i < QUANTUM; i++) {
          max = Math.max(max, Math.abs(expected[ch][i]));
          expect(actual[ch][i]).toBeCloseTo(expected[ch][i], 7);
        }
      }
    }
    expect(max).toBeGreaterThan(0.0001);
  });

  it('forwards rendered synth samples to the live output without the generic voice', async () => {
    vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode);
    vi.stubGlobal('PointerEvent', MouseEvent);
    const engine = audioEngine as unknown as { ensureInitialized(): Promise<void> };
    vi.spyOn(engine, 'ensureInitialized').mockResolvedValue();
    const ctx = { sampleRate: RATE, destination: {}, audioWorklet: { addModule: async () => {} } } as unknown as AudioContext;
    await instrumentBackend.load(102);

    async function playKeyboard(): Promise<{ blocks: Float32Array[]; scratchPeak: number; forwardedPeak: number }> {
      expect(await audioEngine.v2LiveSink.connect(ctx)).toBe(true);
      render(<UniversalKeyboard baseNote={60} octaves={1} />);
      const key = screen.getByRole('button', { name: 'Note 60' });
      vi.spyOn(key, 'getBoundingClientRect').mockReturnValue({ top: 0, height: 100 } as DOMRect);
      fireEvent.pointerDown(key, { clientY: 50 });
      const node = FakeAudioWorkletNode.latest;
      await waitFor(() => expect(node.processor.engine.itSynth.hasActiveVoices()).toBe(true));
      const blocks: Float32Array[] = [];
      for (let frame = 0; frame < 8192; frame += QUANTUM) blocks.push(node.render(frame)[0]);
      const scratch = (node.processor as unknown as { itScratch: Map<string, { buffer: Float32Array; block: Float32Array[] }> }).itScratch.get('channel5')!;
      const scratchPeak = Math.max(...Array.from(scratch.buffer, Math.abs));
      const forwardedPeak = Math.max(...Array.from(scratch.block[0], Math.abs));
      cleanup();
      audioEngine.v2LiveSink.disconnect();
      return { blocks, scratchPeak, forwardedPeak };
    }

    const actual = await playKeyboard();
    // Compare against the same real synth and graph with only the generic trigger suppressed.
    vi.spyOn(audioEngine.v2LiveSink, 'synthTrigger').mockReturnValue(true);
    const synthOnly = await playKeyboard();
    const maxActual = Math.max(...actual.blocks.flatMap((block) => Array.from(block, Math.abs)));
    const maxSignal = Math.max(...synthOnly.blocks.flatMap((block) => Array.from(block, Math.abs)));
    const maxDifference = Math.max(...actual.blocks.flatMap((block, b) => Array.from(block, (sample, i) => Math.abs(sample - synthOnly.blocks[b][i]))));
    expect(maxActual).toBeGreaterThan(0.0001);
    expect(synthOnly.scratchPeak).toBeGreaterThan(0.0001);
    expect(synthOnly.forwardedPeak).toBeGreaterThan(0.0001);
    expect(maxSignal).toBeGreaterThan(0.0001);
    expect(maxDifference).toBeLessThan(1e-7);
  });
});
