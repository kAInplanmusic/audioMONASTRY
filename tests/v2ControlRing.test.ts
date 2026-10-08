// @vitest-environment node
/**
 * RT-AUDIT-P1-010 (Schritt 2): lock-freier SPSC-Steuer-Ring im SharedArrayBuffer
 * ===========================================================================
 * Geprüft wird:
 *   - 10.000 Nachrichten Produzent/Konsument (verschränkt) ohne Verlust und in
 *     Reihenfolge; Überlauf wird gezählt (nicht still verworfen).
 *   - Konsum (`peek`/`advance`) allokationsfrei (Heap-Differenz nach Aufwärmen).
 *   - V2LiveSink: Ring per Feature-Detect (ohne crossOriginIsolated aus),
 *     erzwungen an → gain/pan/mute/master/trigger laufen über den Ring, nicht
 *     über postMessage; Überlauf → Rückfall auf postMessage.
 *   - echter Prozessor: Ring-Datensätze warten auf ihre Port-Vorgänger
 *     (Trigger erst nach `sample-assign`), und Port-Nachrichten wenden zuvor
 *     geschriebene Ring-Datensätze zuerst an (Trigger → Stop bleibt Stop).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getHeapStatistics } from 'node:v8';
import {
  CONTROL_FIELD,
  CONTROL_OP,
  CONTROL_RECORD_WORDS,
  ControlRing,
  portSeqReached,
  sharedMemoryAvailable,
} from '../src/core/audio/live/controlRing';
import { V2LiveSink } from '../src/core/audio/backends/V2LiveSink';

const SR = 48000;
const N = 128;

describe('ControlRing (SPSC, Atomics)', () => {
  it('10.000 Nachrichten verschränkt ohne Verlust, in Reihenfolge, ohne Überlauf', () => {
    const ring = ControlRing.create(64);
    const rec = new Float64Array(CONTROL_RECORD_WORDS);
    let produced = 0;
    let consumed = 0;
    let burst = 1;
    while (consumed < 10_000) {
      // Produzent: Burst variabler Größe (bis knapp unter Kapazität).
      for (let k = 0; k < burst && produced < 10_000; k++) {
        if (!ring.push(CONTROL_OP.GAIN_DB, produced % 8, produced, produced, -produced, 0.5)) break;
        produced++;
      }
      burst = (burst * 7 + 3) % 61 + 1;
      // Konsument: alles Anstehende lesen.
      while (ring.peek(rec)) {
        expect(rec[CONTROL_FIELD.OP]).toBe(CONTROL_OP.GAIN_DB);
        expect(rec[CONTROL_FIELD.CHANNEL]).toBe(consumed % 8);
        expect(rec[CONTROL_FIELD.SEQ]).toBe(consumed);
        expect(rec[CONTROL_FIELD.A]).toBe(consumed);
        expect(rec[CONTROL_FIELD.B]).toBe(-consumed);
        expect(rec[CONTROL_FIELD.C]).toBe(0.5);
        ring.advance();
        consumed++;
      }
    }
    expect(produced).toBe(10_000);
    expect(consumed).toBe(10_000);
    expect(ring.overflowCount).toBe(0);
    expect(ring.size).toBe(0);
  });

  it('Überlauf: voller Ring lehnt ab und zählt; nichts Gelesenes geht verloren', () => {
    const ring = ControlRing.create(8); // 7 nutzbare Plätze
    let ok = 0;
    for (let i = 0; i < 10; i++) if (ring.push(CONTROL_OP.PAN, 1, 0, i)) ok++;
    expect(ok).toBe(7);
    expect(ring.overflowCount).toBe(3);
    const rec = new Float64Array(CONTROL_RECORD_WORDS);
    const got: number[] = [];
    while (ring.peek(rec)) { got.push(rec[CONTROL_FIELD.A]); ring.advance(); }
    expect(got).toEqual([0, 1, 2, 3, 4, 5, 6]);
    // Nach dem Leeren wieder Platz.
    expect(ring.push(CONTROL_OP.PAN, 1, 0, 99)).toBe(true);
  });

  it('zweite Sicht auf dieselben SharedArrayBuffer (Konsument via attach) sieht die Daten', () => {
    const producer = ControlRing.create(16);
    const consumer = ControlRing.attach(producer.buffers);
    producer.push(CONTROL_OP.MASTER_GAIN, 0, 3, 0.75);
    const rec = new Float64Array(CONTROL_RECORD_WORDS);
    expect(consumer.peek(rec)).toBe(true);
    expect(rec[CONTROL_FIELD.A]).toBe(0.75);
    consumer.advance();
    expect(producer.size).toBe(0);
  });

  it('Konsum ist allokationsfrei (Heap-Differenz bei 10.000 Nachrichten nahe 0)', () => {
    const ring = ControlRing.create(10_001);
    const rec = new Float64Array(CONTROL_RECORD_WORDS);
    const acc = new Float64Array(1); // kein Closure-Double (würde HeapNumbers erzeugen)
    const consumeAll = (): void => {
      while (ring.peek(rec)) {
        acc[0] += rec[CONTROL_FIELD.A];
        ring.advance();
      }
    };
    const fill = (n: number): void => {
      for (let i = 0; i < n; i++) ring.push(CONTROL_OP.GAIN_DB, i & 7, i, i);
    };
    // Aufwärmen (JIT), dann 10.000 Datensätze vorab schreiben und NUR den Konsum messen.
    // Der ERSTE getHeapStatistics()-Aufruf initialisiert intern ~18 KB – mit aufwärmen.
    for (let r = 0; r < 50; r++) { fill(1000); consumeAll(); getHeapStatistics(); }
    fill(10_000);
    expect(ring.size).toBe(10_000);
    const before = getHeapStatistics().used_heap_size;
    consumeAll();
    const after = getHeapStatistics().used_heap_size;
    expect(ring.size).toBe(0);
    expect(acc[0]).toBeGreaterThan(0);
    // Ein Objekt pro Nachricht wären ≥ 10.000 × 16 B = 160 KB; gemessen bleibt nur
    // der feste Eigenbedarf von getHeapStatistics() (~0,6–1 KB).
    expect(after - before).toBeLessThan(8 * 1024);
  });

  it('portSeqReached ist wrap-sicher (Int32)', () => {
    expect(portSeqReached(5, 5)).toBe(true);
    expect(portSeqReached(5, 6)).toBe(false);
    expect(portSeqReached(0x7fffffff, 0x7fffffff)).toBe(true);
    expect(portSeqReached((0x7fffffff + 2) | 0, 0x7fffffff)).toBe(true);
  });

  it('Feature-Detect: ohne crossOriginIsolated kein Ring', () => {
    expect((globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated).not.toBe(true);
    expect(sharedMemoryAvailable()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// V2LiveSink mit Ring + echter Prozessor
// ---------------------------------------------------------------------------
type Msg = Record<string, unknown> & { type: string };

/** Port, der Nachrichten zurückhält, bis `flush()` – wie eine verzögerte Event-Loop. */
class QueuedPort {
  readonly posted: Msg[] = [];
  private queue: Msg[] = [];
  deliver: ((data: Msg) => void) | null = null;
  postMessage(message: Msg, transfer?: Transferable[]): void {
    const data = transfer && transfer.length > 0
      ? structuredClone(message, { transfer }) as Msg
      : message;
    this.posted.push(data);
    this.queue.push(data);
  }
  flush(): void {
    const q = this.queue;
    this.queue = [];
    for (const m of q) this.deliver?.(m);
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  start(): void {}
}

class FakeNode {
  static created: FakeNode[] = [];
  readonly port = new QueuedPort();
  onprocessorerror: unknown = null;
  constructor() { FakeNode.created.push(this); }
  connect(): void {}
  disconnect(): void {}
}

function fakeContext(): AudioContext {
  return { audioWorklet: { addModule: vi.fn(async () => {}) }, destination: {} } as unknown as AudioContext;
}

interface ProcessorInstance {
  port: { onmessage: ((e: { data?: unknown }) => void) | null; postMessage: (m: Record<string, unknown>) => void };
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}
type ProcessorCtor = new () => ProcessorInstance;
let Processor: ProcessorCtor | null = null;
let frame = 0;

function renderPeak(p: ProcessorInstance, blocks: number): number {
  const g = globalThis as unknown as Record<string, number>;
  let peak = 0;
  for (let b = 0; b < blocks; b++) {
    g.currentFrame = frame;
    g.currentTime = frame / SR;
    frame += N;
    const out = [new Float32Array(N), new Float32Array(N)];
    p.process([], [out]);
    for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(out[0][i]));
  }
  return peak;
}

