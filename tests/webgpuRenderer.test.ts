import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  WEBGPU_SHADER,
  WEBGPU_UNIFORM_BYTES,
  WEBGPU_UNIFORM_FLOATS,
  createWebGpuVisualRenderer,
  hasWebGpuSupport,
  packWebGpuUniforms,
} from '../src/core/visual/webgpuRenderer';
import { MAX_SHADER_COLORS } from '../src/core/visual/webglRenderer';
import { VISUAL_PRESETS } from '../src/core/visual/visualPresets';

/**
 * VISUAL-P1-009 · WebGPU-Pfad (reine Teile)
 * =====================================================================
 * Der Live-Beweis (scripts/webgpu-live-proof.mjs) zeigt, dass der Pfad zeichnet.
 * Hier wird festgehalten, was OHNE GPU prüfbar ist und leicht kaputtgehen kann:
 * das Uniform-Layout (40 floats, vec4-Farben mit 16-Byte-Abstand), die
 * Verfügbarkeitsprüfung und der ehrliche `null`-Rückfall ohne WebGPU.
 */

const preset = VISUAL_PRESETS[0];
const params = {
  zoom: 1.2, rotation: 30, warp: 0.3, hue: 90, flow: 0.6,
  brightness: 1.1, contrast: 1.2, displacement: 0.4, glow: 0.5, symmetry: 4,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('VISUAL-P1-009 · WebGPU-Uniforms', () => {
  it('packt genau das Layout, das der WGSL-Struct erwartet', () => {
    const data = packWebGpuUniforms(preset, params, { timeS: 2.5, width: 320, height: 180 });
    expect(data).toHaveLength(WEBGPU_UNIFORM_FLOATS);
    expect(WEBGPU_UNIFORM_BYTES).toBe(WEBGPU_UNIFORM_FLOATS * 4);
    // 40 floats = 16 Kopf + 6 * vec4
    expect(WEBGPU_UNIFORM_FLOATS).toBe(16 + MAX_SHADER_COLORS * 4);
    // 16-Byte-Ausrichtung (WebGPU-Pflicht fuer Uniform-Puffer)
    expect(WEBGPU_UNIFORM_BYTES % 16).toBe(0);
  });

  it('uebernimmt die Werte aus packUniforms (identischer Parameter-Contract)', () => {
    const data = packWebGpuUniforms(preset, params, { timeS: 2.5, width: 320, height: 180 });
    expect([data[0], data[1]]).toEqual([320, 180]);
    expect(data[2]).toBe(2.5);
    expect(data[3]).toBeCloseTo(1.2, 5); // zoom
    expect(data[4]).toBeCloseTo((30 * Math.PI) / 180, 5); // rotation in Radiant
    expect(data[5]).toBeCloseTo(0.3, 5);
    expect(data[6]).toBeCloseTo((90 * Math.PI) / 180, 5);
    expect(data[12]).toBe(4); // symmetry
    expect(data[14]).toBe(0); // _pad0
    expect(data[15]).toBe(0); // _pad1
  });

  it('legt jede Farbe als vec4 mit Alpha 1 ab (Array-Stride 16 Bytes)', () => {
    const data = packWebGpuUniforms(preset, params, { timeS: 0, width: 100, height: 100 });
    for (let i = 0; i < MAX_SHADER_COLORS; i += 1) {
      expect(data[16 + i * 4 + 3]).toBe(1);
    }
    // Farben sind geklemmt (0..1) - nie NaN/negativ.
    for (let i = 16; i < WEBGPU_UNIFORM_FLOATS; i += 1) {
      expect(Number.isFinite(data[i])).toBe(true);
      expect(data[i]).toBeGreaterThanOrEqual(0);
      expect(data[i]).toBeLessThanOrEqual(1);
    }
  });

  it('faengt ungueltige Zahlen ab (keine NaN-Uniforms)', () => {
    const data = packWebGpuUniforms(preset, { ...params, zoom: Number.NaN, rotation: Number.NaN }, {
      timeS: Number.NaN, width: Number.NaN, height: Number.NaN,
    });
    for (const value of data) expect(Number.isFinite(value)).toBe(true);
  });
});

describe('VISUAL-P1-009 · Shader und Verfuegbarkeit', () => {
  it('enthaelt beide Entry-Points und das Farb-Array in der erwarteten Groesse', () => {
    expect(WEBGPU_SHADER).toContain('@vertex');
    expect(WEBGPU_SHADER).toContain('fn vs(');
    expect(WEBGPU_SHADER).toContain('@fragment');
    expect(WEBGPU_SHADER).toContain('fn fs(');
    expect(WEBGPU_SHADER).toContain(`array<vec4f, ${MAX_SHADER_COLORS}>`);
    // Keine WGSL-Falle: `textureSample` in einem Nicht-Fragment-Shader waere ungueltig.
    expect(WEBGPU_SHADER).not.toContain('textureSample');
  });

  it('meldet WebGPU nur, wenn navigator.gpu existiert', () => {
    vi.stubGlobal('navigator', {});
    expect(hasWebGpuSupport()).toBe(false);
    vi.stubGlobal('navigator', { gpu: {} });
    expect(hasWebGpuSupport()).toBe(true);
  });

  it('faellt ohne WebGPU ehrlich auf null zurueck (kein Fake-Renderer)', async () => {
    vi.stubGlobal('navigator', {});
    const fakeCanvas = { getContext: () => null, width: 10, height: 10 } as unknown as HTMLCanvasElement;
    await expect(createWebGpuVisualRenderer(fakeCanvas)).resolves.toBeNull();
  });

  it('faellt ohne Adapter ehrlich auf null zurueck', async () => {
    vi.stubGlobal('navigator', {
      gpu: {
        requestAdapter: async () => null,
        getPreferredCanvasFormat: () => 'bgra8unorm',
      },
    });
    const fakeCanvas = { getContext: () => null, width: 10, height: 10 } as unknown as HTMLCanvasElement;
    await expect(createWebGpuVisualRenderer(fakeCanvas)).resolves.toBeNull();
  });
});
