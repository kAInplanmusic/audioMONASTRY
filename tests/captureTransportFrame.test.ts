// @vitest-environment node
/**
 * IDEA-2026-10-07-A-F1 · Capture-Raster exakt am Worklet-Frame
 * ============================================================
 * Vorher: Transport-Start = `ctx.currentTime` beim play()-Post (Näherung, liegt
 * um Post-Latenz + ein 16tel neben dem echten ersten Step 0).
 * Jetzt:
 *   - echter v2SinkProcessor meldet beim ersten Step 0 nach `transport
 *     playing:true` genau EINMAL `transport-started` mit dem hörbaren Frame
 *     (inkl. PDC-Lookahead, identisch zur `step`-Meldung) – ohne neues Objekt
 *     pro Meldung (vorallokiert);
 *   - V2LiveSink reicht die Meldung an `onTransportStarted` weiter (nur vom
 *     aktuellen Knoten);
 *   - audioEngine übernimmt frame/sampleRate als `transportStartSec` und
 *     quantisiert Capture daran; nach stop() verworfen;
 *   - Quantisierung: Raster-Ursprung = Worklet-Frame, auch bei krummen Frames.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { V2LiveSink } from '../src/core/audio/backends/V2LiveSink';
import { v2MasteringLookaheadSamples } from '../src/core/audio/live/v2Pdc';
import { captureGridOrigin, quantizeCapture } from '../src/core/capture/quantizeCapture';
import type { CaptureEvent } from '../src/core/capture/eventCaptureLog';

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

describe('v2SinkProcessor · transport-started', () => {
  beforeAll(async () => {
    const g = globalThis as unknown as Record<string, unknown>;
    g.sampleRate = SR;
    g.currentFrame = 0;
    g.currentTime = 0;
    g.AudioWorkletProcessor = class {
      port = { onmessage: null, postMessage: () => {} };
    };
    g.registerProcessor = (_name: string, ctor: ProcessorCtor) => {
      Processor = ctor;
    };
    await import('../src/audio/worklets/v2SinkProcessor.ts');
  });

  it('meldet den Frame des ersten Step 0 genau einmal je Start (hörbarer Frame inkl. PDC)', () => {
    if (!Processor) throw new Error('Prozessor nicht geladen');
    const p = new Processor();
    const msgs: Record<string, unknown>[] = [];
    p.port.postMessage = (m) => { msgs.push({ ...m }); };
    const startBlock = 37; // krummer Startpunkt
    setFrame(startBlock * N);
    p.port.onmessage?.({ data: { type: 'transport', playing: true, bpm: 120, stepCount: 16 } });

    // 120 BPM → 16tel = 6000 Samples; > 2 Takte rendern.
    const blocks = Math.ceil((6000 * 40) / N);
    for (let b = 0; b < blocks; b++) {
      setFrame((startBlock + b) * N);
      p.process([], out());
    }
    const started = msgs.filter((m) => m.type === 'transport-started');
    const steps = msgs.filter((m) => m.type === 'step');
    expect(started).toHaveLength(1);
    const firstStep0 = steps.find((m) => m.step === 0)!;
    expect(started[0].frame).toBe(firstStep0.frame);
    expect(started[0].time).toBeCloseTo((firstStep0.frame as number) / SR, 12);
    // Clock: Phase 0 → Step 0 nach genau einem 16tel; + PDC-Lookahead (hörbar).
    const expected = startBlock * N + 6000 - 1 + v2MasteringLookaheadSamples(SR);
    expect(Math.abs((started[0].frame as number) - expected)).toBeLessThanOrEqual(1);
    // Spätere Step-0-Durchläufe (Taktanfänge) melden nichts mehr.
    expect(steps.filter((m) => m.step === 0).length).toBeGreaterThan(1);
  });

  it('Stop/Neustart meldet erneut; Stop vor dem ersten Step meldet nichts', () => {
    if (!Processor) throw new Error('Prozessor nicht geladen');
    const p = new Processor();
    const msgs: Record<string, unknown>[] = [];
    p.port.postMessage = (m) => { msgs.push({ ...m }); };
    setFrame(0);
    p.port.onmessage?.({ data: { type: 'transport', playing: true, bpm: 120 } });
    p.port.onmessage?.({ data: { type: 'transport', playing: false } });
    for (let b = 0; b < 100; b++) { setFrame(b * N); p.process([], out()); }
    expect(msgs.filter((m) => m.type === 'transport-started')).toHaveLength(0);

    p.port.onmessage?.({ data: { type: 'transport', playing: true, bpm: 120 } });
    for (let b = 100; b < 200; b++) { setFrame(b * N); p.process([], out()); }
    expect(msgs.filter((m) => m.type === 'transport-started')).toHaveLength(1);
    p.port.onmessage?.({ data: { type: 'transport', playing: true, bpm: 120 } });
    for (let b = 200; b < 300; b++) { setFrame(b * N); p.process([], out()); }
    expect(msgs.filter((m) => m.type === 'transport-started')).toHaveLength(2);
  });

  it('verwendet für die Meldung ein vorallokiertes Objekt (keine neue Instanz je Start)', () => {
    if (!Processor) throw new Error('Prozessor nicht geladen');
    const p = new Processor();
    const refs: unknown[] = [];
    p.port.postMessage = (m) => { if (m.type === 'transport-started') refs.push(m); };
    for (let run = 0; run < 2; run++) {
      p.port.onmessage?.({ data: { type: 'transport', playing: true, bpm: 120 } });
      for (let b = 0; b < 60; b++) { setFrame((run * 60 + b) * N); p.process([], out()); }
    }
    expect(refs).toHaveLength(2);
    expect(refs[0]).toBe(refs[1]);
  });
});

// ---------------------------------------------------------------------------
// V2LiveSink → onTransportStarted
// ---------------------------------------------------------------------------
type Listener = (ev: { data?: unknown }) => void;
class FakePort {
  onmessage: Listener | null = null;
  readonly listeners = new Set<Listener>();
  postMessage(): void { /* egal */ }
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