function tone(frames: number): Float32Array {
  const a = new Float32Array(frames);
  for (let i = 0; i < frames; i++) a[i] = 0.5 * Math.sin(i * 0.07);
  return a;
}

describe('RT-AUDIT-P1-010 (Schritt 2): V2LiveSink + v2SinkProcessor über den Steuer-Ring', () => {
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
    expect(Processor).not.toBeNull();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    FakeNode.created = [];
  });

  async function setup(controlRing: boolean): Promise<{ sink: V2LiveSink; port: QueuedPort; p: ProcessorInstance; errors: Msg[] }> {
    vi.stubGlobal('AudioWorkletNode', FakeNode);
    const sink = new V2LiveSink({ controlRing });
    await expect(sink.connect(fakeContext())).resolves.toBe(true);
    const port = FakeNode.created[FakeNode.created.length - 1].port;
    const p = new Processor!();
    const errors: Msg[] = [];
    p.port.postMessage = (m) => { if (m.type === 'render-error' || m.type === 'message-error') errors.push(m as Msg); };
    port.deliver = (data) => p.port.onmessage?.({ data });
    port.flush();
    return { sink, port, p, errors };
  }

  it('Default (ohne crossOriginIsolated): kein Ring, Steuerdaten per postMessage', async () => {
    vi.stubGlobal('AudioWorkletNode', FakeNode);
    const sink = new V2LiveSink();
    await sink.connect(fakeContext());
    const port = FakeNode.created[0].port;
    expect(sink.controlRingStats.active).toBe(false);
    expect(port.posted.map((m) => m.type)).not.toContain('control-ring');
    sink.setChannelGainDb('channel1', -6);
    expect(port.posted.map((m) => m.type)).toContain('gain-db');
  });

  it('Ring an: gain/pan/mute/master/trigger gehen NICHT über postMessage', async () => {
    const { sink, port } = await setup(true);
    expect(sink.controlRingStats.active).toBe(true);
    expect(port.posted.map((m) => m.type)).toEqual(['output-layout', 'control-ring']);
    port.posted.length = 0;
    sink.setChannelGainDb('channel1', -6);
    sink.setChannelPan('channel1', 0.3);
    sink.setChannelMuted('channel2', true);
    sink.setMasterGain(0.8);
    sink.synthTrigger('channel3', 0.9);
    sink.triggerSample('channel1', { rate: 1 });
    expect(port.posted).toEqual([]);
    expect(sink.controlRingStats.pending).toBe(6);
  });

  it('Trigger wartet auf sample-assign (Port) – kein verlorener erster Schlag', async () => {
    const { sink, port, p, errors } = await setup(true);
    expect(sink.loadSample('a', tone(24000))).toBe(true);
    expect(sink.assignSample('channel1', 'a')).toBe(true);
    expect(sink.triggerSample('channel1')).toBe(true);
    // Port-Nachrichten noch NICHT zugestellt: Block rendert still, Trigger bleibt im Ring.
    expect(renderPeak(p, 2)).toBe(0);
    expect(sink.controlRingStats.pending).toBe(1);
    port.flush();
    expect(renderPeak(p, 4)).toBeGreaterThan(0.05);
    expect(sink.controlRingStats.pending).toBe(0);
    expect(errors).toEqual([]);
  });

  it('Reihenfolge Ring → Port bleibt erhalten: Trigger, dann Stop = still', async () => {
    const { sink, port, p } = await setup(true);
    sink.loadSample('a', tone(24000));
    sink.assignSample('channel1', 'a');
    port.flush();
    sink.triggerSample('channel1'); // Ring
    sink.stopSample('channel1');    // Port
    port.flush();                   // Port-Handler wendet zuerst den Trigger an, dann Stop
    expect(renderPeak(p, 4)).toBe(0);
  });

  it('Synth-Trigger und Mute über den Ring wirken im Prozessor', async () => {
    const { sink, p } = await setup(true);
    sink.synthTrigger('channel5', 1);
    expect(renderPeak(p, 8)).toBeGreaterThan(1e-3);
    sink.setChannelMuted('channel5', true);
    renderPeak(p, 4); // Ausblenden
    sink.synthTrigger('channel5', 1);
    // Stummer Kanal: Synth-Trigger erklingt nicht (Mute-Parität wie per Port).
    const muted = renderPeak(p, 8);
    sink.setChannelMuted('channel5', false);
    expect(muted).toBeLessThan(1e-6);
  });

  it('Ring voll → Überlauf gezählt, Nachricht per postMessage zugestellt (nicht verloren)', async () => {
    const { sink, port } = await setup(true);
    port.posted.length = 0;
    // Default-Kapazität 4096 → 4095 Plätze; ohne Konsum laufen weitere über.
    for (let i = 0; i < 4100; i++) sink.setChannelGainDb('channel1', -i / 100);
    expect(sink.controlRingStats.overflow).toBe(5);
    expect(port.posted.filter((m) => m.type === 'gain-db')).toHaveLength(5);
  });
});
