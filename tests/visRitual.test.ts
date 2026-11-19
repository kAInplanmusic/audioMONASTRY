/**
 * Ritual-Bausteine der Visual-Engine: Beat-/Takt-Phase, taktgenaue Szenenwechsel, Ebenen-Rollen, Phasen-Makros.
 */
import { describe, expect, it } from 'vitest';
import { normalizeFeatures } from '../src/core/visual/audioReactive';
import { applyLayerRole } from '../src/core/visual/layerRoles';
import {
  createShowState,
  QUANTIZE_MAX_WAIT_S,
  tickShow,
  type ShowScene,
  type ShowState,
} from '../src/core/visual/showOrchestrator';
import type { AudioFeatures } from '../src/core/visual/types';
import { PHASE_IDS, PHASES, phaseById } from '../src/core/visual/visPhases';
import { VISUAL_PRESETS } from '../src/core/visual/visualPresets';

const scene = (id: string, kind: 'image' | 'clip' = 'image'): ShowScene => ({ id, label: id, prompt: '', kind, src: 'data:,', durationS: 5 });
const scenes = [scene('a'), scene('b')];
const quiet = (extra: Partial<AudioFeatures> = {}) => normalizeFeatures({ bass: 0.2, mid: 0.2, treble: 0.2, rms: 0.2, onset: 0, energy: 0.2, bpm: 120, ...extra });

/** Läuft die Show von `fromMs` bis `toMs` in 50-ms-Schritten und liefert den ersten Wechselzeitpunkt (oder null). */
function firstAdvance(opts: Parameters<typeof tickShow>[4], phaseAt: (ms: number) => Partial<AudioFeatures>, toMs = 20000) {
  let state: ShowState = createShowState(0, 0, 0.2);
  for (let ms = 0; ms <= toMs; ms += 50) {
    const tick = tickShow(state, scenes, quiet(phaseAt(ms)), ms, opts);
    if (tick.advanced) return { ms, reason: tick.reason };
    state = tick.state;
  }
  return null;
}

describe('beat and bar phase features', () => {
  it('are optional, wrapped into [0, 1) and dropped when not finite', () => {
    expect(normalizeFeatures({}).beatPhase).toBeUndefined();
    expect(normalizeFeatures({ beatPhase: 1.25, barPhase: -0.25 })).toMatchObject({ beatPhase: 0.25, barPhase: 0.75 });
    expect(normalizeFeatures({ beatPhase: 1 }).beatPhase).toBe(0);
    expect(normalizeFeatures({ beatPhase: Number.NaN }).beatPhase).toBeUndefined();
  });
});

describe('quantized scene changes', () => {
  // 120 BPM: ein Takt (4 Schläge) dauert 2 s, Phase läuft 0..1 pro Takt.
  const barPhase = (ms: number) => ({ barPhase: ((ms / 1000) % 2) / 2 });

  it('without quantize the due change happens at the scene duration, as before', () => {
    expect(firstAdvance({ quantize: 'off', minDwellS: 1 }, barPhase)).toMatchObject({ ms: 5000, reason: 'duration' });
  });

  it('with quantize=bar the due change waits for the next bar line', () => {
    const result = firstAdvance({ quantize: 'bar', minDwellS: 1 }, barPhase);
    expect(result?.reason).toBe('duration');
    expect(result!.ms).toBeGreaterThanOrEqual(5000);
    expect(result!.ms % 2000).toBe(0);                      // genau auf der Taktgrenze (Phase springt von ~1 auf 0)
    expect(result!.ms).toBeLessThan(5000 + 2050);           // höchstens ein Takt Wartezeit
  });

  it('a hard onset cut also snaps to the beat line when quantize=beat', () => {
    const beatPhase = (ms: number) => ({ beatPhase: ((ms / 1000) % 0.5) / 0.5, onset: ms >= 2000 ? 1 : 0 });
    const result = firstAdvance({ quantize: 'beat', minDwellS: 1 }, beatPhase);
    expect(result?.reason).toBe('beat');
    expect(result!.ms).toBeGreaterThanOrEqual(2000);
    expect(result!.ms % 500).toBe(0);
  });

  it('never waits forever: when the phase never wraps, the change comes after the maximum wait', () => {
    const frozen = () => ({ barPhase: 0.5 });
    const result = firstAdvance({ quantize: 'bar', minDwellS: 1 }, frozen);
    expect(result?.ms).toBeGreaterThanOrEqual(5000 + QUANTIZE_MAX_WAIT_S * 1000 - 50);
    expect(result?.ms).toBeLessThanOrEqual(5000 + QUANTIZE_MAX_WAIT_S * 1000 + 100);
  });

  it('without a phase feature quantize changes nothing', () => {
    expect(firstAdvance({ quantize: 'bar', minDwellS: 1 }, () => ({}))).toMatchObject({ ms: 5000, reason: 'duration' });
  });
});

describe('layer roles', () => {
  const f = normalizeFeatures({ bass: 0.8, mid: 0.4, treble: 0.4, rms: 0.5, onset: 0.9, energy: 0.6, bpm: 128 });

  it('clips follow bass and energy, not highs or hard hits', () => {
    const r = applyLayerRole(f, 'clip');
    expect(r.bass).toBeGreaterThan(f.bass);
    expect(r.treble).toBeLessThan(f.treble);
    expect(r.onset).toBeLessThan(f.onset);
    expect(r.energy).toBe(f.energy);
    expect(r.bass).toBeLessThanOrEqual(1);
  });

  it('images follow mids and highs (melody approximation) and step back from the bass', () => {
    const r = applyLayerRole(f, 'image');
    expect(r.mid).toBeGreaterThan(f.mid);
    expect(r.treble).toBeGreaterThan(f.treble);
    expect(r.bass).toBeLessThan(f.bass);
  });

  it('keeps the beat phase and leaves unknown layers untouched', () => {
    const withPhase = normalizeFeatures({ ...f, beatPhase: 0.3, barPhase: 0.6 });
    expect(applyLayerRole(withPhase, 'clip')).toMatchObject({ beatPhase: 0.3, barPhase: 0.6 });
    expect(applyLayerRole(f, undefined)).toBe(f);
  });
});

describe('phase macros', () => {
  it('offers build, trance, peak and release with real presets and sane values', () => {
    expect(PHASE_IDS).toEqual(['build', 'trance', 'peak', 'release']);
    for (const phase of PHASES) {
      expect(VISUAL_PRESETS.some((p) => p.id === phase.presetId)).toBe(true);
      expect(phase.maxEffects).toBeGreaterThanOrEqual(1);
      expect(phase.maxEffects).toBeLessThanOrEqual(4);
      expect(['beat', 'bar']).toContain(phase.show.quantize);
    }
  });

  it('peak is the fastest and hardest phase, release the calmest', () => {
    const peak = phaseById('peak')!;
    const release = phaseById('release')!;
    for (const other of PHASES.filter((p) => p.id !== 'peak')) {
      expect(peak.show.minDwellS).toBeLessThan(other.show.minDwellS);
      expect(peak.show.fadeS).toBeLessThan(other.show.fadeS);
      expect(peak.maxEffects).toBeGreaterThanOrEqual(other.maxEffects);
    }
    expect(release.show.fadeS).toBe(Math.max(...PHASES.map((p) => p.show.fadeS)));
    expect(phaseById('nope')).toBeUndefined();
    expect(phaseById(null)).toBeUndefined();
  });
});
