/**
 * WebGPU-Kernel Tests (WebGPUKernel)
 * -----------------------------------
 * Stand: 2026-09-07
 * - GPU-Erkennung wird mit einem WebGPU-Mock getestet.
 * - Aktivierung/MatMul werden über den deterministischen CPU-Fallback getestet,
 *   damit die Suite ohne GPU/WebGPU-Implementierung grün ist.
 */

import { describe, test, expect } from 'vitest';
import { WebGPUKernel } from '../src/core/gpu/WebGPUKernel';

// Mock WebGPU für Erkennungstests (Node.js ohne GPU)
function mockWebGPU() {
  if (typeof window === 'undefined') {
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        gpu: {
          requestAdapter: async () => ({
            requestDevice: async () => ({
              createBuffer: () => ({}),
              queue: {
                writeBuffer: () => {},
                submit: () => {},
              },
              createShaderModule: () => ({}),
              createComputePipeline: () => ({
                getBindGroupLayout: () => ({}),
              }),
              createBindGroup: () => ({}),
              createCommandEncoder: () => ({
                beginComputePass: () => ({
                  setPipeline: () => {},
                  setBindGroup: () => {},
                  dispatchWorkgroups: () => {},
                  end: () => {},
                }),
                finish: () => [],
              }),
            }),
          }),
        },
      },
      writable: true,
      configurable: true,
    });
  }
}

describe('WebGPUKernel – GPU-Erkennung', () => {
  test('detects WebGPU support', () => {
    mockWebGPU();
    const kernel = new WebGPUKernel();
    expect(kernel.supported).toBe(true);
  });

  test('rejects WebGPU if not available', () => {
    (globalThis as any).navigator = {};
    const kernel = new WebGPUKernel();
    expect(kernel.supported).toBe(false);
  });
});

describe('WebGPUKernel – CPU-Fallback (activate/matMul)', () => {
  const cpuKernel = () => new WebGPUKernel({ forceCpu: true });

  test('activate: relu', async () => {
    const data = new Float32Array([-1, 0, 1, 2, -0.5]);
    const result = await cpuKernel().activate(data, 'relu');
    expect(result).toHaveLength(5);
    expect(result[0]).toBe(0); // -1 → 0
    expect(result[1]).toBe(0); // 0 → 0
    expect(result[2]).toBe(1);
    expect(result[3]).toBe(2);
    expect(result[4]).toBe(0); // -0.5 → 0
  });

  test('activate: sigmoid', async () => {
    const data = new Float32Array([0, 1, -1, 10]);
    const result = await cpuKernel().activate(data, 'sigmoid');
    expect(result).toHaveLength(4);
    expect(result[0]).toBeCloseTo(0.5, 5); // 1/(1+e^0) = 0.5
    expect(result[1]).toBeGreaterThan(0.5); // sigmoid(1) > 0.5
    expect(result[2]).toBeLessThan(0.5); // sigmoid(-1) < 0.5
    expect(result[3]).toBeCloseTo(1, 4); // sigmoid(10) ≈ 0.99995
  });

  test('activate: tanh', async () => {
    const data = new Float32Array([0, 1, -1, 10]);
    const result = await cpuKernel().activate(data, 'tanh');
    expect(result).toHaveLength(4);
    expect(result[0]).toBeCloseTo(0, 5);
    expect(result[1]).toBeGreaterThan(0); // tanh(1) > 0
    expect(result[2]).toBeLessThan(0); // tanh(-1) < 0
    expect(result[3]).toBeCloseTo(1, 5); // tanh(10) ≈ 1
  });

  test('matMul: 2x2 × 2x2 = 2x2', async () => {
    // A = [[1, 2], [3, 4]], B = [[2, 0], [1, 2]]
    // C = [[4, 4], [10, 8]]
    const A = new Float32Array([1, 2, 3, 4]);
    const B = new Float32Array([2, 0, 1, 2]);
    const C = await cpuKernel().matMul(A, B, 2, 2, 2);
    expect(C).toHaveLength(4);
    expect(C[0]).toBeCloseTo(4, 5); // 1×2 + 2×1 = 4
    expect(C[1]).toBeCloseTo(4, 5); // 1×0 + 2×2 = 4
    expect(C[2]).toBeCloseTo(10, 5); // 3×2 + 4×1 = 10
    expect(C[3]).toBeCloseTo(8, 5);  // 3×0 + 4×2 = 8
  });

  test('matMul: 1x2 × 2x1 = 1x1', async () => {
    const A = new Float32Array([1, 2]); // 1x2
    const B = new Float32Array([3, 4]); // 2x1
    const C = await cpuKernel().matMul(A, B, 1, 2, 1);
    expect(C).toHaveLength(1);
    expect(C[0]).toBeCloseTo(11, 5); // 1×3 + 2×4 = 11
  });

  test('matMul: empty input (0×0)', async () => {
    const A = new Float32Array(0);
    const B = new Float32Array(0);
    const C = await cpuKernel().matMul(A, B, 0, 0, 0);
    expect(C).toHaveLength(0);
  });

  test('matMul: 3x2 × 2x3 = 3x3', async () => {
    const A = new Float32Array([1, 2, 3, 4, 5, 6]); // 3x2
    const B = new Float32Array([1, 2, 3, 4, 5, 6]); // 2x3
    const C = await cpuKernel().matMul(A, B, 3, 2, 3);
    expect(C).toHaveLength(9);
    // Row-major: A=[[1,2],[3,4],[5,6]], B=[[1,2,3],[4,5,6]]
    expect(C[0]).toBeCloseTo(9, 5);   // 1*1 + 2*4
    expect(C[1]).toBeCloseTo(12, 5);  // 1*2 + 2*5
    expect(C[2]).toBeCloseTo(15, 5);  // 1*3 + 2*6
    expect(C[3]).toBeCloseTo(19, 5);  // 3*1 + 4*4
    expect(C[4]).toBeCloseTo(26, 5);  // 3*2 + 4*5
    expect(C[5]).toBeCloseTo(33, 5);  // 3*3 + 4*6
    expect(C[6]).toBeCloseTo(29, 5);  // 5*1 + 6*4
    expect(C[7]).toBeCloseTo(40, 5);  // 5*2 + 6*5
    expect(C[8]).toBeCloseTo(51, 5);  // 5*3 + 6*6
  });
});
