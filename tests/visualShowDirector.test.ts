/**
 * MEDIA-2026-11-04-006 — Regie im Show-Pfad.
 * ==========================================
 * Der Live-Pfad (`tickShow` → `useVisualShow`) muss die Auswahl vom
 * sequenziellen Karussell auf den deterministischen `visualDirector` umstellen:
 *
 *   * Seed aus der Session  → gleicher Seed + gleiche Features = gleiche Folge
 *   * Mood/Energie aus den Audio-Features → passende Clips häufiger
 *   * Wiederholungssperre der letzten N Clips
 *   * Variantendauern aus `DURATION_BY_VARIANT` (einzige Dauerquelle)
 *
 * Die Tests laufen bewusst ohne DOM: Show-Kern und Regisseur sind rein.
 */
import { describe, expect, it } from 'vitest';
import {
  createShowState,
  effectiveDurationS,
  tickShow,
  type ShowScene,
} from '../src/core/visual/showOrchestrator';
import {
  DIRECTOR_DEFAULTS,
  createDirectorState,
  deriveSessionSeed,
  pickNextScene,
  tickDirector,
  type DirectorOptions,
  type DirectorState,
} from '../src/visuals/visualDirector';
import {
  DURATION_BY_VARIANT,
  IMPORTED_POOL,
  poolEntryBySrc,
  variantDurationS,
  type PoolEnergy,
  type PoolMood,
} from '../src/visuals/poolManifest';
import { IDLE_AUDIO_FEATURES, type AudioFeatures } from '../src/core/visual/types';

/** Szene mit Regie-Metadaten (so reicht sie der Hook aus dem Pool herein). */
function scene(id: string, mood: PoolMood, energy: PoolEnergy, durationS = 2): ShowScene {
  return {
    id,
    label: id,
    prompt: id,
    kind: 'clip',
    src: `/api/ai/vision/bank/${id}`,
    durationS,
    mediaDurationS: durationS,
    mood,
    energy,
    poolId: id,
  };
}

function pool(): ShowScene[] {
  return [
    scene('dunkel-hart', 'duester', 'hart'),
    scene('dunkel-ruhig', 'duester', 'ruhig'),
    scene('cool-hart', 'cool', 'hart'),
    scene('cool-ruhig', 'cool', 'ruhig'),
    scene('lustig-mittel', 'lustig', 'mittel'),
    scene('neutral-mittel', 'neutral', 'mittel'),
  ];
}

/** Tickt die Show im 500-ms-Raster und notiert jeden Wechsel. */
function runShow(
  seed: number,
  featuresAt: (tick: number) => AudioFeatures,
  ticks = 40,
  opts: { repeatWindow?: number; scenes?: ShowScene[] } = {},
): string[] {
  const scenes = opts.scenes ?? pool();
  let state = createShowState(0, 0, 0, seed);
  const seq: string[] = [];
  for (let i = 0; i < ticks; i += 1) {
    const nowMs = (i + 1) * 500;
    const tick = tickShow(state, scenes, featuresAt(i), nowMs, {
      seed,
      ...(opts.repeatWindow === undefined ? {} : { repeatWindow: opts.repeatWindow }),
    });
    state = tick.state;
    if (tick.advanced) seq.push(scenes[tick.sceneIndex].id);
  }
  return seq;
}

const hardFeatures = (_tick: number): AudioFeatures => ({ ...IDLE_AUDIO_FEATURES, energy: 0.95, bass: 0.9, onset: 0, bpm: 140 });
const calmFeatures = (_tick: number): AudioFeatures => ({ ...IDLE_AUDIO_FEATURES, energy: 0.05, bass: 0.05, onset: 0, bpm: 80 });

