// @vitest-environment node
/**
 * AUDIO-2026-11-06-002 (b) · Transportepoch: `step` empfangen, alte Epochs verwerfen
 * ==============================================================================
 * Der v2SinkProcessor stempelt `step` und `transport-started` schon immer mit
 * Frame/Zeit, aber niemand hoerte `step` ab – `audioEngine.currentStep` blieb
 * waehrend der Wiedergabe stehen, Step-Lampen und die dropMONK-Clock liefen
 * nicht. Zusaetzlich verwarf `audioEngine` verspaetete Starts nur ueber
 * `isPlaying`: nach Stop+Start wurde ein alter `transport-started` akzeptiert.
 *
 * Mechanik: die Epoch gehoert dem SINK. `startTransport` zaehlt sie hoch und
 * schickt sie mit; der Prozessor gibt sie in `step`/`transport-started` zurueck;
 * der Sink reicht nur Meldungen der AKTUELLEN Epoch weiter (alle Abnehmer –
 * `onStep`, `onTransportStarted` – sehen nur frische Meldungen).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { V2LiveSink } from '../src/core/audio/backends/V2LiveSink';

const SR = 48000;
const N = 128;

interface ProcessorInstance {
  port: { onmessage: ((e: { data?: unknown }) => void) | null; postMessage: (m: Record<string, unknown>) => void };
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}
type ProcessorCtor = new () => ProcessorInstance;
let Processor: ProcessorCtor | null = null;

function setFrame(frame: number): void {
  const g = globalThis as unknown as Record<string, number>;
  g.currentFrame = frame;
  g.currentTime = frame / SR;
}

function out(): Float32Array[][] {
  return [[new Float32Array(N), new Float32Array(N)]];
}

function render(p: ProcessorInstance, fromBlock: number, blocks: number): void {
  for (let b = 0; b < blocks; b++) {
    setFrame((fromBlock + b) * N);
    p.process([], out());
  }
}

describe('v2SinkProcessor · Epoch in step/transport-started', () => {
  beforeAll(async () => {
    const g = globalThis as unknown as Record<string, unknown>;
    g.sampleRate = SR;
    g.currentFrame = 0;
    g.currentTime = 0;
    g.AudioWorkletProcessor = class {
      port = { onmessage: null, postMessage: () => {} };
    };
    g.registerProcessor = (_name: string, ctor: ProcessorCtor) => { Processor = ctor; };
    await import('../src/audio/worklets/v2SinkProcessor.ts');
  });

  it('gibt die Epoch des Starts in jeder step-Meldung und in transport-started zurueck', () => {
    if (!Processor) throw new Error('Prozessor nicht geladen');
    const p = new Processor();
    const msgs: Record<string, unknown>[] = [];
    p.port.postMessage = (m) => { msgs.push({ ...m }); };
    setFrame(0);
    p.port.onmessage?.({ data: { type: 'transport', playing: true, bpm: 120, stepCount: 16, transportEpoch: 7 } });
    // 120 BPM → 16tel = 6000 Samples; 700 Bloecke à 128 = ~14 Steps.
    render(p, 0, 700);

    const steps = msgs.filter((m) => m.type === 'step');
    const started = msgs.filter((m) => m.type === 'transport-started');
    expect(steps.length).toBeGreaterThan(10);
    expect(started).toHaveLength(1);
    expect(steps.every((m) => m.epoch === 7)).toBe(true);
    expect(started[0].epoch).toBe(7);
  });

  it('behaelt die Epoch bei Parameter-Updates und uebernimmt eine neue beim Neustart', () => {
    if (!Processor) throw new Error('Prozessor nicht geladen');
    const p = new Processor();
    const msgs: Record<string, unknown>[] = [];
    p.port.postMessage = (m) => { msgs.push({ ...m }); };
    setFrame(0);
    p.port.onmessage?.({ data: { type: 'transport', playing: true, transportEpoch: 1 } });
    render(p, 0, 700);
    // Tempowechsel ohne Start: keine neue Epoch.
    p.port.onmessage?.({ data: { type: 'transport', bpm: 100 } });
    render(p, 700, 100);
    expect(msgs.filter((m) => m.type === 'step').every((m) => m.epoch === 1)).toBe(true);

    // Neustart mit neuer Epoch: ab jetzt tragen alle Meldungen die neue.
    p.port.onmessage?.({ data: { type: 'transport', playing: false } });
    p.port.onmessage?.({ data: { type: 'transport', playing: true, transportEpoch: 2 } });
    msgs.length = 0;
    render(p, 800, 700);
    const steps = msgs.filter((m) => m.type === 'step');
    expect(steps.length).toBeGreaterThan(5);
    expect(steps.every((m) => m.epoch === 2)).toBe(true);
    expect(msgs.filter((m) => m.type === 'transport-started')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Sink-Seite: Epoch-Filter + onStep-Weiterleitung
// ---------------------------------------------------------------------------
type Listener = (ev: { data?: unknown }) => void;
class FakePort {
  onmessage: Listener | null = null;
  readonly listeners = new Set<Listener>();
  readonly posted: Record<string, unknown>[] = [];
  postMessage(m: Record<string, unknown>): void { this.posted.push(m); }
  addEventListener(type: string, fn: Listener): void { if (type === 'message') this.listeners.add(fn); }
  removeEventListener(type: string, fn: Listener): void { if (type === 'message') this.listeners.delete(fn); }
  start(): void { /* egal */ }
  emit(data: unknown): void { for (const fn of this.listeners) fn({ data }); }
}
class FakeAudioWorkletNode {
  static created: FakeAudioWorkletNode[] = [];
  readonly port = new FakePort();
  onprocessorerror: unknown = null;
  constructor() { FakeAudioWorkletNode.created.push(this); }
  connect(): void { /* egal */ }
  disconnect(): void { /* egal */ }
}
function fakeContext(): AudioContext {
  return { audioWorklet: { addModule: vi.fn(async () => {}) }, destination: {}, sampleRate: SR } as unknown as AudioContext;
}

