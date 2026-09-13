// @vitest-environment node
/**
 * Phase 2: Funktionaler Test des echten v2SinkProcessor-Worklets.
 * ------------------------------------------------------------------
 * Stubt AudioWorklet-Globals (sampleRate/currentFrame/currentTime,
 * AudioWorkletProcessor, registerProcessor) und führt den echten Processor
 * deterministisch aus:
 *   * V2SampleClock-Step-Events werden sample-genau an den Main-Thread gemeldet
 *   * Aktive Patterns erzeugen im selben Render-Quantum einen hörbaren Burst
 *     (Start exakt am Step-Sample, nicht Block-gerundet)
 */
import { beforeAll, describe, expect, it } from 'vitest';

interface StepMsg {
  type: string;
  step: number;
  time: number;
  swing: number;
  gate: number;
  secondsPerStep: number;
}

interface PortLike {
  onmessage: ((e: { data?: Record<string, unknown> }) => void) | null;
  postMessage: (msg: StepMsg | Record<string, unknown>) => void;
}

interface ProcessorInstance {
  port: PortLike;
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}

type ProcessorCtor = new (options?: { processorOptions?: Record<string, unknown> }) => ProcessorInstance;

const SR = 48000;
const QUANTUM = 128;

let ProcessorCtor: ProcessorCtor | null = null;
let messages: StepMsg[] = [];

beforeAll(async () => {
  const g = globalThis as unknown as Record<string, unknown>;
  g.sampleRate = SR;
  g.currentFrame = 0;
  g.currentTime = 0;
  g.AudioWorkletProcessor = class {
    port = {
      onmessage: null as unknown as PortLike['onmessage'],
      postMessage: () => {},
    };
  };
  g.registerProcessor = (_name: string, ctor: ProcessorCtor) => {
    ProcessorCtor = ctor;
  };

  await import('../src/audio/worklets/v2SinkProcessor.ts');
  expect(ProcessorCtor).not.toBeNull();
});

function createProcessor(): ProcessorInstance {
  if (!ProcessorCtor) throw new Error('v2SinkProcessor nicht geladen');
  messages = [];
  const p = new ProcessorCtor();
  (p.port as unknown as { postMessage: (m: StepMsg) => void }).postMessage = (m) => {
    messages.push(m as StepMsg);
  };
  return p;
}

function createMeasuredProcessor(): ProcessorInstance {
  if (!ProcessorCtor) throw new Error('v2SinkProcessor nicht geladen');
  messages = [];
  // PERF-P3-001/002: die Messung ist opt-in – hier explizit einschalten.
  const p = new ProcessorCtor({ processorOptions: { measure: true } });
  (p.port as unknown as { postMessage: (m: StepMsg) => void }).postMessage = (m) => {
    messages.push(m as StepMsg);
  };
  return p;
}

function runBlock(p: ProcessorInstance, frame: number): Float32Array[] {
  const g = globalThis as unknown as Record<string, number>;
  g.currentFrame = frame;
  g.currentTime = frame / SR;
  const output = [new Float32Array(QUANTUM), new Float32Array(QUANTUM)];
  const ok = p.process([], [output]);
  expect(ok).toBe(true);
  return output;
}