describe('MEDIA-2026-11-04-006 — deterministische Regie im Show-Pfad', () => {
  it('gleicher Seed + gleiche Features ergeben dieselbe Folge', () => {
    expect(runShow(4711, hardFeatures)).toEqual(runShow(4711, hardFeatures));
  });

  it('gleicher Seed, aber andere Features ergeben eine andere Folge (Audio wirkt)', () => {
    expect(runShow(4711, hardFeatures)).not.toEqual(runShow(4711, calmFeatures));
  });

  it('verschiedene Seeds ergeben verschiedene Folgen (Seed steuert die Regie)', () => {
    expect(runShow(4711, hardFeatures, 60)).not.toEqual(runShow(991, hardFeatures, 60));
  });

  it('sperrt die letzten N Clips gegen Wiederholung', () => {
    const seq = runShow(4711, hardFeatures, 80, { repeatWindow: 3 });
    expect(seq.length).toBeGreaterThan(8);
    for (let i = 3; i < seq.length; i += 1) {
      expect(seq.slice(i - 3, i)).not.toContain(seq[i]);
    }
  });

  it('bevorzugt bei hoher Energie harte Clips und bei ruhigem Teil ruhige', () => {
    const count = (seq: string[], suffix: string) => seq.filter((id) => id.endsWith(suffix)).length;
    let hardRunHard = 0;
    let hardRunCalm = 0;
    let calmRunCalm = 0;
    let calmRunHard = 0;
    // Viele Seeds, damit das Ergebnis nicht an einem Roll hängt.
    for (let seed = 1; seed <= 40; seed += 1) {
      const loud = runShow(seed, hardFeatures, 160);
      hardRunHard += count(loud, 'hart');
      hardRunCalm += count(loud, 'ruhig');
      const quiet = runShow(seed, calmFeatures, 160);
      calmRunCalm += count(quiet, 'ruhig');
      calmRunHard += count(quiet, 'hart');
    }
    // Beide Richtungen: die Energie verschiebt die Mischung, sie kippt nicht nur.
    expect(hardRunHard).toBeGreaterThan(hardRunCalm * 1.15);
    expect(calmRunCalm).toBeGreaterThan(calmRunHard * 1.15);
  });

  it('wählt nicht zweimal hintereinander denselben Clip', () => {
    const seq = runShow(7, hardFeatures, 60);
    for (let i = 1; i < seq.length; i += 1) {
      expect(seq[i]).not.toBe(seq[i - 1]);
    }
  });

  it('nimmt bei einem zu kleinen Pool lieber den Rest als gar nichts', () => {
    const two = [scene('a', 'cool', 'mittel'), scene('b', 'cool', 'mittel')];
    const seq = runShow(3, hardFeatures, 20, { scenes: two, repeatWindow: 3 });
    expect(new Set(seq)).toEqual(new Set(['a', 'b']));
    // Auch dann gilt: nicht zweimal hintereinander derselbe Clip.
    for (let i = 1; i < seq.length; i += 1) expect(seq[i]).not.toBe(seq[i - 1]);
  });

  it('seedet den Show-Zustand aus der Session-Kennung (stabil je Session)', () => {
    const a = createShowState(0, 0, 0, 1234);
    expect(a.seed).toBe(1234);
    const seeded = tickShow(a, pool(), hardFeatures(0), 2500, { seed: 1234 });
    expect(seeded.state.seed).toBe(1234);
    // Der Wechsel-Zustand behält den Seed (sonst wäre die Folge nicht reproduzierbar).
    expect(seeded.state.seed).toBe(a.seed);
  });
});

describe('MEDIA-2026-11-04-006 — Seed aus der Session', () => {
  it('deriveSessionSeed ist stabil und unterscheidet Sessions', () => {
    expect(deriveSessionSeed('session-a')).toBe(deriveSessionSeed('session-a'));
    expect(deriveSessionSeed('session-a')).not.toBe(deriveSessionSeed('session-b'));
    expect(Number.isInteger(deriveSessionSeed('session-a'))).toBe(true);
    expect(deriveSessionSeed(77)).toBe(deriveSessionSeed('77'));
    expect(deriveSessionSeed('')).toBeGreaterThanOrEqual(0);
  });
});

