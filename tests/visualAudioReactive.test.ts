import { describe, expect, it } from 'vitest';
import {
  blendParams,
  clamp,
  clamp01,
  deriveEnergy,
  idleParams,
  mapAudioToParams,
  normalizeFeatures,
  wrap360,
} from '../src/core/visual/audioReactive';
import { VISUAL_PRESETS, VISUAL_PRESET_IDS, presetById } from '../src/core/visual/visualPresets';
import { IDLE_AUDIO_FEATURES, type AudioFeatures } from '../src/core/visual/types';

const FULL_BASS: AudioFeatures = { ...IDLE_AUDIO_FEATURES, bass: 1 };
const FULL_TREBLE: AudioFeatures = { ...IDLE_AUDIO_FEATURES, treble: 1 };

describe('VisualMONK – Audio → Visual', () => {
  it('klemmt Werte sauber', () => {
    expect(clamp01(-3)).toBe(0);
    expect(clamp01(2.5)).toBe(1);
    expect(clamp01(Number.NaN)).toBe(0);
    expect(clamp(5, 0, 4)).toBe(4);
    expect(wrap360(-90)).toBe(270);
    expect(wrap360(450)).toBe(90);
    expect(wrap360(Number.NaN)).toBe(0);
  });

  it('normalisiert rohe Features auf 0..1', () => {
    const f = normalizeFeatures({ bass: 2, mid: -1, treble: 0.5, rms: 99, onset: NaN, bpm: -120 });
    expect(f.bass).toBe(1);
    expect(f.mid).toBe(0);
    expect(f.treble).toBe(0.5);
    expect(f.rms).toBe(1);
    expect(f.onset).toBe(0);
    expect(f.bpm).toBe(0);
  });

  it('leitet Energie aus den Bändern ab, wenn sie fehlt', () => {
    expect(deriveEnergy({ ...IDLE_AUDIO_FEATURES, bass: 0.9, mid: 0.9, treble: 0.9 })).toBeCloseTo(0.9, 5);
    expect(deriveEnergy({ ...IDLE_AUDIO_FEATURES, energy: 0.4, bass: 0 })).toBe(0.4);
  });

  it('bleibt in Stille ruhig (Zoom = Basis, kein Displacement)', () => {
    const preset = presetById('fractal');
    const p = idleParams(preset);
    expect(p.zoom).toBeCloseTo(preset.base.zoom, 6);
    expect(p.displacement).toBe(0);
    expect(p.brightness).toBeCloseTo(0.15, 6);
    expect(p.symmetry).toBe(preset.base.symmetry);
    expect(p.hue).toBeCloseTo(preset.palette.hueBase, 6);
  });

  it('reagiert monoton: mehr Bass ⇒ mehr Zoom und Displacement', () => {
    const preset = presetById('liquid');
    const quiet = mapAudioToParams({ ...IDLE_AUDIO_FEATURES, bass: 0.2 }, preset, 0);
    const loud = mapAudioToParams(FULL_BASS, preset, 0);
    expect(loud.zoom).toBeGreaterThan(quiet.zoom);
    expect(loud.displacement).toBeGreaterThan(quiet.displacement);
    expect(loud.displacement).toBeCloseTo(0.85, 6);
  });

  it('reagiert auf Höhen (Rotation/Kontrast) und hält den Farbton im Kreis', () => {
    const preset = presetById('plasma');
    const a = mapAudioToParams(IDLE_AUDIO_FEATURES, preset, 4);
    const b = mapAudioToParams(FULL_TREBLE, preset, 4);
    expect(b.contrast).toBeGreaterThan(a.contrast);
    expect(b.rotation).toBeGreaterThan(a.rotation);
    for (const p of [a, b, mapAudioToParams({ ...FULL_TREBLE, energy: 1 }, preset, 123.4)]) {
      expect(p.hue).toBeGreaterThanOrEqual(0);
      expect(p.hue).toBeLessThan(360);
    }
  });

  it('ist deterministisch und überblendbar', () => {
    const preset = presetById('particles');
    const f: AudioFeatures = { bass: 0.6, mid: 0.4, treble: 0.3, rms: 0.5, onset: 0.7, energy: 0.5, bpm: 128 };
    const one = mapAudioToParams(f, preset, 12.5);
    const two = mapAudioToParams(f, preset, 12.5);
    expect(two).toEqual(one);

    const target = idleParams(preset);
    expect(blendParams(one, target, 0)).toEqual(one);
    expect(blendParams(one, target, 1)).toEqual(target);
    const mid = blendParams(one, target, 0.5);
    expect(mid.zoom).toBeCloseTo((one.zoom + target.zoom) / 2, 6);
  });

  it('führt eindeutige Presets mit UI-IDs', () => {
    expect(new Set(VISUAL_PRESET_IDS).size).toBe(VISUAL_PRESETS.length);
    expect(VISUAL_PRESETS.length).toBeGreaterThanOrEqual(8);
    expect(presetById('gibt-es-nicht').id).toBe(VISUAL_PRESETS[0].id);
  });
});
