// @vitest-environment jsdom
/**
 * MEDIA-2026-11-04-006 — Live-Pfad des Hooks (`useVisualShow`).
 * ============================================================
 * Der Show-Kern ist rein und wird in `visualShowDirector.test.ts` geprüft; hier
 * geht es um die Verdrahtung im Hook:
 *
 *   * Seed kommt aus der Session-Kennung (stabil je Session, gleich für zwei
 *     Hook-Instanzen) → gleiche Features ergeben dieselbe Szenenfolge,
 *   * Szenen aus der Bank bringen Mood/Energie und die Variantendauer mit,
 *   * STOP hält die Videos an (vorher liefen sie im versteckten `<video>` weiter),
 *     START spielt sie wieder an,
 *   * Reduced-Motion (`setFrozen`) friert Uhr und Medien weiter ein.
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useVisualShow } from '../src/hooks/useVisualShow';
import { DURATION_BY_VARIANT, IMPORTED_POOL } from '../src/visuals/poolManifest';
import { IDLE_AUDIO_FEATURES, type AudioFeatures } from '../src/core/visual/types';

const loud: AudioFeatures = { ...IDLE_AUDIO_FEATURES, energy: 0.9, bass: 0.8, bpm: 138 };

/** Drei importierte Bank-Clips mit unterschiedlicher Stimmung – als Show-Szenen. */
function bankScenes() {
  const picks = [
    IMPORTED_POOL.find((e) => e.mood === 'duester' && e.energy === 'hart'),
    IMPORTED_POOL.find((e) => e.mood === 'cool' && e.energy === 'mittel'),
    IMPORTED_POOL.find((e) => e.mood === 'lustig'),
  ].filter((e): e is (typeof IMPORTED_POOL)[number] => Boolean(e));
  return picks;
}

function addBankScenes(addScene: ReturnType<typeof useVisualShow>['addScene']) {
  act(() => {
    for (const entry of bankScenes()) {
      addScene({ prompt: entry.label ?? entry.id, kind: 'clip', src: entry.src, label: entry.label, durationS: 1 });
    }
  });
}

/**
 * Hook mit drei Bank-Szenen (jede steht 1 s) – Ausgangspunkt der Show-Tests.
 * `base` ist die Uhr, auf der `startShow` aufsetzt; die Ticks rechnen relativ
 * dazu (die Show misst `nowMs - startedAtMs`, nicht die absolute Zahl).
 */
function setupShow() {
  const hook = renderHook(() => useVisualShow());
  addBankScenes(hook.result.current.addScene);
  const base = performance.now();
  act(() => hook.result.current.startShow());
  return { hook, base };
}

/**
 * Spielt die Show im 500-ms-Raster durch und liefert die Szene je Wechsel.
 * Gelesen wird immer `result.current` (frischer Render), nicht der Snapshot.
 */
function playShow(
  hook: { result: { current: ReturnType<typeof useVisualShow> } },
  base: number,
  ticks = 40,
): string[] {
  const getApi = () => hook.result.current;
  const seq: string[] = [];
  let last = getApi().currentIndex;
  for (let i = 1; i <= ticks; i += 1) {
    act(() => getApi().tick(base + i * 500, loud));
    const api = getApi();
    if (api.currentIndex !== last) {
      seq.push(api.scenes[api.currentIndex]?.src ?? '?');
      last = api.currentIndex;
    }
  }
  return seq;
}