describe('MEDIA-2026-11-04-006 — Variantendauern sind die einzige Dauerquelle', () => {
  it('exportiert die Variantentabelle und liest Dauern daraus', () => {
    expect(DURATION_BY_VARIANT.slow).toBe(8);
    expect(DURATION_BY_VARIANT.loop).toBe(12);
    expect(DURATION_BY_VARIANT.fast).toBe(4.07);
    expect(variantDurationS('slow')).toBe(8);
    // Unbekannte Variante fällt auf die Basis (6 s) zurück.
    expect(variantDurationS('gibtsnicht')).toBe(6);
  });

  it('liefert zu einer Pool-Quelle den Eintrag samt Tabellendauer', () => {
    const slow = IMPORTED_POOL.find((e) => e.id.endsWith('_slow'));
    expect(slow, 'kein Slow-Eintrag im Pool').toBeTruthy();
    const back = poolEntryBySrc(slow!.src);
    expect(back?.id).toBe(slow!.id);
    expect(back?.durationS).toBe(8);
    expect(poolEntryBySrc('/api/ai/vision/bank/gibt-es-nicht')).toBeNull();
  });

  it('lässt eine Szene mit Variantendauer 8 s auch 8 s stehen', () => {
    const slow = IMPORTED_POOL.find((e) => e.id.endsWith('_slow'))!;
    const show: ShowScene[] = [
      { id: 'slow', label: 'slow', prompt: 'slow', kind: 'clip', src: slow.src, durationS: slow.durationS, mediaDurationS: slow.durationS },
      scene('next', 'cool', 'mittel', 8),
    ];
    expect(effectiveDurationS(show[0])).toBe(8);
    // Energiereferenz = Pegel, damit hier wirklich die Dauer (und nicht der
    // Energie-Sprung) den Wechsel auslöst.
    const steady: AudioFeatures = { ...IDLE_AUDIO_FEATURES, energy: 0.5 };
    const early = tickShow(createShowState(0, 0, 0.5, 5), show, steady, 7_500, { seed: 5 });
    expect(early.advanced).toBe(false);
    const late = tickShow(early.state, show, steady, 8_100, { seed: 5 });
    expect(late.advanced).toBe(true);
    expect(late.reason).toBe('duration');
  });
});

describe('MEDIA-2026-11-04-006 — Regisseur selbst (tickDirector)', () => {
  const pool6 = () => [
    scene('a', 'cool', 'mittel'),
    scene('b', 'duester', 'hart'),
    scene('c', 'lustig', 'ruhig'),
    scene('d', 'neutral', 'mittel'),
    scene('e', 'cool', 'hart'),
    scene('f', 'duester', 'ruhig'),
  ];

  it('hält die Wiederholungssperre auch über den reinen Regisseur ein', () => {
    let state: DirectorState = createDirectorState(4711, 0);
    const scenes = pool6();
    const seq: string[] = [];
    for (let t = 1; t <= 60; t += 1) {
      const tick = tickDirector(state, scenes, hardFeatures(t), t * 2500, { repeatWindow: 2 });
      state = tick.state;
      if (tick.advanced) seq.push(scenes[tick.sceneIndex].id);
    }
    expect(seq.length).toBeGreaterThan(8);
    for (let i = 2; i < seq.length; i += 1) {
      expect(seq.slice(i - 2, i)).not.toContain(seq[i]);
    }
  });

  it('pickNextScene meidet gesperrte Indizes', () => {
    const scenes = pool6();
    const state: DirectorState = {
      ...createDirectorState(4711, 0),
      index: 0,
      recent: [0, 1, 2],
    };
    const opts: Required<DirectorOptions> = { ...DIRECTOR_DEFAULTS, repeatWindow: 3 };
    for (let i = 0; i < 40; i += 1) {
      const next = pickNextScene(scenes, { ...state, transitions: i }, hardFeatures(i), opts);
      expect([0, 1, 2]).not.toContain(next);
    }
  });

  it('fällt bei vollem Sperrfenster auf den Rest des Pools zurück', () => {
    const scenes = pool6().slice(0, 2);
    const state: DirectorState = { ...createDirectorState(1, 0), index: 0, recent: [0, 1] };
    const opts: Required<DirectorOptions> = { ...DIRECTOR_DEFAULTS, repeatWindow: 3 };
    const next = pickNextScene(scenes, state, hardFeatures(0), opts);
    expect(next).toBeGreaterThanOrEqual(0);
    expect(next).toBeLessThan(2);
  });
});
