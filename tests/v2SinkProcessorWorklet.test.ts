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
import { v2MasteringLookaheadSamples } from '../src/core/audio/live/v2Pdc';
import { V2SampleClock, type V2ScheduledStep } from '../src/core/audio/live/V2SampleClock';

interface StepMsg {
  type: string;
  step: number;
  /** RT-AUDIT-P0-004-F1: hörbarer Onset-Frame (Scheduler-Frame + Lookahead). */
  frame: number;
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

/** RT-AUDIT-P0-005: der Prozessor meldet zuerst seinen Mess-SAB – Step-Filter. */
function steps(): StepMsg[] {
  return messages.filter((m) => m.type === 'step');
}

describe('v2SinkProcessor (Phase 2 – AudioWorklet-Scheduler)', () => {
  it('120 BPM: meldet Step-Events sample-genau bei Frame 6000, 12000, …', () => {
    const p = createProcessor();
    p.port.onmessage?.({ data: { type: 'pattern', channel: 'channel1', steps: Array(16).fill(false) } });
    p.port.onmessage?.({ data: { type: 'transport', playing: true, bpm: 120, swing: 0, gate: 0.9, stepCount: 16 } });

    for (let b = 0; b < 120; b++) runBlock(p, b * QUANTUM);

    const sm = steps();
    expect(sm.length).toBeGreaterThanOrEqual(2);
    expect(sm[0]).toMatchObject({ type: 'step', step: 0 });
    // RT-AUDIT-P0-004-F1: `time`/`frame` sind auf den HÖRBAREN Onset gestempelt
    // (Scheduler-Frame + Mastering-Lookahead), nicht mehr auf den rohen
    // Scheduler-Frame.
    const look = v2MasteringLookaheadSamples(SR);
    expect(sm[0].frame).toBe(6000 + look);
    expect(Math.abs(sm[0].time - (6000 + look) / SR)).toBeLessThan(1e-9);
    expect(sm[1].step).toBe(1);
    expect(sm[1].frame - sm[0].frame).toBe(6000);
    expect(Math.abs(sm[1].time - sm[0].time - 6000 / SR)).toBeLessThan(1e-9);
  });

  it('aktives Pattern erzeugt den Burst exakt ab dem Step-Sample im Block', () => {
    const p = createProcessor();
    const pattern = Array(16).fill(false);
    pattern[0] = true;
    p.port.onmessage?.({ data: { type: 'pattern', channel: 'channel1', steps: pattern } });
    p.port.onmessage?.({ data: { type: 'transport', playing: true, bpm: 120, swing: 0, gate: 0.9, stepCount: 16 } });

    // Step 0 liegt bei Frame 6000. RT-AUDIT-P0-004: MAIN läuft durch den
    // Mastering-Limiter mit ECHTEM Lookahead (240 Samples @ 48 kHz) – der Burst
    // erscheint sample-genau bei 6000 + 240 = 6240 (49. Block, Offset 96).
    const outFrame = 6000 + v2MasteringLookaheadSamples(SR);
    const block = Math.floor(outFrame / QUANTUM);
    const offset = outFrame - block * QUANTUM;
    for (let b = 0; b < block; b++) {
      const before = runBlock(p, b * QUANTUM);
      expect(before[0].every((v) => Math.abs(v) < 1e-7)).toBe(true);
    }
    const output = runBlock(p, block * QUANTUM);

    // Vor dem Offset im Block ist Stille; ab dem Offset (Sinus-Nulldurchgang am
    // Step-Sample) folgt unmittelbar der Burst.
    for (let i = 0; i < offset; i++) {
      expect(Math.abs(output[0][i])).toBeLessThan(1e-7);
    }
    const burst = output[0].subarray(offset);
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
    // Ohne Transport laufen keine Steps; der Prozessor meldet aber einmalig
    // seinen Mess-SAB (RT-AUDIT-P0-005) – und nichts anderes.
    expect(messages.filter((m) => m.type === 'meter-sab').length).toBe(1);
    expect(messages.every((m) => m.type === 'meter-sab')).toBe(true);
  });
});

/**
 * RT-AUDIT-P0-004-F1: Der hörbare Onset eines Step-Bursts liegt um den
 * Mastering-Lookahead HINTER dem Scheduler-Frame (die Masterkette verzögert das
 * Signal real). Die Step-Meldung an den Main-Thread muss exakt diesen hörbaren
 * Frame tragen (Variante A: Audio-Zeitachse unverändert, nur der gemeldete
 * Zeitstempel wird vorgezogen) – sonst liegen UI-Lauflicht/Capture 5 ms vor dem
 * Ton. Geprüft bei 44,1/48/96 kHz: gemeldeter Frame == Scheduler-Frame + L und
 * == nachweisbarer Onset im Ausgang (±0 Samples).
 */
describe('v2SinkProcessor (RT-AUDIT-P0-004-F1 – Step-Meldung auf hörbarem Onset)', () => {
  for (const rate of [44100, 48000, 96000]) {
    it(`${rate} Hz: gemeldeter Frame == hörbarer Onset (±0 Samples)`, () => {
      const g = globalThis as unknown as Record<string, number>;
      g.sampleRate = rate;
      messages = [];
      const p = new ProcessorCtor!();
      (p.port as unknown as { postMessage: (m: StepMsg) => void }).postMessage = (m) => { messages.push(m as StepMsg); };

      const pattern = Array(16).fill(false);
      pattern[0] = true;
      p.port.onmessage?.({ data: { type: 'pattern', channel: 'channel1', steps: pattern } });
      p.port.onmessage?.({ data: { type: 'transport', playing: true, bpm: 120, swing: 0, gate: 0.9, stepCount: 16 } });

      // Unabhängige Referenz: derselbe Scheduler ohne Lookahead-Stempel liefert
      // den rohen Scheduler-Frame des ersten Steps.
      const refClock = new V2SampleClock({ sampleRate: rate, stepCount: 16, bpm: 120, swing: 0, gate: 0.9 });
      refClock.playing = true;
      const refOut: V2ScheduledStep[] = [];
      let schedulerFrame = -1;
      const look = v2MasteringLookaheadSamples(rate);
      const maxBlocks = Math.ceil((rate * 0.125 + look) / QUANTUM) + 4;

      let onsetBlockOutput: Float32Array | null = null;
      for (let b = 0; b < maxBlocks; b++) {
        g.currentFrame = b * QUANTUM;
        g.currentTime = (b * QUANTUM) / rate;
        const out = [new Float32Array(QUANTUM), new Float32Array(QUANTUM)];
        expect(p.process([], [out])).toBe(true);

        // Referenz-Scheduler über denselben Blockbereich mitlaufen lassen.
        if (schedulerFrame < 0 && refClock.processBlockInto(b * QUANTUM, QUANTUM, refOut) > 0) {
          schedulerFrame = refOut[0].frame;
        }

        if (steps().length > 0 && schedulerFrame >= 0) {
          const reported = steps()[0].frame;
          const block = Math.floor(reported / QUANTUM);
          if (b === block) { onsetBlockOutput = out[0]; break; }
        }
      }

      expect(steps()[0]).toMatchObject({ type: 'step', step: 0 });
      expect(schedulerFrame).toBeGreaterThan(0);
      // (1) Stempel ist exakt Scheduler-Frame + Lookahead.
      expect(steps()[0].frame).toBe(schedulerFrame + look);
      // (2) In genau diesem Block liegt der Onset an derselben Stelle:
      //     davor Stille, ab dem gemeldeten Frame Signal (sample-genau, ±0).
      expect(onsetBlockOutput).not.toBeNull();
      const reported = steps()[0].frame;
      const block = Math.floor(reported / QUANTUM);
      const offset = reported - block * QUANTUM;
      const out = onsetBlockOutput!;
      expect(block).toBeGreaterThan(0);
      for (let i = 0; i < offset; i++) expect(Math.abs(out[i])).toBeLessThan(1e-7);
      expect(out.subarray(offset).some((v) => Math.abs(v) > 0.01)).toBe(true);
    });
  }
});