describe('v2SinkProcessor (Phase 2 – AudioWorklet-Scheduler)', () => {
  it('120 BPM: meldet Step-Events sample-genau bei Frame 6000, 12000, …', () => {
    const p = createProcessor();
    p.port.onmessage?.({ data: { type: 'pattern', channel: 'channel1', steps: Array(16).fill(false) } });
    p.port.onmessage?.({ data: { type: 'transport', playing: true, bpm: 120, swing: 0, gate: 0.9, stepCount: 16 } });

    for (let b = 0; b < 120; b++) runBlock(p, b * QUANTUM);

    expect(messages.length).toBeGreaterThanOrEqual(2);
    expect(messages[0]).toMatchObject({ type: 'step', step: 0 });
    expect(Math.abs(messages[0].time - 6000 / SR)).toBeLessThan(1e-9);
    expect(messages[1].step).toBe(1);
    expect(Math.abs(messages[1].time - messages[0].time - 6000 / SR)).toBeLessThan(1e-9);
  });

  it('aktives Pattern erzeugt den Burst exakt ab dem Step-Sample im Block', () => {
    const p = createProcessor();
    const pattern = Array(16).fill(false);
    pattern[0] = true;
    p.port.onmessage?.({ data: { type: 'pattern', channel: 'channel1', steps: pattern } });
    p.port.onmessage?.({ data: { type: 'transport', playing: true, bpm: 120, swing: 0, gate: 0.9, stepCount: 16 } });

    // 46 Blöcke (46*128 = 5888) → Step 0 liegt bei Frame 6000 im 47. Block (Offset 112).
    for (let b = 0; b < 46; b++) runBlock(p, b * QUANTUM);
    const output = runBlock(p, 46 * QUANTUM);

    // Vor Sample 112 im Block ist Stille; ab 112 (Sinus-Nulldurchgang am
    // Step-Sample) folgt unmittelbar der Burst.
    for (let i = 0; i < 112; i++) {
      expect(Math.abs(output[0][i])).toBeLessThan(1e-7);
    }
    const burst = output[0].subarray(112);
    expect(burst.some((v) => Math.abs(v) > 0.01)).toBe(true);
  });
});

/**
 * PERF-P3-002: Die Max-Blockzeit laesst sich im AudioWorklet nicht ueber
 * `performance` messen (im Worklet-Scope nicht exponiert, per Spec). Massgeblich
 * ist deshalb der Audio-Frame-Zaehler: ein Sprung um mehr als einen Quantum
 * bedeutet eine verpasste Deadline. Das ist aufloesungsunabhaengig – anders als
 * `Date.now()` mit 1 ms Raster, wo selbst ein 10-ms-"Max" nur ein Artefakt war.
 *
 * Das Gate selbst (scripts/worklet-cpu-gate.cjs) ist ein manuelles Skript und
 * laeuft nicht im CI; diese Tests sind deshalb der Regressionsschutz.
 */
describe('v2SinkProcessor (PERF-P3-002 – Deadline-Treue ueber currentFrame)', () => {
  const stats = (): Record<string, number>[] =>
    messages.filter((m) => m.type === 'cpu-stats') as unknown as Record<string, number>[];

  it('meldet lueckenlose Bloecke als 0 verpasste Quanten', () => {
    const p = createMeasuredProcessor();
    for (let b = 0; b < 250; b++) runBlock(p, b * QUANTUM);

    const reports = stats();
    // Erster Block meldet sofort, danach bei jedem 250. Block.
    expect(reports.length).toBeGreaterThanOrEqual(2);
    const last = reports[reports.length - 1];
    expect(last.blocks).toBe(250);
    expect(last.missedQuanta).toBe(0);
    expect(last.maxGapQuanta).toBe(1);
    expect(last.stallEvents).toBe(0);
    expect(last.quantumFrames).toBe(QUANTUM);
  });

  it('zaehlt eine uebersprungene Quantengrenze als verpasste Deadline', () => {
    const p = createMeasuredProcessor();
    runBlock(p, 0); // Block 1: erster Bericht, noch keine Vergleichsbasis
    runBlock(p, 2 * QUANTUM); // Luecke von zwei Quanten -> eine verpasst
    for (let b = 3; b <= 250; b++) runBlock(p, b * QUANTUM);

    const reports = stats();
    const last = reports[reports.length - 1];
    expect(last.blocks).toBe(250);
    expect(last.missedQuanta).toBe(1);
    expect(last.maxGapQuanta).toBe(2);
    expect(last.stallEvents).toBe(1);
  });

  it('misst ohne measure:true gar nicht (kein Aufwand im Betrieb)', () => {
    const p = createProcessor();
    for (let b = 0; b < 30; b++) runBlock(p, b * QUANTUM);
    expect(stats().length).toBe(0);
    // Der Scheduler laeuft trotzdem normal weiter.
    expect(messages.every((m) => m.type === 'step')).toBe(true);
  });
});
