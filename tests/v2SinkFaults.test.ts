// @vitest-environment node
/**
 * RT-AUDIT-P0-007: Fehlerpfad im Audio-Thread
 * ===========================================
 * Vorher: `v2SinkProcessor.process()` ohne try/catch, nirgends
 * `onprocessorerror`. Eine einzige Exception schaltete Chromium den Prozessor
 * dauerhaft ab – die gesamte DAW blieb stumm, ohne Meldung, ohne Wiederanlauf.
 *
 * Geprüft wird:
 *   - echter v2SinkProcessor (Worklet-Globals gestubbt): Exception im Render →
 *     Ausgang 0, genau EINE `render-error`-Meldung bei zwei Fehlern innerhalb
 *     einer Sekunde, nächster Block rendert normal; kaputte Nachricht →
 *     `message-error`, Port bleibt bedienbar.
 *   - V2ChannelStripGraph: unbekannter Kanal wirft nicht mehr.
 *   - V2LiveSink mit Fake-Node: `processorerror`/`render-error` → onFault.
 *   - Neuaufbau-Drosselung (3 pro 60 s, ≥ 50 render-errors in 2 s) als reine Logik.
 *   - audioEngine: processorerror → Neuaufbau mit vollständigem Zustandsabgleich.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { V2RenderFaultGuard, silenceOutputs, describeFault } from '../src/core/audio/live/V2RenderFaultGuard';
import { V2StudioGraph, type V2Channel } from '../src/core/audio/V2StudioGraph';
import { V2MonitorGraph } from '../src/core/audio/V2MonitorGraph';
import { V2LiveSink } from '../src/core/audio/backends/V2LiveSink';
import { defaultMonitorPlan } from '../src/core/audio/monitorRouting';
import {
  SinkRecoveryController,
  SinkRecoveryPolicy,
  type V2SinkFaultInfo,
} from '../src/core/audio/backends/sinkRecovery';
import { v2MasteringLookaheadSamples } from '../src/core/audio/live/v2Pdc';

const SR = 48000;
const N = 128;
/**
 * RT-AUDIT-P0-004: MAIN ist um den echten Mastering-Lookahead (240 Samples)
 * verzögert – ein Ton ist erst nach so vielen Blöcken am Ausgang messbar.
 */
const SETTLE_BLOCKS = Math.ceil(v2MasteringLookaheadSamples(SR) / N);

function rms(a: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * a[i];
  return Math.sqrt(sum / Math.max(1, a.length));
}

function filledOutput(value: number, channels = 2): Float32Array[] {
  return Array.from({ length: channels }, () => new Float32Array(N).fill(value));
}

// ---------------------------------------------------------------------------
// Echter v2SinkProcessor (AudioWorklet-Globals gestubbt, Vorbild v2VoicePool)
// ---------------------------------------------------------------------------
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

function createProcessor(): { p: ProcessorInstance; messages: Record<string, unknown>[] } {
  if (!Processor) throw new Error('v2SinkProcessor nicht geladen');
  const p = new Processor();
  const messages: Record<string, unknown>[] = [];
  p.port.postMessage = (m) => { messages.push(m); };
  return { p, messages };
}

/** Lässt `engine.render` des Prozessors werfen (Instanz-Override), `restore()` hebt es auf. */
function injectRenderFault(p: ProcessorInstance): { restore: () => void } {
  const engine = (p as unknown as { engine: Record<string, unknown> }).engine;
  engine.render = () => { throw new TypeError('injizierter Render-Fehler'); };
  return { restore: () => { delete engine.render; } };
}

