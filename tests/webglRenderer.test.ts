import { describe, expect, it } from 'vitest';
import {
  MAX_SHADER_COLORS,
  SHADER_UNIFORMS,
  VERTEX_SHADER_SOURCE,
  buildFragmentShader,
  mediaSize,
  packUniforms,
  sceneCoverSpan,
} from '../src/core/visual/webglRenderer';
import type { VisualParams, VisualPreset } from '../src/core/visual/types';

const preset: VisualPreset = {
  id: 'test',
  label: 'Test',
  description: 'Fixture',
  palette: { colors: [[0.1, 0.2, 0.3], [1, 0, 0.5]], hueBase: 20 },
  motion: { baseSpin: 1, trebleSpin: 1, warp: 0.5, hueSpeed: 10, flow: 1 },
  base: { zoom: 1, glow: 0.2, saturation: 0.8, symmetry: 4 },
};

const params: VisualParams = {
  zoom: 1.5,
  rotation: 90,
  warp: 0.25,
  hue: 450,
  flow: 0.6,
  brightness: 1.1,
  contrast: 1.2,
  displacement: 0.3,
  glow: 0.4,
  symmetry: 6,
};

describe('WebGL-Renderer – Shader-Quelltext', () => {
  it('deklariert alle Uniforms, die der Renderer setzt', () => {
    const src = buildFragmentShader();
    for (const name of SHADER_UNIFORMS) expect(src, name).toContain(name);
    for (let i = 0; i < MAX_SHADER_COLORS; i++) expect(src).toContain(`uniform vec3 u_color${i};`);
    expect(src).toContain('gl_FragColor');
    expect(src).toContain('precision mediump float');
  });

  it('nutzt GLSL ES 1.00 (läuft in WebGL1 und WebGL2)', () => {
    const src = buildFragmentShader();
    expect(src).not.toContain('#version 300 es'); // sonst nur WebGL2
    expect(VERTEX_SHADER_SOURCE).toContain('attribute vec2 a_pos');
  });
});

describe('WebGL-Renderer – Uniform-Abbildung', () => {
  it('rechnet Winkel in Radiant und färbt die Palette flach aus', () => {
    const u = packUniforms(preset, params, { timeS: 3, width: 800.5, height: 600.4 });
    expect(u.resolution).toEqual([801, 600]);
    expect(u.time).toBe(3);
    expect(u.rotation).toBeCloseTo(Math.PI / 2, 6);
    // 450° → 90° → π/2
    expect(u.hue).toBeCloseTo(Math.PI / 2, 6);
    expect(u.colors).toHaveLength(MAX_SHADER_COLORS * 3);
    expect(u.colors.slice(0, 3)).toEqual([0.1, 0.2, 0.3]);
    expect(u.colors.slice(3, 6)).toEqual([1, 0, 0.5]);
    // Fehlende Palettenfarben werden mit der letzten Farbe aufgefüllt (kein 0/0/0-Rest).
    expect(u.colors.slice(6, 9)).toEqual([1, 0, 0.5]);
    expect(u.colorCount).toBe(2);
  });

  it('klemmt Wertebereiche, damit nichts Unerwartetes auf die GPU geht', () => {
    const wild = packUniforms(preset, {
      zoom: 99,
      rotation: -45,
      warp: 5,
      hue: -30,
      flow: -3,
      brightness: 99,
      contrast: -1,
      displacement: 4,
      glow: -2,
      symmetry: 999,
    }, { timeS: 0, width: 1, height: 1 });
    expect(wild.zoom).toBe(4);
    expect(wild.warp).toBe(1);
    expect(wild.displacement).toBe(1);
    expect(wild.glow).toBe(0);
    expect(wild.flow).toBe(0);
    expect(wild.brightness).toBe(2);
    expect(wild.contrast).toBe(0);
    expect(wild.symmetry).toBe(16);
    // -30° → 330° → 11π/6
    expect(wild.hue).toBeCloseTo((11 * Math.PI) / 6, 6);
  });

  it('liefert bei NaN/Infinity sichere Vorgaben (kein NaN auf die GPU)', () => {
    const bad = packUniforms(preset, {
      zoom: Number.NaN,
      rotation: Number.NaN,
      warp: Number.POSITIVE_INFINITY,
      hue: Number.NaN,
      flow: Number.NaN,
      brightness: Number.NaN,
      contrast: Number.NaN,
      displacement: Number.NaN,
      glow: Number.NaN,
      symmetry: Number.NaN,
    }, { timeS: Number.NaN, width: Number.NaN, height: 0 });
    for (const value of Object.values(bad)) {
      if (typeof value === 'number') expect(Number.isFinite(value), String(value)).toBe(true);
    }
    expect(bad.colors.every((c) => Number.isFinite(c))).toBe(true);
    expect(bad.resolution.every((v) => Number.isFinite(v) && v >= 1)).toBe(true);
    expect(bad.symmetry).toBe(1);
  });

  it('begrenzt Paletten auf 6 Farben (WebGL1-Uniform-Limit)', () => {
    const many: VisualPreset = {
      ...preset,
      palette: { colors: Array.from({ length: 10 }, (_, i) => [i / 10, 0.5, 0.5] as [number, number, number]), hueBase: 0 },
    };
    const u = packUniforms(many, params, { timeS: 0, width: 10, height: 10 });
    expect(u.colors).toHaveLength(MAX_SHADER_COLORS * 3);
    expect(u.colorCount).toBe(MAX_SHADER_COLORS);
  });
});

