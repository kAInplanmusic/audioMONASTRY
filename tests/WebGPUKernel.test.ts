/**
 * WebGPU-Kernel Tests (WebGPUKernel)
 * -----------------------------------
 * Stand: 2026-09-07
 * Prüfen: device-get, activate (relu/sigmoid/tanh), matMul (GEMM), 
 *         support detection (mit und ohne WebGPU)
 */

import { describe, test, expect } from 'vitest';
import { WebGPUKernel, GPUTensor } from '../src/core/gpu/WebGPUKernel';

// Mock WebGPU für Test-Umgebung (Node.js ohne GPU)
function mockWebGPU() {
  if (typeof window === 'undefined') {
    (globalThis as any).navigator = {
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
    };
  }
}

describe('WebGPUKernel', () => {
  let kernel: WebGPUKernel;

  // beforeEach not needed: mock in each test
  mockWebGPU();
    mockWebGPU();
    kernel = new WebGPUKernel();
  });

  test('detects WebGPU support', () => {
    expect(kernel.supported).toBe(true);
  });

  test('rejects WebGPU if not available', () => {
    // Clear mock
    (globalThis as any).navigator = {};
    const kernel2 = new WebGPUKernel();
    expect(kernel2.supported).toBe(false);
  });

  test('getDevice returns GPUDevice', async () => {
    const device = await kernel.getDevice();
    expect(device).toBeDefined();
  });

  test('activate: relu', async () => {
    const data = new Float32Array([-1, 0, 1, 2, -0.5]);
    const result = await kernel.activate(data, 'relu');
    expect(result).toHaveLength(5);
    expect(result[0]).toBe(0); // -1 → 0
    expect(result[1]).toBe(0); // 0 → 0
    expect(result[2]).toBe(1);
    expect(result[3]).toBe(2);
    expect(result[4]).toBe(0); // -0.5 → 0
  });

  test('activate: sigmoid', async () => {
    const data = new Float32Array([0, 1, -1, 10]);
    const result = await kernel.activate(data, 'sigmoid');
    expect(result).toHaveLength(4);
    expect(result[0]).toBeCloseTo(0.5, 5); // 1/(1+e^0) = 0.5
    expect(result[1]).toBeGreaterThan(0.5); // sigmoid(1) > 0.5
    expect(result[2]).toBeLessThan(0.5); // sigmoid(-1) < 0.5
    expect(result[3]).toBeCloseTo(1, 5); // sigmoid(10) ≈ 1
  });

  test('activate: tanh', async () => {
    const data = new Float32Array([0, 1, -1, 10]);
    const result = await kernel.activate(data, 'tanh');
    expect(result).toHaveLength(4);
    expect(result[0]).toBeCloseTo(0, 5);
    expect(result[1]).toBeGreaterThan(0); // tanh(1) > 0
    expect(result[2]).toBeLessThan(0); // tanh(-1) < 0
    expect(result[3]).toBeCloseTo(1, 5); // tanh(10) ≈ 1
  });

  test('matMul: 2x2 × 2x2 = 2x2', async () => {
    // A = [[1, 2], [3, 4]], B = [[2, 0], [1, 2]]
    // C = [[4, 4], [10, 8]]
    const A = new Float32Array([1, 2, 3, 4]); // row-major: [row0col0, row0col1, row1col0, row1col1]
    const B = new Float32Array([2, 0, 1, 2]);
    const C = await kernel.matMul(A, B, 2, 2, 2);
    expect(C).toHaveLength(4);
    expect(C[0]).toBeCloseTo(4, 5); // 1×2 + 2×1 = 4
    expect(C[1]).toBeCloseTo(4, 5); // 1×0 + 2×2 = 4
    expect(C[2]).toBeCloseTo(10, 5); // 3×2 + 4×1 = 10
    expect(C[3]).toBeCloseTo(8, 5);  // 3×0 + 4×2 = 8
  });

  test('matMul: 1x2 × 2x1 = 1x1', async () => {
    const A = new Float32Array([1, 2]); // 1x2
    const B = new Float32Array([3, 4]); // 2x1
    const C = await kernel.matMul(A, B, 1, 2, 1);
    expect(C).toHaveLength(1);
    expect(C[0]).toBeCloseTo(11, 5); // 1×3 + 2×4 = 11
  });

  test('matMul: empty input (0×0)', async () => {
    const A = new Float32Array(0);
    const B = new Float32Array(0);
    const C = await kernel.matMul(A, B, 0, 0, 0);
    expect(C).toHaveLength(0);
  });

  test('matMul: 3x2 × 2x3 = 3x3', async () => {
    const A = new Float32Array([1, 2, 3, 4, 5, 6]); // 3x2
    const B = new Float32Array([1, 2, 3, 4, 5, 6]); // 2x3
    const C = await kernel.matMul(A, B, 3, 2, 3);
    expect(C).toHaveLength(9);
    // C[0] = 1×1 + 2×3 = 7
    // C[1] = 1×2 + 2×4 = 10
    // C[2] = 1×3 + 2×5 = 13
    // C[3] = 3×1 + 4×3 = 15
    // C[4] = 3×2 + 4×4 = 22
    // C[5] = 3×3 + 4×5 = 29
    // C[6] = 5×1 + 6×3 = 23
    // C[7] = 5×2 + 6×4 = 34
    // C[8] = 5×3 + 6×5 = 45
    expect(C[0]).toBeCloseTo(7, 5);
    expect(C[1]).toBeCloseTo(10, 5);
    expect(C[2]).toBeCloseTo(13, 5);
    expect(C[3]).toBeCloseTo(15, 5);
    expect(C[4]).toBeCloseTo(22, 5);
    expect(C[5]).toBeCloseTo(29, 5);
    expect(C[6]).toBeCloseTo(23, 5);
    expect(C[7]).toBeCloseTo(34, 5);
    expect(C[8]).toBeCloseTo(45, 5);
  });
});
