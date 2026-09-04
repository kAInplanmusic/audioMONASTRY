import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { HrtfConvolverWasm, JsHrtfConvolver } from '../src/audio/spatial/wasmHrtf';

(globalThis as any).sampleRate = 48000;

const wasmPath = path.resolve(process.cwd(), 'public/hrtf/hrtf_conv.wasm');

const IR_L = [0.5, 0.32, 0.2, 0.13, 0.08, 0.05, 0.03, 0.02, 0.01, 0, 0, 0, 0, 0, 0, 0];
const IR_R = [0.01, 0.03, 0.06, 0.11, 0.18, 0.26, 0.22, 0.14, 0.08, 0.05, 0.03, 0.02, 0.01, 0, 0, 0];

function impulseBlock(at: number): Float32Array {
  const b = new Float32Array(128);
  b[at] = 1;
  return b;
}

describe('WASM partitioned-FFT-HRTF-Konvolver', () => {
  it('lädt das Rust-Modul und faltet Impuls deterministisch (vs. JS-Referenz)', async () => {
    const bytes = readFileSync(wasmPath);
    const module = await WebAssembly.compile(bytes);

    const wasm = await HrtfConvolverWasm.create(module, 1024);
    const js = new JsHrtfConvolver(1024);
    wasm.setIr(Float32Array.from(IR_L), Float32Array.from(IR_R));
    js.setIr(Float32Array.from(IR_L), Float32Array.from(IR_R));

    const inL = impulseBlock(0);
    const inR = new Float32Array(128);
    const outL = new Float32Array(128);
    const outR = new Float32Array(128);
    const refL = new Float32Array(128);
    const refR = new Float32Array(128);

    wasm.processBlock(inL, inR, outL, outR);
    js.processBlock(inL, inR, refL, refR);

    expect(Number.isFinite(outL[0])).toBe(true);
    // Block 0: direkte FIR = Faltung mit IR[0] an Position 0
    expect(outL[0]).toBeCloseTo(refL[0], 3);
    expect(outR[0]).toBeCloseTo(refR[0], 3);
    // FFT-Rundungsfehler bleiben klein
    for (let i = 0; i < 128; i++) {
      expect(Math.abs(outL[i] - refL[i])).toBeLessThan(0.001);
      expect(Math.abs(outR[i] - refR[i])).toBeLessThan(0.001);
    }
  });

  it('Overlap-Add bleibt über Blockgrenzen konsistent', async () => {
    const bytes = readFileSync(wasmPath);
    const module = await WebAssembly.compile(bytes);
    const wasm = await HrtfConvolverWasm.create(module, 1024);
    const js = new JsHrtfConvolver(1024);
    wasm.setIr(Float32Array.from(IR_L), Float32Array.from(IR_R));
    js.setIr(Float32Array.from(IR_L), Float32Array.from(IR_R));

    const b1 = impulseBlock(64);
    const b2 = impulseBlock(10);
    const zero = new Float32Array(128);
    const wOut1 = new Float32Array(128);
    const wOut2 = new Float32Array(128);
    const jOut1 = new Float32Array(128);
    const jOut2 = new Float32Array(128);

    wasm.processBlock(b1, zero, wOut1, wOut1);
    js.processBlock(b1, zero, jOut1, jOut1);
    wasm.processBlock(b2, zero, wOut2, wOut2);
    js.processBlock(b2, zero, jOut2, jOut2);

    for (let i = 0; i < 128; i++) {
      expect(Math.abs(wOut2[i] - jOut2[i])).toBeLessThan(0.001);
    }
  });
});

describe('spatialProcessor Worklet + WASM-Integration (Node)', () => {
  it('instanziiert WASM über loadHRTFWasm und rendert High-Quality-Block', async () => {
    const { SpatialProcessor } = await import('../src/audio/worklets/spatialProcessor.ts');
    const bytes = readFileSync(wasmPath);
    const module = await WebAssembly.compile(bytes);

    const p = new SpatialProcessor();
    p.port.postMessage({ cmd: 'setGlobal', quality: 'high', listenerRot: 0, masterGain: 1 });
    p.port.postMessage({ cmd: 'loadHRTF', left: IR_L, right: IR_R });
    p.port.postMessage({ cmd: 'loadHRTFWasm', module });

    // Async-Instanziierung abwarten
    for (let i = 0; i < 50 && !(p as any).wasmReady; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect((p as any).wasmReady).toBe(true);

    p.port.postMessage({ cmd: 'addSource', id: 1, name: 'imp', az: 0, el: 0, dist: 0, gain: 1 });

    const inL = impulseBlock(0);
    const inputs: Float32Array[][] = [[inL]];
    const blockL = new Float32Array(128);
    const blockR = new Float32Array(128);
    const outputs: Float32Array[][] = [[blockL, blockR]];
    p.process(inputs, outputs);

    expect(Number.isFinite(blockL[0])).toBe(true);
    expect(blockL.some((v) => Math.abs(v) > 0.01)).toBe(true);
    expect(blockR.some((v) => Math.abs(v) > 0.01)).toBe(true);
    // az=0 → Equal-Power: beide Kanäle gleiche Hüllkurve (bis auf HRTF-Asymmetrie)
    const sumL = blockL.reduce((a, b) => a + Math.abs(b), 0);
    const sumR = blockR.reduce((a, b) => a + Math.abs(b), 0);
    expect(sumL).toBeGreaterThan(0);
    expect(sumR).toBeGreaterThan(0);
  });
});
