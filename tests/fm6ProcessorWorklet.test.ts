// @vitest-environment node
/**
 * Funktionaler Test des fm6Processor (6-Op-FM-Worklet, DX7-Patches).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { DX7_REFERENCE_PATCHES } from '../src/core/instrument/dx7Presets';

interface Fm6ProcessorInstance {
  port: { onmessage: ((e: { data?: Record<string, unknown> }) => void) | null };
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}

type ProcessorCtor = new () => Fm6ProcessorInstance;

let ProcessorCtor: ProcessorCtor | null = null;

beforeAll(async () => {
  const g = globalThis as unknown as Record<string, unknown>;
  g.sampleRate = 48000;
  g.currentFrame = 0;
  g.currentTime = 0;
  g.AudioWorkletProcessor = class {
    port = { onmessage: null as unknown as Fm6ProcessorInstance['port']['onmessage'] };
  };
  g.registerProcessor = (_name: string, ctor: ProcessorCtor) => { ProcessorCtor = ctor; };
  await import('../src/audio/worklets/fm6Processor.ts');
  expect(ProcessorCtor).not.toBeNull();
});

function runBlock(p: Fm6ProcessorInstance, frame: number, frames = 128): Float32Array {
  const g = globalThis as unknown as Record<string, number>;
  g.currentFrame = frame;
  g.currentTime = frame / 48000;
  const output = [new Float32Array(frames)];
  expect(p.process([], [output])).toBe(true);
  return output[0];
}

function rms(buf: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  return Math.sqrt(sum / buf.length);
}

describe('fm6Processor (echter Worklet-Code)', () => {
  it('spielt eine Note nach Patch-Message hörbar und NaN-frei ab', () => {
    const p = new ProcessorCtor!();
    p.port.onmessage?.({ data: { type: 'patch', patch: DX7_REFERENCE_PATCHES[0] } });
    p.port.onmessage?.({ data: { type: 'noteOn', noteHz: 261.63, velocity: 0.8 } });

    const out = new Float32Array(40 * 128);
    for (let b = 0; b < 40; b++) {
      const block = runBlock(p, b * 128);
      out.set(block, b * 128);
      for (let i = 0; i < block.length; i++) expect(Number.isFinite(block[i])).toBe(true);
    }
    expect(rms(out)).toBeGreaterThan(1e-4);
  });

  it('noteOff lässt die Stimme ausklingen', () => {
    const p = new ProcessorCtor!();
    p.port.onmessage?.({ data: { type: 'patch', patch: DX7_REFERENCE_PATCHES[3] } });
    p.port.onmessage?.({ data: { type: 'noteOn', noteHz: 440, velocity: 0.8 } });
    for (let b = 0; b < 10; b++) runBlock(p, b * 128);
    p.port.onmessage?.({ data: { type: 'noteOff', noteHz: 440 } });

    const tail = new Float32Array(100 * 128);
    for (let b = 0; b < 100; b++) tail.set(runBlock(p, (b + 10) * 128), b * 128);
    let endSum = 0;
    for (let i = tail.length - 2000; i < tail.length; i++) endSum += tail[i] * tail[i];
    expect(Math.sqrt(endSum / 2000)).toBeLessThan(0.1);
  });
});
