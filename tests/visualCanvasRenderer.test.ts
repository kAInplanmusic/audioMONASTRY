import { describe, expect, it } from 'vitest';
import {
  baseMix,
  createRendererState,
  drawModeForPreset,
  mulberry32,
  rgba,
  spawnParticle,
  updateParticles,
} from '../src/core/visual/canvasRenderer';
import { presetById } from '../src/core/visual/visualPresets';
import { mapAudioToParams, idleParams } from '../src/core/visual/audioReactive';
import { IDLE_AUDIO_FEATURES, type AudioFeatures } from '../src/core/visual/types';

describe('VisualMONK – Canvas-Renderer (pure Teile)', () => {
  it('erzeugt deterministischen Zufall', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const seqA = [a(), a(), a()];
    const seqB = [b(), b(), b()];
    expect(seqA).toEqual(seqB);
    expect(mulberry32(43)()).not.toBe(seqA[0]);
  });

  it('formatiert und klemmt Farben', () => {
    expect(rgba([1, 0, 0], 0.5)).toBe('rgba(255, 0, 0, 0.5)');
    expect(rgba([2, -1, 0.5], 5)).toBe('rgba(255, 0, 128, 1)');
    expect(rgba([0, 0, 0], -1)).toBe('rgba(0, 0, 0, 0)');
  });

  it('spawnt Partikel innerhalb des Canvas', () => {
    const rng = mulberry32(7);
    const p = spawnParticle(rng, 800, 450);
    expect(p.x).toBeGreaterThanOrEqual(0);
    expect(p.x).toBeLessThanOrEqual(800);
    expect(p.y).toBeGreaterThanOrEqual(0);
    expect(p.y).toBeLessThanOrEqual(450);
    expect(p.ttl).toBeGreaterThan(0);
  });

  it('bewegt Partikel und hält die Anzahl stabil (Recycling)', () => {
    const state = createRendererState(64, 21);
    const preset = presetById('particles');
    const params = mapAudioToParams({ ...IDLE_AUDIO_FEATURES, bass: 0.8, energy: 0.7 } as AudioFeatures, preset, 3);
    // Erst füllen (wie im Renderer bei leerem Array):
    for (let i = 0; i < state.count; i += 1) state.particles.push(spawnParticle(state.rng, 640, 360));
    const before = state.particles.map((p) => ({ x: p.x, y: p.y }));
    for (let frame = 0; frame < 120; frame += 1) {
      updateParticles(state.particles, params, 1 / 60, 640, 360, state.rng);
    }
    expect(state.particles).toHaveLength(64);
    const moved = state.particles.some((p, i) => Math.abs(p.x - before[i].x) > 0.5 || Math.abs(p.y - before[i].y) > 0.5);
    expect(moved).toBe(true);
    for (const p of state.particles) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
      expect(p.age).toBeGreaterThanOrEqual(0);
    }
  });

  it('bildet Presets auf stabile Zeichenmodi ab', () => {
    expect(drawModeForPreset(presetById('particles'))).toBe('particles');
    expect(drawModeForPreset(presetById('starfield'))).toBe('starfield');
    expect(drawModeForPreset(presetById('neongrid'))).toBe('grid');
    expect(drawModeForPreset(presetById('wireframe'))).toBe('grid');
    expect(drawModeForPreset(presetById('gradient'))).toBe('gradient');
    expect(drawModeForPreset(presetById('noir'))).toBe('gradient');
    expect(drawModeForPreset(presetById('fractal'))).toBe('aura');
    expect(drawModeForPreset(presetById('psy'))).toBe('aura');
    // Ruhezustand liefert endliche Parameter
    const idle = idleParams(presetById('plasma'));
    for (const v of Object.values(idle)) expect(Number.isFinite(v as number)).toBe(true);
  });

  it('mischt Farben an den Endpunkten exakt', () => {
    const a: [number, number, number] = [0, 0, 0];
    const b: [number, number, number] = [1, 0.5, 0.25];
    expect(baseMix(a, b, 0)).toEqual(a);
    expect(baseMix(a, b, 1)).toEqual(b);
    expect(baseMix(a, b, 0.5)).toEqual([0.5, 0.25, 0.125]);
  });
});