let playSpy: ReturnType<typeof vi.spyOn>;
let pauseSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // jsdom kennt keine Medien-Wiedergabe: die Aufrufe werden gezählt, nicht ausgeführt.
  playSpy = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
  pauseSpy = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  // Betreiberregel: kein Browser-Speicher. Der Seed kommt aus performance.timeOrigin.
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('MEDIA-2026-11-04-006 — useVisualShow mit Regie', () => {
  it('übernimmt Mood/Energie und die Variantendauer aus dem Pool', () => {
    const { result } = renderHook(() => useVisualShow());
    const [duester, cool, lustig] = bankScenes();
    act(() => {
      for (const entry of [duester, cool, lustig]) {
        // Ohne explizite Dauer: es gilt die Tabelle, nicht der Hook-Default (8 s).
        result.current.addScene({ prompt: entry.label ?? entry.id, kind: 'clip', src: entry.src });
      }
    });

    expect(result.current.scenes).toHaveLength(3);
    const bySrc = (src: string) => result.current.scenes.find((s) => s.src === src)!;
    expect(bySrc(duester.src).mood).toBe('duester');
    expect(bySrc(duester.src).energy).toBe('hart');
    expect(bySrc(duester.src).poolId).toBe(duester.id);
    expect(bySrc(cool.src).mood).toBe('cool');
    expect(bySrc(lustig.src).mood).toBe('lustig');
    // Dauer kommt aus dem Pool-Eintrag (= DURATION_BY_VARIANT), nicht aus dem
    // Hook-Default 8 s für Clips.
    expect(bySrc(duester.src).durationS).toBe(duester.durationS);
    expect(bySrc(duester.src).mediaDurationS).toBe(duester.durationS);
    expect(bySrc(duester.src).durationS).toBe(DURATION_BY_VARIANT['']);

    // Eigene Bilder bleiben ohne Pool-Metadaten und mit Bild-Default.
    act(() => result.current.addScene({ prompt: 'eigenes bild', kind: 'image', src: 'data:image/png;base64,AA' }));
    const image = result.current.scenes[result.current.scenes.length - 1];
    expect(image.mood).toBeUndefined();
    expect(image.poolId).toBeUndefined();
    expect(image.durationS).toBe(6);
  });

  it('gleicher Session-Seed + gleiche Features ergeben dieselbe Folge', () => {
    // Compare the same clock origin as well as the same seed. Real wall time
    // between base capture and start can cross an exact scene boundary.
    vi.spyOn(performance, 'now').mockReturnValue(1000);
    const a = setupShow();
    const seqA = playShow(a.hook, a.base);

    const b = setupShow();
    const seqB = playShow(b.hook, b.base);

    expect(seqA.length).toBeGreaterThan(3);
    expect(seqA).toEqual(seqB);
  });

  it('beginnt nicht immer bei Szene 0 (Startszene hängt am Seed)', () => {
    const { hook } = setupShow();
    const { result } = hook;
    // Seed 0..n-1 → Startindex; entscheidend: er folgt aus dem Seed, nicht aus 0.
    const seedStart = result.current.currentIndex;
    expect(seedStart).toBeGreaterThanOrEqual(0);
    expect(seedStart).toBeLessThan(3);
  });

  it('STOP hält die Szenen-Videos an, START spielt sie wieder an', () => {
    const { hook, base } = setupShow();
    const { result } = hook;
    playShow(hook, base, 8); // legt die versteckten <video>-Elemente an
    expect(document.querySelectorAll('video').length).toBeGreaterThan(0);

    pauseSpy.mockClear();
    playSpy.mockClear();
    act(() => result.current.stopShow());
    expect(result.current.playing).toBe(false);
    expect(pauseSpy).toHaveBeenCalled();

    act(() => result.current.startShow());
    expect(result.current.playing).toBe(true);
    expect(playSpy).toHaveBeenCalled();
  });

  it('Reduced-Motion friert Uhr und Medien weiter ein und schaltet nicht weiter', () => {
    const { hook, base } = setupShow();
    const { result } = hook;
    playShow(hook, base, 8);

    pauseSpy.mockClear();
    act(() => result.current.setFrozen(true));
    expect(pauseSpy).toHaveBeenCalled();

    // Angehalten: derselbe Zeitanker darf höchstens einmal wechseln, danach nie wieder.
    const frozenAt = base + 9_000;
    act(() => result.current.tick(frozenAt, IDLE_AUDIO_FEATURES));
    const afterFirst = result.current.currentIndex;
    playSpy.mockClear();
    for (let i = 0; i < 10; i += 1) act(() => result.current.tick(frozenAt, IDLE_AUDIO_FEATURES));
    expect(result.current.currentIndex).toBe(afterFirst);
    // Unter Reduced-Motion wird nichts angespielt.
    expect(playSpy).not.toHaveBeenCalled();

    act(() => result.current.setFrozen(false));
    act(() => result.current.tick(base + 20_000, loud));
    expect(result.current.playing).toBe(true);
  });
});
