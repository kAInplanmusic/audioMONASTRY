// @vitest-environment node
/**
 * Funktionaler Test des drumSynthProcessor (Kick/Snare/Hat-Trigger).
 */
import { beforeAll, describe, expect, it } from 'vitest';

interface DrumSynthProcessorInstance {
  port: { onmessage: ((e: { data?: Record<string, unknown> }) => void) | null };
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}

type ProcessorCtor = new () => DrumSynthProcessorInstance;

let ProcessorCtor: ProcessorCtor | null = null;

beforeAll(async () => {
  const g = globalThis as unknown as Record<string, unknown>;
  g.sampleRate = 48000;
  g.currentFrame = 0;
  g.currentTime = 0;
  g.AudioWorkletProcessor = class {
    port = { onmessage: null as unknown as DrumSynthProcessorInstance['port']['onmessage'] };
  };
  g.registerProcessor = (_name: string, ctor: ProcessorCtor) => { ProcessorCtor = ctor; };
  await import('../src/audio/worklets/drumSynthProcessor.ts');
  expect(ProcessorCtor).not.toBeNull();
});

function runBlock(p: DrumSynthProcessorInstance, frame: number, frames = 128): Float32Array {
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

describe('drumSynthProcessor (echter Worklet-Code)', () => {
  it('triggert Kick hörbar und NaN-frei', () => {
    const p = new ProcessorCtor!();
    p.port.onmessage?.({ data: { type: 'kick' } });
    const out = new Float32Array(10 * 128);
    for (let b = 0; b < 10; b++) {
      const block = runBlock(p, b * 128);
      out.set(block, b * 128);
      for (let i = 0; i < block.length; i++) expect(Number.isFinite(block[i])).toBe(true);
    }
    expect(rms(out)).toBeGreaterThan(1e-4);
  });

  it('Kick klingt aus (letzte Samples leise)', () => {
    const p = new ProcessorCtor!();
    p.port.onmessage?.({ data: { type: 'kick' } });
    const tail = new Float32Array(160 * 128);
    for (let b = 0; b < 160; b++) tail.set(runBlock(p, b * 128), b * 128);
    let sum = 0;
    for (let i = tail.length - 256; i < tail.length; i++) sum += tail[i] * tail[i];
    expect(Math.sqrt(sum / 256)).toBeLessThan(0.01);
  });
});