interface StepInfo { step: number; frame: number; timeSec: number; secondsPerStep: number }

describe('V2LiveSink · step-Empfang mit Transportepoch', () => {
  afterEach(() => { vi.unstubAllGlobals(); FakeAudioWorkletNode.created = []; });

  async function connectedSink(): Promise<{ sink: V2LiveSink; node: FakeAudioWorkletNode; steps: StepInfo[]; started: number[] }> {
    vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode);
    const steps: StepInfo[] = [];
    const started: number[] = [];
    const sink = new V2LiveSink({
      controlRing: false,
      onStep: (info) => { steps.push({ step: info.step, frame: info.frame, timeSec: info.timeSec, secondsPerStep: info.secondsPerStep }); },
      onTransportStarted: (frame) => { started.push(frame); },
    });
    await sink.connect(fakeContext());
    return { sink, node: FakeAudioWorkletNode.created[0], steps, started };
  }

  it('reicht step-Meldungen der aktuellen Epoch an onStep weiter', async () => {
    const { sink, node, steps } = await connectedSink();
    expect(sink.startTransport({ bpm: 120, stepCount: 16 })).toBe(true);
    const sentEpoch = node.port.posted.filter((m) => m.type === 'transport').at(-1)?.transportEpoch;
    expect(sentEpoch).toBe(sink.getTransportEpoch());
    node.port.emit({ type: 'step', step: 3, frame: 6000, time: 0.125, secondsPerStep: 0.125, epoch: sentEpoch });
    expect(steps).toEqual([{ step: 3, frame: 6000, timeSec: 0.125, secondsPerStep: 0.125 }]);
  });

  it('verwirft step-Meldungen einer alten Epoch (nach Stop+Start) und kaputte Meldungen', async () => {
    const { sink, node, steps } = await connectedSink();
    sink.startTransport({ bpm: 120 });
    const first = sink.getTransportEpoch();
    node.port.emit({ type: 'step', step: 0, frame: 1, epoch: first });
    sink.stopTransport();
    sink.startTransport({ bpm: 120 });
    const second = sink.getTransportEpoch();
    expect(second).toBeGreaterThan(first);

    // Verspaetete Meldung des alten Laufs.
    node.port.emit({ type: 'step', step: 7, frame: 7200, epoch: first });
    node.port.emit({ type: 'step', step: 'x', frame: 7200, epoch: second });
    node.port.emit({ type: 'step', step: 4, frame: Number.NaN, epoch: second });
    expect(steps).toHaveLength(1);
    node.port.emit({ type: 'step', step: 1, frame: 9600, secondsPerStep: 0.125, epoch: second });
    expect(steps).toHaveLength(2);
    expect(steps[1].step).toBe(1);
  });

  it('verwirft einen verspaeteten transport-started der alten Epoch', async () => {
    const { sink, node, started } = await connectedSink();
    sink.startTransport({});
    const first = sink.getTransportEpoch();
    node.port.emit({ type: 'transport-started', frame: 1000, epoch: first });
    sink.stopTransport();
    sink.startTransport({});
    const second = sink.getTransportEpoch();
    node.port.emit({ type: 'transport-started', frame: 2000, epoch: first });
    expect(started).toEqual([1000]);
    node.port.emit({ type: 'transport-started', frame: 3000, epoch: second });
    expect(started).toEqual([1000, 3000]);
  });

  it('Meldungen ohne Epoch gelten als Epoch 0 (frischer Sink, Abwaertskompatibilitaet)', async () => {
    const { sink, node, steps } = await connectedSink();
    expect(sink.getTransportEpoch()).toBe(0);
    node.port.emit({ type: 'step', step: 2, frame: 100 });
    expect(steps).toHaveLength(1);
    // Nach einem Start ist Epoch 0 veraltet.
    sink.startTransport({});
    node.port.emit({ type: 'step', step: 2, frame: 200 });
    expect(steps).toHaveLength(1);
  });

  it('zaehlt die Epoch je Start hoch und setzt sie bei einem frischen Prozessor zurueck', async () => {
    const { sink } = await connectedSink();
    sink.startTransport({});
    sink.startTransport({});
    expect(sink.getTransportEpoch()).toBe(2);
    sink.disconnect();
    expect(sink.getTransportEpoch()).toBe(0);
    await sink.connect(fakeContext());
    expect(sink.getTransportEpoch()).toBe(0);
    sink.startTransport({});
    expect(sink.getTransportEpoch()).toBe(1);
  });

  it('ignoriert Meldungen eines bereits ersetzten Knotens (kein Doppel-Step nach Reconnect)', async () => {
    const { sink, node, steps } = await connectedSink();
    sink.startTransport({});
    const epoch = sink.getTransportEpoch();
    sink.disconnect();
    await sink.connect(fakeContext());
    sink.startTransport({});
    node.port.emit({ type: 'step', step: 5, frame: 100, epoch });
    expect(steps).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// audioEngine: currentStep + Step-Listener (Lampen, dropMONK-Clock)
// ---------------------------------------------------------------------------
describe('audioEngine · currentStep folgt dem Worklet-Step', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('setzt currentStep und ruft onStepUpdate + Step-Listener (Drop-Clock-Pfad)', async () => {
    const { audioEngine } = await import('../src/utils/audioEngine');
    const internals = audioEngine as unknown as { isPlaying: boolean; currentStep: number };
    const prevPlaying = internals.isPlaying;
    const prevStep = internals.currentStep;
    const updates: number[] = [];
    const prevUpdate = audioEngine.onStepUpdate;
    const seen: number[] = [];
    const detach = audioEngine.addStepListener((s) => seen.push(s));
    try {
      audioEngine.onStepUpdate = (s) => updates.push(s);
      internals.isPlaying = true;
      audioEngine.v2LiveSink.onStep?.({ step: 5, frame: 31_000, timeSec: 31_000 / SR, secondsPerStep: 0.125 });
      expect(internals.currentStep).toBe(5);
      expect(updates).toEqual([5]);
      expect(seen).toEqual([5]);

      // 32-Step-Modus: der Worklet-Step wird auf den Stepcount normalisiert.
      audioEngine.stepCount = 32;
      audioEngine.v2LiveSink.onStep?.({ step: 31, frame: 32_000, timeSec: 32_000 / SR, secondsPerStep: 0.0625 });
      expect(internals.currentStep).toBe(31);
      expect(seen).toEqual([5, 31]);

      // Gestoppt: keine UI-/Clock-Impulse mehr.
      internals.isPlaying = false;
      audioEngine.v2LiveSink.onStep?.({ step: 9, frame: 40_000, timeSec: 40_000 / SR, secondsPerStep: 0.125 });
      expect(internals.currentStep).toBe(31);
      expect(seen).toEqual([5, 31]);
    } finally {
      detach();
      audioEngine.onStepUpdate = prevUpdate;
      audioEngine.stepCount = 16;
      internals.isPlaying = prevPlaying;
      internals.currentStep = prevStep;
    }
  });
});