describe('RT-AUDIT-P0-007: v2SinkProcessor überlebt Exceptions', () => {
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

  it('Exception im Render → Ausgang 0, genau eine Meldung bei zwei Fehlern < 1 s, nächster Block normal', () => {
    const { p, messages } = createProcessor();
    p.port.onmessage?.({ data: { type: 'test-tone', active: true, freq: 440, amplitude: 0.2 } });

    // Referenz: ohne Fehler ist der Testton hörbar (nach dem Mastering-Lookahead).
    for (let b = 0; b < SETTLE_BLOCKS; b++) {
      setFrame(b * N);
      p.process([], [filledOutput(0)]);
    }
    const t0 = SETTLE_BLOCKS * N;
    setFrame(t0);
    const ok0 = filledOutput(0);
    expect(p.process([], [ok0])).toBe(true);
    expect(rms(ok0[0])).toBeGreaterThan(1e-3);

    const fault = injectRenderFault(p);
    // Zwei Fehler innerhalb einer Sekunde Audio-Zeit (die beiden Folgeblöcke).
    const bad1 = filledOutput(0.5, 3);
    setFrame(t0 + N);
    expect(p.process([], [bad1])).toBe(true);
    const bad2 = filledOutput(0.5, 3);
    setFrame(t0 + 2 * N);
    expect(p.process([], [bad2])).toBe(true);
    for (const ch of [...bad1, ...bad2]) expect(ch.every((v) => v === 0)).toBe(true);

    const errors = messages.filter((m) => m.type === 'render-error');
    expect(errors).toHaveLength(1);
    expect(errors[0].count).toBe(1);
    expect(String(errors[0].message)).toContain('injizierter Render-Fehler');

    // Nächster Block ohne Fehler rendert wieder normal.
    fault.restore();
    const next = filledOutput(0);
    setFrame(t0 + 3 * N);
    expect(p.process([], [next])).toBe(true);
    expect(rms(next[0])).toBeGreaterThan(1e-3);
    expect(messages.filter((m) => m.type === 'render-error')).toHaveLength(1);
  });

  it('nach ≥ 1 s Audio-Zeit wird erneut gemeldet (mit kumuliertem Zähler)', () => {
    const { p, messages } = createProcessor();
    injectRenderFault(p);
    // 400 Blöcke à 128 Frames ≈ 1,07 s Dauerfehler.
    for (let b = 0; b < 400; b++) {
      setFrame(b * N);
      expect(p.process([], [filledOutput(0.3)])).toBe(true);
    }
    const errors = messages.filter((m) => m.type === 'render-error');
    expect(errors).toHaveLength(2);
    expect(errors[0].count).toBe(1);
    // Zweite Meldung genau beim ersten Block ≥ 1 s nach der ersten (Frame 48000 = Block 375).
    expect(errors[1].count).toBe(376);
  });

  it('kaputte Nachricht → message-error, Port bleibt bedienbar', () => {
    const { p, messages } = createProcessor();
    // Monitor-Plan ohne Struktur warf vorher ungefangen im Port-Handler.
    expect(() => p.port.onmessage?.({ data: { type: 'monitor-plan', plan: { kaputt: true } } })).not.toThrow();
    const errs = messages.filter((m) => m.type === 'message-error');
    expect(errs).toHaveLength(1);
    expect(errs[0].messageType).toBe('monitor-plan');
    expect(typeof errs[0].message).toBe('string');

    // Folgenachrichten wirken weiter, Render läuft. (Der kaputte Plan hatte den
    // Monitor-Gain bereits auf NaN gesetzt – ein gültiger Plan stellt ihn wieder her.)
    p.port.onmessage?.({ data: { type: 'monitor-plan', plan: defaultMonitorPlan() } });
    p.port.onmessage?.({ data: { type: 'test-tone', active: true, freq: 220, amplitude: 0.2 } });
    for (let b = 0; b < SETTLE_BLOCKS; b++) {
      setFrame(b * N);
      p.process([], [filledOutput(0)]);
    }
    const out = filledOutput(0);
    setFrame(SETTLE_BLOCKS * N);
    expect(p.process([], [out])).toBe(true);
    expect(rms(out[0])).toBeGreaterThan(1e-3);
    expect(messages.filter((m) => m.type === 'render-error')).toHaveLength(0);
  });

  it('unbekannter Kanal in gain-db/pan wirft weder im Port noch im Render', () => {
    const { p, messages } = createProcessor();
    p.port.onmessage?.({ data: { type: 'gain-db', channel: 'channel99', db: -6 } });
    p.port.onmessage?.({ data: { type: 'pan', channel: 'channel99', pan: 0.5 } });
    setFrame(0);
    expect(p.process([], [filledOutput(0)])).toBe(true);
    expect(messages.filter((m) => m.type === 'message-error' || m.type === 'render-error')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// V2RenderFaultGuard (reine Logik)
// ---------------------------------------------------------------------------
describe('RT-AUDIT-P0-007: V2RenderFaultGuard', () => {
  it('füllt alle Ausgänge/Kanäle mit 0 und toleriert Lücken', () => {
    const outputs = [filledOutput(1, 2), filledOutput(-1, 6)];
    silenceOutputs(outputs);
    for (const out of outputs) for (const ch of out) expect(ch.every((v) => v === 0)).toBe(true);
    expect(() => silenceOutputs([undefined as unknown as Float32Array[]])).not.toThrow();
    expect(() => silenceOutputs(null)).not.toThrow();
  });

  it('meldet den ersten Fehler sofort, danach höchstens 1×/s; Port-Fehler werfen nicht', () => {
    const guard = new V2RenderFaultGuard(SR);
    const sent: unknown[] = [];
    const port = { postMessage: (m: unknown) => { sent.push(m); } };
    guard.onRenderError(new Error('a'), [filledOutput(1)], 1000, port);
    guard.onRenderError(new Error('b'), [filledOutput(1)], 1000 + SR - 1, port);
    guard.onRenderError(new Error('c'), [filledOutput(1)], 1000 + SR, port);
    expect(guard.errorCount).toBe(3);
    expect(sent).toEqual([
      { type: 'render-error', message: 'Error: a', count: 1 },
      { type: 'render-error', message: 'Error: c', count: 3 },
    ]);
    const broken = { postMessage: () => { throw new Error('Port zu'); } };
    expect(() => guard.onRenderError('x', [filledOutput(1)], 0, broken)).not.toThrow();
    expect(() => guard.onMessageError(new Error('m'), 42, broken)).not.toThrow();
    expect(guard.messageErrorCount).toBe(1);
  });

  it('describeFault kürzt und wirft nie', () => {
    expect(describeFault(new RangeError('x'.repeat(500))).length).toBe(160);
    const evil = { toString() { throw new Error('nope'); } };
    expect(describeFault(evil)).toBe('unbekannter Fehler');
  });
});

// ---------------------------------------------------------------------------
// V2ChannelStripGraph: unbekannter Kanal wird ignoriert
// ---------------------------------------------------------------------------
describe('RT-AUDIT-P0-007: V2ChannelStripGraph ohne Non-Null-Assertion', () => {
  it.each([
    ['V2StudioGraph', () => new V2StudioGraph(SR, N)],
    ['V2MonitorGraph', () => new V2MonitorGraph(SR, N)],
  ])('%s: setSourceBuffer/setGainDb/setPan mit unbekanntem Kanal werfen nicht', (_name, make) => {
    const graph = make();
    const unknown = 'channel42' as V2Channel;
    expect(() => graph.setSourceBuffer(unknown, [new Float32Array(N)])).not.toThrow();
    expect(() => graph.setGainDb(unknown, -6)).not.toThrow();
    expect(() => graph.setPan(unknown, 0.3)).not.toThrow();
    // Bekannte Kanäle wirken weiterhin.
    const buffer = [new Float32Array(N).fill(0.25)];
    graph.setSourceBuffer('channel1', buffer);
    expect(graph.sources.get('channel1')?.sourceBuffer).toBe(buffer);
  });
});

// ---------------------------------------------------------------------------
// V2LiveSink mit Fake-AudioWorkletNode
// ---------------------------------------------------------------------------
type Listener = (ev: { data?: unknown }) => void;

class FakePort {
  onmessage: Listener | null = null;
  started = 0;
  readonly listeners = new Set<Listener>();
  readonly posted: unknown[] = [];
  postMessage(m: unknown): void { this.posted.push(m); }
  addEventListener(type: string, fn: Listener): void { if (type === 'message') this.listeners.add(fn); }
  removeEventListener(type: string, fn: Listener): void { if (type === 'message') this.listeners.delete(fn); }
  start(): void { this.started++; }
  emit(data: unknown): void {
    this.onmessage?.({ data });
    for (const fn of this.listeners) fn({ data });
  }
}

class FakeAudioWorkletNode {
  static created: FakeAudioWorkletNode[] = [];
  readonly port = new FakePort();
  onprocessorerror: ((ev?: { message?: string }) => void) | null = null;
  connected = true;
  constructor() { FakeAudioWorkletNode.created.push(this); }
  connect(): void { this.connected = true; }
  disconnect(): void { this.connected = false; }
}

function fakeContext(): AudioContext {
  return {
    audioWorklet: { addModule: vi.fn(async () => {}) },
    destination: {},
  } as unknown as AudioContext;
}

describe('RT-AUDIT-P0-007: V2LiveSink meldet Prozessor-Fehler an onFault', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeAudioWorkletNode.created = [];
  });

  it('processorerror, render-error und message-error erreichen onFault; step-Meldungen nicht', async () => {
    vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode);
    const faults: V2SinkFaultInfo[] = [];
    const sink = new V2LiveSink({ onFault: (info) => { faults.push(info); } });
    await expect(sink.connect(fakeContext())).resolves.toBe(true);
    const node = FakeAudioWorkletNode.created[0];
    // Kein Überschreiben von port.onmessage (Verkettung über addEventListener).
    expect(node.port.onmessage).toBeNull();
    expect(node.port.started).toBe(1);

    node.port.emit({ type: 'step', step: 0 });
    node.port.emit({ type: 'cpu-stats', blocks: 1 });
    expect(faults).toHaveLength(0);

    node.port.emit({ type: 'render-error', message: 'TypeError: x', count: 7 });
    node.port.emit({ type: 'message-error', messageType: 'monitor-plan', message: 'kaputt' });
    node.onprocessorerror?.({ message: 'Prozessor tot' });
    expect(faults).toEqual([
      { kind: 'render-error', message: 'TypeError: x', count: 7, messageType: undefined },
      { kind: 'message-error', message: 'kaputt', count: undefined, messageType: 'monitor-plan' },
      { kind: 'processorerror', message: 'Prozessor tot' },
    ]);
  });

  it('ein bereits vorhandener port.onmessage-Abnehmer bleibt erhalten', async () => {
    vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode);
    const faults: V2SinkFaultInfo[] = [];
    const sink = new V2LiveSink({ onFault: (info) => { faults.push(info); } });
    await sink.connect(fakeContext());
    const node = FakeAudioWorkletNode.created[0];
    const other = vi.fn();
    node.port.onmessage = other; // z. B. späterer step-/cpu-stats-Abnehmer
    node.port.emit({ type: 'render-error', message: 'm', count: 1 });
    expect(other).toHaveBeenCalledTimes(1);
    expect(faults).toHaveLength(1);
  });

  it('nach disconnect() meldet der alte Knoten nichts mehr; onFault-Fehler werfen nicht durch', async () => {
    vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode);
    const onFault = vi.fn(() => { throw new Error('UI kaputt'); });
    const sink = new V2LiveSink({ onFault });
    await sink.connect(fakeContext());
    const node = FakeAudioWorkletNode.created[0];
    const handler = node.onprocessorerror;
    expect(() => handler?.({ message: 'x' })).not.toThrow();
    expect(onFault).toHaveBeenCalledTimes(1);
    sink.disconnect();
    expect(node.onprocessorerror).toBeNull();
    expect(node.port.listeners.size).toBe(0);
    handler?.({ message: 'y' });
    node.port.emit({ type: 'render-error', message: 'z', count: 1 });
    expect(onFault).toHaveBeenCalledTimes(1);
  });

  it('Fake-Node löst processorerror aus → Neuaufbau erzeugt einen neuen Knoten', async () => {
    vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode);
    const ctx = fakeContext();
    let sink: V2LiveSink | null = null;
    const rebuild = vi.fn(async () => {
      sink!.disconnect();
      return sink!.connect(ctx);
    });
    const recovery = new SinkRecoveryController({ rebuild, log: () => {} });
    sink = new V2LiveSink({ onFault: (info) => { recovery.handleFault(info); } });
    await sink.connect(ctx);
    const first = FakeAudioWorkletNode.created[0];
    first.onprocessorerror?.({ message: 'tot' });
    await recovery.whenIdle();
    expect(rebuild).toHaveBeenCalledTimes(1);
    expect(FakeAudioWorkletNode.created).toHaveLength(2);
    expect(first.connected).toBe(false);
    expect(sink.isConnected).toBe(true);
    expect(recovery.status().state).toBe('recovered');
    // Spätere Meldungen des alten Knotens lösen nichts mehr aus.
    first.port.emit({ type: 'render-error', message: 'alt', count: 999 });
    expect(rebuild).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Neuaufbau-Drosselung (reine Logik)
// ---------------------------------------------------------------------------
const dead = (message = 'tot'): V2SinkFaultInfo => ({ kind: 'processorerror', message });
const renderErr = (count: number): V2SinkFaultInfo => ({ kind: 'render-error', message: 'x', count });

describe('RT-AUDIT-P0-007: SinkRecoveryPolicy', () => {
  it('processorerror → Neuaufbau; 4. Fehler in 60 s → kein weiterer Neuaufbau, Fehlerzustand', () => {
    const policy = new SinkRecoveryPolicy();
    expect(policy.onFault(dead(), 0)).toBe('rebuild');
    expect(policy.onFault(dead(), 10_000)).toBe('rebuild');
    expect(policy.onFault(dead(), 20_000)).toBe('rebuild');
    expect(policy.status(21_000).state).toBe('recovered');
    expect(policy.onFault(dead(), 59_000)).toBe('give-up');
    expect(policy.status(59_000).state).toBe('failed');
    // Fehlerzustand bleibt (bis Neuladen) – auch nach Ablauf des Fensters.
    expect(policy.onFault(dead(), 200_000)).toBe('ignore');
    expect(policy.status(500_000).state).toBe('failed');
    expect(policy.status(500_000).rebuilds).toBe(3);
  });

  it('Neuaufbauten außerhalb des 60-s-Fensters zählen nicht mit', () => {
    const policy = new SinkRecoveryPolicy();
    expect(policy.onFault(dead(), 0)).toBe('rebuild');
    expect(policy.onFault(dead(), 1_000)).toBe('rebuild');
    expect(policy.onFault(dead(), 2_000)).toBe('rebuild');
    expect(policy.onFault(dead(), 60_001)).toBe('rebuild');
    expect(policy.status(60_001 + 10_000).state).toBe('ok');
  });

  it('einzelne render-errors werden nur gezählt; ≥ 50 in 2 s → Neuaufbau', () => {
    const sporadic = new SinkRecoveryPolicy();
    expect(sporadic.onFault(renderErr(1), 0)).toBe('ignore');
    expect(sporadic.onFault(renderErr(20), 1_000)).toBe('ignore');
    expect(sporadic.onFault(renderErr(40), 2_500)).toBe('ignore'); // 20 + 20 im Fenster
    expect(sporadic.onFault(renderErr(60), 4_000)).toBe('ignore'); // 20 + 20 im Fenster
    expect(sporadic.status(4_000).renderErrors).toBe(60);
    expect(sporadic.status(4_000).state).toBe('ok');

    // Dauerfehler: Prozessor meldet 1, nach 1 s den kumulierten Zähler 376.
    const persistent = new SinkRecoveryPolicy();
    expect(persistent.onFault(renderErr(1), 0)).toBe('ignore');
    expect(persistent.onFault(renderErr(376), 1_000)).toBe('rebuild');
    // Neuer Prozessor zählt wieder ab 1.
    expect(persistent.onFault(renderErr(1), 1_500)).toBe('ignore');
  });

  it('message-error löst nie einen Neuaufbau aus', () => {
    const policy = new SinkRecoveryPolicy();
    for (let i = 0; i < 100; i++) {
      expect(policy.onFault({ kind: 'message-error', message: 'm', messageType: 'pan' }, i)).toBe('ignore');
    }
    expect(policy.status(100).messageErrors).toBe(100);
  });
});

describe('RT-AUDIT-P0-007: SinkRecoveryController', () => {
  it('Neuaufbau seriell; Fehler während des Neuaufbaus stoßen keinen zweiten an', async () => {
    let release: (ok: boolean) => void = () => {};
    const rebuild = vi.fn(() => new Promise<boolean>((resolve) => { release = resolve; }));
    let now = 0;
    const recovery = new SinkRecoveryController({ rebuild, now: () => now, log: () => {} });
    expect(recovery.handleFault(dead())).toBe('rebuild');
    expect(recovery.isRebuilding).toBe(true);
    expect(recovery.handleFault(dead())).toBe('ignore');
    expect(recovery.handleFault(renderErr(500))).toBe('ignore');
    release(true);
    await recovery.whenIdle();
    expect(rebuild).toHaveBeenCalledTimes(1);
    now = 1_000;
    expect(recovery.status().state).toBe('recovered');
    now = 20_000;
    expect(recovery.status().state).toBe('ok');
  });

  it('4. processorerror in 60 s ruft keinen Neuaufbau mehr auf', async () => {
    const rebuild = vi.fn(async () => true);
    let now = 0;
    const recovery = new SinkRecoveryController({ rebuild, now: () => now, log: () => {} });
    for (let i = 0; i < 4; i++) {
      now = i * 5_000;
      recovery.handleFault(dead());
      await recovery.whenIdle();
    }
    expect(rebuild).toHaveBeenCalledTimes(3);
    expect(recovery.status().state).toBe('failed');
  });

  it('gescheiterter Neuaufbau (connect false oder Exception) → Fehlerzustand', async () => {
    const failing = new SinkRecoveryController({ rebuild: async () => false, log: () => {} });
    failing.handleFault(dead());
    await failing.whenIdle();
    expect(failing.status().state).toBe('failed');

    const throwing = new SinkRecoveryController({ rebuild: async () => { throw new Error('addModule'); }, log: () => {} });
    throwing.handleFault(dead());
    await throwing.whenIdle();
    expect(throwing.status().state).toBe('failed');
  });
});

// ---------------------------------------------------------------------------
// audioEngine: processorerror → Neuaufbau mit vollständigem Zustandsabgleich
// ---------------------------------------------------------------------------
describe('RT-AUDIT-P0-007: audioEngine baut den V2-Sink nach processorerror neu auf', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('disconnect → connectV2LiveOutput → Patterns/Samples/Synth-Quellen → Transport läuft weiter', async () => {
    const { audioEngine } = await import('../src/utils/audioEngine');
    const calls: string[] = [];
    const sink = audioEngine.v2LiveSink;
    vi.spyOn(sink, 'disconnect').mockImplementation(() => { calls.push('disconnect'); });
    vi.spyOn(audioEngine, 'connectV2LiveOutput').mockImplementation(async () => { calls.push('connect'); return true; });
    vi.spyOn(audioEngine, 'syncV2PatternsToLiveSink').mockImplementation(() => { calls.push('patterns'); });
    vi.spyOn(audioEngine, 'syncV2SamplesToLiveSink').mockImplementation(() => { calls.push('samples'); });
    vi.spyOn(audioEngine, 'syncV2SynthSourcesToLiveSink').mockImplementation(() => { calls.push('synth'); });
    vi.spyOn(sink, 'startTransport').mockImplementation(() => { calls.push('transport'); return true; });

    const internals = audioEngine as unknown as { isPlaying: boolean; v2SinkRecovery: SinkRecoveryController };
    const wasPlaying = internals.isPlaying;
    internals.isPlaying = true;
    try {
      expect(audioEngine.getV2SinkRecoveryStatus().state).toBe('ok');
      sink.onFault?.({ kind: 'processorerror', message: 'Prozessor tot' });
      await internals.v2SinkRecovery.whenIdle();
      expect(calls).toEqual(['disconnect', 'connect', 'patterns', 'samples', 'synth', 'transport']);
      expect(audioEngine.getV2SinkRecoveryStatus().state).toBe('recovered');

      // Einzelne render-errors: nur zählen, kein Neuaufbau.
      calls.length = 0;
      sink.onFault?.({ kind: 'render-error', message: 'x', count: 1 });
      await internals.v2SinkRecovery.whenIdle();
      expect(calls).toEqual([]);
    } finally {
      internals.isPlaying = wasPlaying;
    }
  });
});
