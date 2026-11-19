import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { mediaFxValues } from '../src/core/visual/mediaFx';
import { mapAudioToParams } from '../src/core/visual/audioReactive';
import { VISUAL_PRESETS } from '../src/core/visual/visualPresets';
import { IDLE_AUDIO_FEATURES, type AudioFeatures } from '../src/core/visual/types';

const loud: AudioFeatures = { bass: 1, mid: 0.8, treble: 0.8, rms: 0.9, onset: 1, energy: 1, bpm: 128 };

function values(presetIndex: number, features: AudioFeatures, timeS = 5) {
  const preset = VISUAL_PRESETS[presetIndex];
  return mediaFxValues(preset, mapAudioToParams(features, preset, timeS), features, timeS);
}

describe('vis pod scene: media effects', () => {
  it('beat and bass push zoom, chroma split and glitch above the quiet state', () => {
    const quiet = values(0, IDLE_AUDIO_FEATURES);
    const hit = values(0, loud);
    expect(hit.zoom).toBeGreaterThan(quiet.zoom);
    expect(hit.split).toBeGreaterThan(quiet.split);
    expect(quiet.glitch).toBe(0);
    expect(hit.glitch).toBe(1);
    expect(hit.bright).toBeGreaterThan(quiet.bright);
  });

  it('keeps every effect strength inside a safe range, also for extreme input', () => {
    for (let i = 0; i < VISUAL_PRESETS.length; i++) {
      for (const t of [0, 1.5, 1000, 123456]) {
        const v = values(i, loud, t);
        expect(v.zoom).toBeLessThanOrEqual(1.3);
        expect(v.zoom).toBeGreaterThan(0.9);
        expect(v.bright).toBeGreaterThanOrEqual(0.75);
        expect(v.bright).toBeLessThanOrEqual(1.25);
        expect(v.glow).toBeLessThanOrEqual(1);
        expect(v.kaleido).toBeLessThanOrEqual(0.85);
        expect(Number.isFinite(v.hue)).toBe(true);
      }
    }
  });

  it('only mirrors (kaleidoscope) for presets that define symmetry', () => {
    const flat = VISUAL_PRESETS.findIndex((p) => p.base.symmetry <= 1);
    const mirrored = VISUAL_PRESETS.findIndex((p) => p.base.symmetry > 1);
    if (flat >= 0) expect(values(flat, loud).kaleido).toBe(0);
    if (mirrored >= 0) expect(values(mirrored, loud).kaleido).toBeGreaterThan(0);
  });
});

describe('vis pod scene: committed bundle', () => {
  it('services/audiomonastry-ai-runtime/visual/scene.js matches its sources', () => {
    // The Docker context has no src/, so the bundle is committed; this fails when it is stale.
    expect(() => execFileSync('node', ['scripts/build-vis-scene.mjs', '--check'], { stdio: 'pipe' })).not.toThrow();
  });
});
