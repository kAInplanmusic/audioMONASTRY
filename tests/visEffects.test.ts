import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DIRECTOR_DEFAULTS,
  EFFECTS,
  EFFECT_IDS,
  createDirector,
  directEffects,
  orderPicks,
} from '../src/core/visual/effects/registry';
import { EFFECT_SOURCES, fragmentFor } from '../src/core/visual/effects/shaders';
import { IDLE_AUDIO_FEATURES, type AudioFeatures } from '../src/core/visual/types';

const loud: AudioFeatures = { bass: 0.9, mid: 0.7, treble: 0.6, rms: 0.8, onset: 0.9, energy: 0.95, bpm: 128 };
const calm: AudioFeatures = { bass: 0.1, mid: 0.2, treble: 0.1, rms: 0.15, onset: 0, energy: 0.1, bpm: 90 };

describe('vis effects: the 25 requested', () => {
  it('has 25 unique effects, each with a shader and German label', () => {
    expect(EFFECTS).toHaveLength(25);
    expect(new Set(EFFECT_IDS).size).toBe(25);
    expect(Object.keys(EFFECT_SOURCES).sort()).toEqual([...EFFECT_IDS].sort());
    for (const effect of EFFECTS) {
      expect(effect.label.length).toBeGreaterThan(3);
      expect(fragmentFor(effect.id)).toContain('vec3 effect(vec2 uv, vec3 src)');
    }
  });

  it('keeps the committed effect list (read by the pod) in step with the registry', () => {
    const file = JSON.parse(readFileSync('services/audiomonastry-ai-runtime/visual/effects.json', 'utf8'));
    expect(file.effects.map((e: { id: string }) => e.id)).toEqual([...EFFECT_IDS]);
  });

  it('orders effects geometry-first and drops unknown, duplicate and zero entries', () => {
    const ordered = orderPicks([
      { id: 'glitch', amount: 1 }, { id: 'kaleido', amount: 2 }, { id: 'nope', amount: 1 },
      { id: 'kaleido', amount: 1 }, { id: 'bloom', amount: 0 },
    ]);
    expect(ordered.map((p) => p.id)).toEqual(['kaleido', 'glitch']);
    expect(ordered[0].amount).toBe(1);
  });
});

describe('vis effects: director', () => {
  const run = (features: AudioFeatures, sceneKey = '0', seed = 7, max = 3) =>
    directEffects(createDirector(), features, 0, sceneKey, { seed, max }).picks;

  it('is deterministic for the same seed, scene and audio', () => {
    expect(run(loud)).toEqual(run(loud));
  });

  it('varies with the scene so every scene gets its own character', () => {
    const looks = new Set(Array.from({ length: 12 }, (_, i) => run(loud, String(i)).map((p) => p.id).join(',')));
    expect(looks.size).toBeGreaterThan(3);
  });

  it('uses 1 effect when calm and more at peaks, never above max, never two mosaic/stylize', () => {
    expect(run(calm)).toHaveLength(1);
    for (let scene = 0; scene < 40; scene++) {
      for (const max of [1, 2, 3, 4]) {
        const picks = run(loud, String(scene), scene, max);
        expect(picks.length).toBeGreaterThanOrEqual(1);
        expect(picks.length).toBeLessThanOrEqual(max);
        const heavy = picks.filter((p) => EFFECTS.find((e) => e.id === p.id)!.group === 'mosaic'
          || EFFECTS.find((e) => e.id === p.id)!.group === 'stylize');
        expect(heavy.length).toBeLessThanOrEqual(1);
        for (const p of picks) {
          expect(p.amount).toBeGreaterThanOrEqual(0.25);
          expect(p.amount).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('keeps the selection until the scene changes, a beat comes after the dwell time, or 12 s pass', () => {
    let state = createDirector();
    const first = directEffects(state, calm, 0, 'a', DIRECTOR_DEFAULTS);
    state = first.state;
    const ids = (picks: { id: string }[]) => picks.map((p) => p.id).join(',');
    // same scene, quiet: selection stays, only amounts follow the sound
    expect(ids(directEffects(state, loud, 1000, 'a', { ...DIRECTOR_DEFAULTS, minDwellS: 3 }).picks)).toBe(ids(first.picks));
    // a beat inside the dwell time does not re-pick
    const beatEarly = directEffects(state, { ...loud, onset: 1 }, 1500, 'a', { ...DIRECTOR_DEFAULTS, minDwellS: 3 });
    expect(beatEarly.state).toBe(state);
    // a beat after the dwell time re-picks
    const beatLate = directEffects(state, { ...loud, onset: 1 }, 4000, 'a', { ...DIRECTOR_DEFAULTS, minDwellS: 3 });
    expect(beatLate.state.sinceMs).toBe(4000);
    // a scene change re-picks immediately
    expect(directEffects(state, calm, 100, 'b', DIRECTOR_DEFAULTS).state.sceneKey).toBe('b');
    // silence never yields an empty chain
    expect(directEffects(createDirector(), IDLE_AUDIO_FEATURES, 0, 'a').picks.length).toBeGreaterThan(0);
  });
});
