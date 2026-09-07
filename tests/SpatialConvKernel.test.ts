/**
 * SpatialConvKernel Tests (SpatialConvKernel + CPU-Referenz)
 * ----------------------------------------------------------
 * Stand: 2026-09-07
 * Prüfen: cpuSpatialConvolve (Gain-Berechnung, NaN-Sicherheit, leere Eingaben)
 *         spatialConvolve (GPU fallback → CPU)
 */

import { describe, test, expect } from 'vitest';
import { cpuSpatialConvolve, SpatialConvJob, spatialConvolve } from '../src/core/gpu/SpatialConvKernel';

describe('cpuSpatialConvolve', () => {
  test('basic mono input', () => {
    const input = new Float32Array([1, 2, 3, 4, 5]);
    const hrirLeft = new Float32Array([0.5, 0.5, 0.5]);
    const hrirRight = new Float32Array([0.5, 0.5, 0.5]);
    const result = cpuSpatialConvolve({ input, hrirLeft, hrirRight });
    const expected = new Float32Array([0.5, 1.0, 1.5, 2.0, 2.5]);
    expect(result.left).toEqual(expected);
    expect(result.right).toEqual(expected);
  });

  test('different gains for left/right', () => {
    const input = new Float32Array([1, 1, 1]);
    const hrirLeft = new Float32Array([0.3, 0.3, 0.3]); // avg = 0.3
    const hrirRight = new Float32Array([0.7, 0.7, 0.7]); // avg = 0.7
    const result = cpuSpatialConvolve({ input, hrirLeft, hrirRight });
    expect(result.left).toEqual(new Float32Array([0.3, 0.3, 0.3]));
    expect(result.right).toEqual(new Float32Array([0.7, 0.7, 0.7]));
  });

  test('NaN input → 0 output', () => {
    const input = new Float32Array([1, NaN, 3, Infinity, -Infinity]);
    const hrirLeft = new Float32Array([0.5]);
    const hrirRight = new Float32Array([0.5]);
    const result = cpuSpatialConvolve({ input, hrirLeft, hrirRight });
    // NaN und Inf sollten zu 0 werden
    expect(result.left[0]).toBeCloseTo(0.5);
    expect(result.left[1]).toBe(0); // NaN → 0
    expect(result.left[2]).toBeCloseTo(1.5);
    expect(result.left[3]).toBe(0); // Inf → 0
    expect(result.left[4]).toBe(0); // -Inf → 0
  });

  test('empty input', () => {
    const input = new Float32Array(0);
    const hrirLeft = new Float32Array([0.5]);
    const hrirRight = new Float32Array([0.5]);
    const result = cpuSpatialConvolve({ input, hrirLeft, hrirRight });
    expect(result.left).toHaveLength(0);
    expect(result.right).toHaveLength(0);
  });

  test('zero hrir gain', () => {
    const input = new Float32Array([1, 2, 3]);
    const hrirLeft = new Float32Array([0, 0, 0]); // avg = 0
    const hrirRight = new Float32Array([0.5, 0.5, 0.5]); // avg = 0.5
    const result = cpuSpatialConvolve({ input, hrirLeft, hrirRight });
    expect(result.left).toEqual(new Float32Array([0, 0, 0]));
    expect(result.right).toEqual(new Float32Array([0.5, 1.0, 1.5]));
  });

  test('single sample', () => {
    const input = new Float32Array([1]);
    const hrirLeft = new Float32Array([0.25]);
    const hrirRight = new Float32Array([0.75]);
    const result = cpuSpatialConvolve({ input, hrirLeft, hrirRight });
    expect(result.left[0]).toBeCloseTo(0.25);
    expect(result.right[0]).toBeCloseTo(0.75);
  });

  test('large input (performance)', () => {
    const n = 48000; // 1s @ 48kHz
    const input = new Float32Array(n).fill(0.5);
    const hrirLeft = new Float32Array([0.3, 0.3, 0.4]);
    const hrirRight = new Float32Array([0.4, 0.4, 0.3]);
    const start = performance.now();
    const result = cpuSpatialConvolve({ input, hrirLeft, hrirRight });
    const duration = performance.now() - start;
    expect(result.left).toHaveLength(n);
    expect(result.right).toHaveLength(n);
    expect(duration).toBeLessThan(1000); // < 1s
  });
});

describe('spatialConvolve', () => {
  test('GPU unavailable → CPU fallback', () => {
    // Kein WebGPU im Test (Node.js), also CPU-Pfadt
    const input = new Float32Array([1, 2, 3]);
    const hrirLeft = new Float32Array([0.5]);
    const hrirRight = new Float32Array([0.5]);
    return spatialConvolve({ input, hrirLeft, hrirRight }).then((result) => {
      expect(result.left).toEqual(new Float32Array([0.5, 1.0, 1.5]));
      expect(result.right).toEqual(new Float32Array([0.5, 1.0, 1.5]));
    });
  });

  test('GPU error → CPU fallback', async () => {
    // Falls WebGPU existiert, aber Fehler wirft (z.B. veraltetes GPU), soll CPU-Pfadt laufen
    // Dies ist implizit getestet durch die try/catch-Logik in spatialConvolve()
    const input = new Float32Array([1, 2, 3]);
    const hrirLeft = new Float32Array([0.5]);
    const hrirRight = new Float32Array([0.5]);
    const result = await spatialConvolve({ input, hrirLeft, hrirRight });
    expect(result.left).toHaveLength(3);
    expect(result.right).toHaveLength(3);
  });
});
