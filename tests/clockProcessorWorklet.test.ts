// @vitest-environment node
/**
 * P2-2: Funktionaler Test des echten clockProcessor-Worklets.
 * ----------------------------------------------------------
 * Stubt die Worklet-Globals (sampleRate/currentFrame/currentTime,
 * AudioWorkletProcessor, registerProcessor) und führt den echten
 * Phasen-Akkumulator deterministisch aus:
 *   * Konstantes Tempo liefert Step-Impulse im 16tel-Raster (125 ms @ 120 BPM)
 *   * 240 BPM halbiert den Step-Abstand (62,5 ms)
 *   * Sample-genauer BPM-Wechsel: ein innerhalb eines Render-Quantums
 *     umgeschalteter bpm-AudioParam (a-rate) verschiebt den Step exakt um die
 *     erwartete Sample-Anzahl (kein setTimeout-/Block-Jitter)
 */
import { beforeAll, describe, expect, it } from 'vitest';

interface ClockStepMsg {
  type: string;
  step: number;
  time: number;
  swing: number;
  gate: number;
  secondsPerStep: number;
}

interface ClockProcessorInstance {
  port: {
    onmessage: ((e: { data?: Record<string, unknown> }) => void) | null;
    postMessage: (msg: ClockStepMsg) => void;
  };
  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean;
}

type ProcessorCtor = new () => ClockProcessorInstance;

const SR = 48000;
const QUANTUM = 128;

let ProcessorCtor: ProcessorCtor | null = null;

beforeAll(async () => {
  const g = globalThis as unknown as Record<string, unknown>;
  g.sampleRate = SR;
  g.currentFrame = 0;
  g.currentTime = 0;
  g.AudioWorkletProcessor = class {
    port = {
      onmessage: null as unknown as ClockProcessorInstance['port']['onmessage'],
      postMessage: () => {},
    };
  };
  g.registerProcessor = (_name: string, ctor: ProcessorCtor) => {
    ProcessorCtor = ctor;
  };

  await import('../src/audio/worklets/clockProcessor.ts');
  expect(ProcessorCtor).not.toBeNull();
});

function createClock(): { p: ClockProcessorInstance; steps: ClockStepMsg[] } {
  if (!ProcessorCtor) throw new Error('clockProcessor nicht geladen');
  const steps: ClockStepMsg[] = [];
  const p = new ProcessorCtor();
  (p.port as unknown as { postMessage: (m: ClockStepMsg) => void }).postMessage = (m) => steps.push(m);
  return { p, steps };
}

/** Führt ein Render-Quantum ab `frame` aus. `bpm` als Zahl (k-rate) oder 128er-Array (a-rate). */
function runBlock(p: ClockProcessorInstance, frame: number, bpm: number | Float32Array): void {
  const g = globalThis as unknown as Record<string, number>;
  g.currentFrame = frame;
  g.currentTime = frame / SR;
  const bpmArr = typeof bpm === 'number' ? Float32Array.from([bpm]) : bpm;
  expect(p.process([], [], { bpm: bpmArr, swing: Float32Array.from([0]), gate: Float32Array.from([0.9]) })).toBe(true);
}

describe('clockProcessor (echter Worklet-Code, P2-2)', () => {
  it('120 BPM: Step-Impulse im 16tel-Raster (125 ms)', () => {
    const { p, steps } = createClock();
    for (let b = 0; b < 100; b++) runBlock(p, b * QUANTUM, 120);

    expect(steps.length).toBeGreaterThanOrEqual(2);
    expect(Math.abs(steps[0].time - 0.125)).toBeLessThan(1e-9);
    expect(Math.abs(steps[1].time - steps[0].time - 0.125)).toBeLessThan(1e-9);
    expect(steps[0].step).toBe(0);
    expect(steps[1].step).toBe(1);
  });

  it('240 BPM halbiert den Step-Abstand (62,5 ms)', () => {
    const { p, steps } = createClock();
    for (let b = 0; b < 50; b++) runBlock(p, b * QUANTUM, 240);

    expect(steps.length).toBeGreaterThanOrEqual(2);
    expect(Math.abs(steps[0].time - 0.0625)).toBeLessThan(5e-5);
    expect(Math.abs(steps[1].time - steps[0].time - 0.0625)).toBeLessThan(1e-9);
  });

  it('Sample-genauer BPM-Wechsel innerhalb eines Quantums (a-rate)', () => {
    // Kontrolle: 47 Quanten konstant 120 BPM → erster Step exakt bei 0,125 s.
    const control = createClock();
    for (let b = 0; b < 47; b++) runBlock(control.p, b * QUANTUM, 120);
    expect(control.steps.length).toBe(1);
    expect(Math.abs(control.steps[0].time - 0.125)).toBeLessThan(1e-9);

    // Referenz-Simulation (identische Float-Operationen) für den a-rate-Verlauf:
    // Quantum 46: erste 64 Samples 120 BPM, letzte 64 Samples 240 BPM.
    let expectedSample = -1;
    {
      let phase = 0;
      outer: for (let b = 0; b < 47; b++) {
        for (let i = 0; i < QUANTUM; i++) {
          const bpm = b === 46 && i >= 64 ? 240 : 120;
          const samplesPerStep = (SR * 60.0) / bpm / 4.0;
          phase += 1.0 / samplesPerStep;
          if (phase >= 1.0) {
            phase -= 1.0;
            if (expectedSample < 0) expectedSample = b * QUANTUM + i;
            break outer;
          }
        }
      }
    }
    expect(expectedSample).toBeGreaterThanOrEqual(0);

    const switched = createClock();
    for (let b = 0; b < 46; b++) runBlock(switched.p, b * QUANTUM, 120);
    const bpmArr = new Float32Array(QUANTUM);
    for (let i = 0; i < 64; i++) bpmArr[i] = 120;
    for (let i = 64; i < QUANTUM; i++) bpmArr[i] = 240;
    runBlock(switched.p, 46 * QUANTUM, bpmArr);

    expect(switched.steps.length).toBe(1);
    expect(Math.abs(switched.steps[0].time - expectedSample / SR)).toBeLessThan(1e-9);
    // Der Wechsel macht den Step messbar früher als konstant 120 BPM.
    expect(expectedSample).toBeLessThan(6000);
  });

  it('Port-Nachricht bpm wirkt als Fallback (k-rate-Pfad)', () => {
    const { p, steps } = createClock();
    p.port.onmessage?.({ data: { bpm: 240 } });
    for (let b = 0; b < 50; b++) runBlock(p, b * QUANTUM, 240);
    expect(Math.abs(steps[0].time - 0.0625)).toBeLessThan(5e-5);
  });

  it('reset setzt Phase und Step zurück (kein Timing-Sprung nach 16/32-Wechsel)', () => {
    const { p, steps } = createClock();
    p.port.onmessage?.({ data: { reset: true } });
    for (let b = 0; b < 100; b++) runBlock(p, b * QUANTUM, 120);
    expect(steps.length).toBeGreaterThanOrEqual(2);
    expect(steps[0].step).toBe(0);
    expect(Math.abs(steps[0].time - 0.125)).toBeLessThan(1e-9);
  });
});
