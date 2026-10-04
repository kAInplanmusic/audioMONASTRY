import { describe, expect, it } from 'vitest';
import {
  createDirectorState,
  currentScene,
  tickDirector,
  pickNextScene,
  type DirectorState,
} from '../src/visuals/visualDirector';
import { poolFromBank } from '../src/visuals/visualBank';
import {
  energyFromBpm,
  pickWeighted,
  type PoolEntry,
} from '../src/visuals/poolManifest';
import { mulberry32 } from '../src/core/visual/canvasRenderer';
import { IDLE_AUDIO_FEATURES, type AudioFeatures } from '../src/core/visual/types';

const pool: PoolEntry[] = [
  { id: 'duester', src: 'a.mp4', kind: 'clip', source: 'erzeugtes-video', mood: 'duester', energy: 'hart', tags: ['neon'], durationS: 3 },
  { id: 'cool', src: 'b.mp4', kind: 'clip', source: 'erzeugtes-video', mood: 'cool', energy: 'mittel', tags: ['geo'], durationS: 3 },
  { id: 'lustig', src: 'c.mp4', kind: 'clip', source: 'erzeugtes-video', mood: 'lustig', energy: 'ruhig', tags: ['lego'], durationS: 3 },
];

function advanceSeq(seed: number, durationMs = 4000): string[] {
  let state: DirectorState = createDirectorState(seed, 0);
  const seq: string[] = [];
  for (let t = 0; t < 30; t += 1) {
    const features: AudioFeatures = { ...IDLE_AUDIO_FEATURES, onset: t % 2 === 0 ? 0.9 : 0.1, energy: 0.5, bpm: 128 };
    const tick = tickDirector(state, pool, features, t * durationMs);
    state = tick.state;
    if (tick.advanced) seq.push(pool[tick.sceneIndex].id);
  }
  return seq;
}

describe('visualDirector', () => {
  it('ist deterministisch: derselbe Seed ergibt dieselbe Folge', () => {
    expect(advanceSeq(4711)).toEqual(advanceSeq(4711));
  });

  it('wechselt die Auswahl bei anderem Seed', () => {
    expect(advanceSeq(4711)).not.toEqual(advanceSeq(999));
  });

  it('rotiert die Stimmung statt dieselbe Szene zu wiederholen', () => {
    const seq = advanceSeq(4711);
    // In 30 Takten muss mehr als eine Szene erscheinen (Rotation greift).
    expect(new Set(seq).size).toBeGreaterThan(1);
  });

  it('schneidet auf harten Onset (beat) nach Mindeststandzeit', () => {
    const longPool: PoolEntry[] = [
      { id: 'a', src: 'a.mp4', kind: 'clip', source: 'erzeugtes-video', mood: 'duester', energy: 'hart', tags: ['neon'], durationS: 10 },
      { id: 'b', src: 'b.mp4', kind: 'clip', source: 'erzeugtes-video', mood: 'cool', energy: 'mittel', tags: ['geo'], durationS: 10 },
    ];
    const state = createDirectorState(4711, 0);
    // 2 s still stehen (minDwellS=3 → noch kein Beat-Wechsel), dann harter Onset.
    const quiet = tickDirector(state, longPool, { ...IDLE_AUDIO_FEATURES, onset: 0, energy: 0 }, 1000);
    expect(quiet.advanced).toBe(false);
    const beat = tickDirector(quiet.state, longPool, { ...IDLE_AUDIO_FEATURES, onset: 1, energy: 0 }, 2000);
    expect(beat.advanced).toBe(false); // unter minDwellS (2 s < 3 s)
    const beatAfter = tickDirector(beat.state, longPool, { ...IDLE_AUDIO_FEATURES, onset: 1, energy: 0 }, 3500);
    expect(beatAfter.advanced).toBe(true);
    expect(beatAfter.reason).toBe('beat');
  });

  it('liefert null für einen leeren Pool', () => {
    expect(currentScene([], createDirectorState())).toBeNull();
  });

  it('pickNextScene wählt deterministisch bei gleichem Seed', () => {
    const s1 = createDirectorState(4711, 0);
    const s2 = createDirectorState(4711, 0);
    const f: AudioFeatures = { ...IDLE_AUDIO_FEATURES, energy: 0.5 };
    expect(pickNextScene(pool, s1, f, { minDwellS: 3, onsetThreshold: 0.6, energyJump: 0.3, maxSceneS: 24 }))
      .toBe(pickNextScene(pool, s2, f, { minDwellS: 3, onsetThreshold: 0.6, energyJump: 0.3, maxSceneS: 24 }));
  });
});

describe('poolManifest', () => {
  it('poolFromBank baut acht Pool-Einträge mit gültiger Stimmung', () => {
    const pool = poolFromBank();
    expect(pool.length).toBe(8);
    const moods = new Set(pool.map((p) => p.mood));
    expect(moods.has('neutral')).toBe(false); // alle Kombinationen sind zugeordnet
    for (const entry of pool) {
      expect(entry.kind).toBe('clip');
      expect(entry.src).toMatch(/^\/api\/ai\/vision\/bank\//);
      expect(entry.durationS).toBeCloseTo(3.03, 2);
    }
  });

  it('leitet Energie aus BPM ab', () => {
    expect(energyFromBpm(90)).toBe('ruhig');
    expect(energyFromBpm(128)).toBe('mittel');
    expect(energyFromBpm(140)).toBe('hart');
    expect(energyFromBpm(0)).toBe('mittel');
  });

  it('pickWeighted ist deterministisch', () => {
    const rngA = mulberry32(7);
    const rngB = mulberry32(7);
    const items = ['x', 'y', 'z'];
    expect(pickWeighted(items, [1, 2, 3], rngA)).toBe(pickWeighted(items, [1, 2, 3], rngB));
  });
});
