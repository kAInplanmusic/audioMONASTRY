// @vitest-environment node
/**
 * Funktionaler Test des granularProcessor (Produktions-Worklet).
 * Stubt Worklet-Globals und rendert Körner aus einer Sinus-Quelle.
 */
import { beforeAll, describe, expect, it } from 'vitest';

interface GranularProcessorInstance {
  port: { onmessage: ((e: { data?: Record<string, unknown> }) => void) | null };
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}

type ProcessorCtor = new () => GranularProcessorInstance;

let ProcessorCtor: ProcessorCtor | null = null;

beforeAll(async () => {
  const g = globalThis as unknown as Record<string, unknown>;
  g.sampleRate = 48000;
  g.currentFrame = 0;
  g.currentTime = 0;
  g.AudioWorkletProcessor = class {
    port = { onmessage: null as unknown as GranularProcessorInstance['port']['onmessage'] };
  };
  g.registerProcessor = (_name: string, ctor: ProcessorCtor) => { ProcessorCtor = ctor; };
  await import('../src/audio/worklets/granularProcessor.ts');
  expect(ProcessorCtor).not.toBeNull();
});

function runBlock(p: GranularProcessorInstance, frame: number, frames = 128): Float32Array {
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

describe('granularProcessor (echter Worklet-Code)', () => {
  it('spielt Körner aus der Source hörbar und NaN-frei ab', () => {
    const src = new Float32Array(48000);
    for (let i = 0; i < src.length; i++) src[i] = Math.sin((2 * Math.PI * 440 * i) / 48000);
    const p = new ProcessorCtor!();
    p.port.onmessage?.({ data: { buffer: src, grainSize: 480, density: 20, position: 0, pitch: 1, gain: 0.8 } });

    const blocks: number[] = [];
    for (let b = 0; b < 40; b++) {
      const out = runBlock(p, b * 128);
      for (let i = 0; i < out.length; i++) {
        blocks.push(out[i]);
        expect(Number.isFinite(out[i])).toBe(true);
      }
    }
    const buf = Float32Array.from(blocks);
    expect(rms(buf)).toBeGreaterThan(1e-4);
  });

  it('Pitch ändert das Signal (höherer Pitch = anderes Ergebnis)', () => {
    const src = new Float32Array(48000);
    for (let i = 0; i < src.length; i++) src[i] = Math.sin((2 * Math.PI * 440 * i) / 48000);

    const render = (pitch: number): Float32Array => {
      const p = new ProcessorCtor!();
      p.port.onmessage?.({ data: { buffer: src, grainSize: 480, density: 20, position: 0, pitch, gain: 0.8 } });
      const out = new Float32Array(40 * 128);
      for (let b = 0; b < 40; b++) out.set(runBlock(p, b * 128), b * 128);
      return out;
    };

    const low = render(0.5);
    const high = render(2);
    let diff = 0;
    for (let i = 0; i < low.length; i++) diff += Math.abs(low[i] - high[i]);
    expect(diff).toBeGreaterThan(0.01);
  });
});