describe('V2LiveSink · onTransportStarted', () => {
  afterEach(() => { vi.unstubAllGlobals(); FakeAudioWorkletNode.created = []; });

  it('reicht frame/time weiter; kaputte Meldungen und alte Knoten nicht', async () => {
    vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode);
    const seen: Array<[number, number]> = [];
    const sink = new V2LiveSink({ controlRing: false, onTransportStarted: (f, t) => { seen.push([f, t]); } });
    await sink.connect(fakeContext());
    const node = FakeAudioWorkletNode.created[0];
    node.port.emit({ type: 'transport-started', frame: 96_240, time: 96_240 / SR });
    node.port.emit({ type: 'transport-started', frame: 'x' });
    node.port.emit({ type: 'transport-started', frame: 4800 }); // ohne time → frame / sampleRate
    expect(seen).toEqual([[96_240, 96_240 / SR], [4800, 0.1]]);
    sink.disconnect();
    node.port.emit({ type: 'transport-started', frame: 1, time: 1 });
    expect(seen).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// audioEngine übernimmt den Worklet-Frame
// ---------------------------------------------------------------------------
describe('audioEngine · Capture-Raster am Worklet-Frame', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('transport-started setzt transportStartSec = frame/SR; captureNow quantisiert daran; stop verwirft', async () => {
    const { audioEngine } = await import('../src/utils/audioEngine');
    const internals = audioEngine as unknown as { isPlaying: boolean; ctx: unknown; monitor: { isMainHolderActive(): boolean } };
    const prevPlaying = internals.isPlaying;
    const prevCtx = internals.ctx;
    const clock = { currentTime: 0, sampleRate: SR };
    try {
      internals.ctx = clock;
      // Nicht spielend: Meldung wird verworfen.
      internals.isPlaying = false;
      audioEngine.v2LiveSink.onTransportStarted?.(48_000, 1);
      expect(audioEngine.getCaptureTransportStart()).toBeNull();

      internals.isPlaying = true;
      const frame = 100_037; // krummer Frame → 2,0841… s
      audioEngine.v2LiveSink.onTransportStarted?.(frame, frame / SR);
      expect(audioEngine.getCaptureTransportStart()).toEqual({ frame, sec: frame / SR });

      // drumsamplerMONK-Pad genau auf Step 5 (Index 4) des 2. Takts nach Start,
      // 20 ms zu spät gespielt (120 BPM: Takt 2 s, 16tel 0,125 s).
      audioEngine.captureLog.clear();
      clock.currentTime = frame / SR + 2 + 4 * 0.125 + 0.02;
      audioEngine.recordDrumCapture('tr-808', 'snare', 1, 'drum-pad');
      clock.currentTime += 0.5;
      const r = await audioEngine.captureNow();
      expect(r.transportStartSec).toBeCloseTo(frame / SR, 12);
      expect(r.gridStartSec).toBeCloseTo(frame / SR + 2, 9);
      expect(r.drumHits).toEqual([{ bar: 0, step: 4, kitId: 'tr-808', soundId: 'snare', velocity: 1 }]);
      // Drum-Schläge stehen NICHT im Engine-Raster (kein Doppel-Trigger).
      expect(r.bars[0].channel2.some(Boolean) || r.bars[0].channel3.some(Boolean)).toBe(false);

      vi.spyOn(internals.monitor, 'isMainHolderActive').mockReturnValue(true);
      vi.spyOn(audioEngine.v2LiveSink, 'stopTransport').mockReturnValue(true);
      vi.spyOn(audioEngine.v2LiveSink, 'disconnect').mockImplementation(() => {});
      audioEngine.stop();
      expect(audioEngine.getCaptureTransportStart()).toBeNull();
    } finally {
      internals.isPlaying = prevPlaying;
      internals.ctx = prevCtx;
      audioEngine.captureLog.clear();
    }
  });
});

describe('audioEngine · Layout-Wechsel hängt die Abgriffe sofort nach', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('verbundener Sink: setStereoMode baut vollständig neu auf (connectV2LiveOutput → Abgriffe, Patterns, Transport)', async () => {
    const { audioEngine } = await import('../src/utils/audioEngine');
    const sink = audioEngine.v2LiveSink;
    const calls: string[] = [];
    vi.spyOn(sink, 'isConnected', 'get').mockReturnValue(true);
    vi.spyOn(sink, 'disconnect').mockImplementation(() => { calls.push('disconnect'); });
    const setLayout = vi.spyOn(sink, 'setOutputLayout');
    vi.spyOn(audioEngine, 'connectV2LiveOutput').mockImplementation(async () => { calls.push('connect'); return true; });
    vi.spyOn(audioEngine, 'syncV2PatternsToLiveSink').mockImplementation(() => { calls.push('patterns'); });
    vi.spyOn(audioEngine, 'syncV2SamplesToLiveSink').mockImplementation(() => { calls.push('samples'); });
    vi.spyOn(audioEngine, 'syncV2SynthSourcesToLiveSink').mockImplementation(() => { calls.push('synth'); });
    vi.spyOn(sink, 'startTransport').mockImplementation(() => { calls.push('transport'); return true; });
    const internals = audioEngine as unknown as { isPlaying: boolean; stereoMode: '2.0' | '2.1' };
    const prev = { playing: internals.isPlaying, mode: internals.stereoMode };
    internals.isPlaying = true;
    try {
      audioEngine.setStereoMode('2.1');
      await vi.waitFor(() => expect(calls).toContain('transport'));
      expect(calls).toEqual(['disconnect', 'connect', 'patterns', 'samples', 'synth', 'transport']);
      // Kein nackter Reconnect über setOutputLayout (der die Abgriffe nicht nachzöge).
      expect(setLayout).not.toHaveBeenCalled();
      expect(audioEngine.getCaptureTransportStart()).toBeNull(); // Anker kommt neu aus dem Worklet
    } finally {
      internals.isPlaying = prev.playing;
      internals.stereoMode = prev.mode;
    }
  });
});

// ---------------------------------------------------------------------------
// Quantisierung am exakten Frame
// ---------------------------------------------------------------------------
function ev(time: number, kind: CaptureEvent['kind'] = 'trigger', extra: Partial<CaptureEvent> = {}): CaptureEvent {
  return { time, kind, track: 'channel1', note: -1, velocity: 1, ...extra };
}

describe('quantizeCapture · Worklet-Frame-Anker', () => {
  it('krummer Frame-Anker: Events auf dem echten Raster landen exakt, Näherung um 50 ms läge daneben', () => {
    const startSec = 100_037 / SR;
    const step = 0.125;
    const evs = [ev(startSec + 3 * step), ev(startSec + 16 * step + 10 * step)];
    const q = quantizeCapture(evs, 120, { transportStartSec: startSec });
    expect(q.gridStartSec).toBeCloseTo(startSec, 12);
    expect(q.bars[0].channel1[3]).toBe(true);
    expect(q.bars[1].channel1[10]).toBe(true);
    // Mit der alten Näherung (Anker ~60 ms später) rutscht Step 4 auf Step 3.
    const approx = quantizeCapture(evs, 120, { transportStartSec: startSec + 0.065 });
    expect(approx.bars[0].channel1[3]).toBe(false);
  });

  it('leicht verfrühter Downbeat (< 1/2 16tel vor dem Start) zählt als Step 1 von Takt 1', () => {
    const start = 10;
    expect(captureGridOrigin(start - 0.03, 120, start)).toBeCloseTo(start, 12);
    const q = quantizeCapture([ev(start - 0.03), ev(start + 0.5)], 120, { transportStartSec: start });
    expect(q.bars).toHaveLength(1);
    expect(q.bars[0].channel1[0]).toBe(true);
    expect(q.bars[0].channel1[4]).toBe(true);
    // Mehr als ein halbes 16tel vorher → Regel 2 (ohne Transport-Anker).
    expect(captureGridOrigin(start - 0.1, 120, start)).toBeCloseTo(9.875, 9);
  });

  it('Drum-Schläge: eigene Liste, doppelte Treffer je Step zusammengefasst (lauteste Velocity), Vorschlag zählt sie mit', () => {
    const q = quantizeCapture([
      ev(0.0, 'trigger'),
      ev(2.0, 'drum-pad', { kitId: 'tr-808', soundId: 'kick', velocity: 0.5 }),
      ev(2.01, 'drum-step', { kitId: 'tr-808', soundId: 'kick', velocity: 0.9 }),
      ev(2.25, 'drum-pad', { kitId: 'tr-808', soundId: 'chh', velocity: 0.7 }),
      ev(2.5, 'drum-pad', { kitId: '', soundId: 'kick' }), // unvollständig → ignoriert
    ], 120, { transportStartSec: 0 });
    expect(q.bars).toHaveLength(2);
    expect(q.suggestedBarIndex).toBe(1); // Takt 2 hat nur Drum-Schläge
    expect(q.drumHits).toEqual([
      { bar: 1, step: 0, kitId: 'tr-808', soundId: 'kick', velocity: 0.9 },
      { bar: 1, step: 2, kitId: 'tr-808', soundId: 'chh', velocity: 0.7 },
    ]);
    expect(q.bars[1].channel1.some(Boolean)).toBe(false);
  });
});