describe('WebGL-Renderer – Show-Szenen als Textur (VISUAL-P1-008)', () => {
  it('deklariert die Szenen-Uniforms und sampelt die Texturen', () => {
    const src = buildFragmentShader();
    for (const name of ['u_sceneA', 'u_sceneB']) {
      expect(SHADER_UNIFORMS).toContain(name);
      expect(src).toContain(`uniform sampler2D ${name};`);
    }
    for (const name of ['u_sceneMix', 'u_sceneAmount']) {
      expect(SHADER_UNIFORMS).toContain(name);
      expect(src).toContain(`uniform float ${name};`);
    }
    for (const name of ['u_sceneSpanA', 'u_sceneSpanB']) {
      expect(SHADER_UNIFORMS).toContain(name);
      expect(src).toContain(`uniform vec2 ${name};`);
    }
    expect(src).toContain('texture2D(u_sceneA');
    expect(src).toContain('texture2D(u_sceneB');
    // Ohne Szene (amount 0) bleibt das generative Feld unberührt.
    expect(src).toContain('if (u_sceneAmount > 0.0)');
  });

  it('legt das Bild im Cover-Fit passend zum Seitenverhältnis (kein Verzerren)', () => {
    // Canvas 16:9, Bild 1:1 → Breite voll, Höhe beschnitten.
    const [sx1, sy1] = sceneCoverSpan(1600, 900, 1000, 1000);
    expect(sx1).toBeCloseTo(1, 6);
    expect(sy1).toBeCloseTo(9 / 16, 6);

    // Canvas 1:1, Bild 16:9 → Höhe voll, Breite beschnitten.
    const [sx2, sy2] = sceneCoverSpan(1000, 1000, 1600, 900);
    expect(sx2).toBeCloseTo(9 / 16, 6);
    expect(sy2).toBeCloseTo(1, 6);

    // Gleiches Seitenverhältnis → keine Beschneidung.
    expect(sceneCoverSpan(1920, 1080, 1280, 720)).toEqual([1, 1]);
  });

  it('liefert für unbekannte/ungültige Medien eine neutrale Spanne', () => {
    expect(sceneCoverSpan(800, 600, 0, 0)).toEqual([1, 1]);
    expect(sceneCoverSpan(Number.NaN, 0, Number.NaN, Number.POSITIVE_INFINITY)).toEqual([1, 1]);
  });

  it('liest die Pixelmaße von Bild, Video und Canvas', () => {
    expect(mediaSize({ naturalWidth: 1024, naturalHeight: 768 } as unknown as TexImageSource)).toEqual([1024, 768]);
    expect(mediaSize({ videoWidth: 1920, videoHeight: 1080 } as unknown as TexImageSource)).toEqual([1920, 1080]);
    expect(mediaSize({ width: 320, height: 240 } as unknown as TexImageSource)).toEqual([320, 240]);
    expect(mediaSize(null)).toEqual([0, 0]);
    expect(mediaSize({ naturalWidth: 0, naturalHeight: 0 } as unknown as TexImageSource)).toEqual([0, 0]);
  });
});
