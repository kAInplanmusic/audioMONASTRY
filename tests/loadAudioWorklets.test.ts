import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ensureAudioWorkletsLoaded,
  loadWorkletsOnce,
  normalizeWorkletUrls,
  readWorkletManifest,
  resetWorkletLoaderForTests,
} from '../src/core/audio/worklets/loadAudioWorklets';

/**
 * Befund 2026-09-18 (gemessen im Produktions-Build): fuenf von zehn DSP-Knoten
 * fielen dauerhaft auf einen Gain-Pass-through zurueck, weil der Engine-Graph
 * seine Worklet-Knoten baute, WAEHREND die Module noch geladen wurden. Der Loader
 * liegt jetzt in einem eigenen Modul mit Single-Flight und wird von beiden Seiten
 * abgewartet. Diese Tests halten das Verhalten fest, ohne Browser.
 */

const manifest = (ids: string[]) => ({
  worklets: ids.map((id) => ({ id, url: `/worklets/${id}.js`, hash: `h-${id}` })),
});

const jsonFetcher = (payload: unknown, ok = true, status = 200) =>
  vi.fn(async () => ({ ok, status, json: async () => payload }));

/** AudioContext-Attrappe, die addModule-Aufrufe aufzeichnet und steuerbar scheitert. */
const fakeCtx = (failFor: string[] = []) => {
  const calls: string[] = [];
  return {
    calls,
    ctx: {
      audioWorklet: {
        addModule: async (url: string) => {
          calls.push(url);
          if (failFor.some((f) => url.includes(f))) throw new Error(`kein Modul: ${url}`);
          return undefined;
        },
      },
    },
  };
};

afterEach(() => {
  resetWorkletLoaderForTests();
  vi.restoreAllMocks();
});

describe('Worklet-Loader', () => {
  it('normalisiert /public/-URLs und entdoppelt', () => {
    expect(normalizeWorkletUrls('/public/worklets/a.js')).toEqual(['/public/worklets/a.js', '/worklets/a.js']);
    expect(normalizeWorkletUrls('/worklets/a.js')).toEqual(['/worklets/a.js']);
  });

  it('laedt alle Manifest-Eintraege in der Reihenfolge des Manifests', async () => {
    const fetchImpl = jsonFetcher(manifest(['analyzer-processor', 'dynamics-processor']));
    const { ctx, calls } = fakeCtx();
    const result = await loadWorkletsOnce({ ctx, fetchImpl });

    expect(result.loaded).toEqual(['analyzer-processor', 'dynamics-processor']);
    expect(result.fallback).toEqual([]);
    expect(calls).toEqual(['/worklets/analyzer-processor.js', '/worklets/dynamics-processor.js']);
  });

  it('probiert die zweite Kandidaten-URL, wenn die erste scheitert', async () => {
    const fetchImpl = jsonFetcher({ worklets: [{ id: 'eq-processor', url: '/public/worklets/eqProcessor.js' }] });
    const calls: string[] = [];
    const ctx = {
      audioWorklet: {
        addModule: async (url: string) => {
          calls.push(url);
          if (url.startsWith('/public/')) throw new Error('404');
          return undefined;
        },
      },
    };
    const result = await loadWorkletsOnce({ ctx, fetchImpl });
    expect(result.loaded).toEqual(['eq-processor']);
    expect(calls).toEqual(['/public/worklets/eqProcessor.js', '/worklets/eqProcessor.js']);
  });

  it('registriert einen Dummy, wenn ein Modul nicht ladbar ist (Kette bleibt intakt)', async () => {
    const fetchImpl = jsonFetcher(manifest(['lufs-processor']));
    const { ctx, calls } = fakeCtx(['lufs-processor']);
    const result = await loadWorkletsOnce({ ctx, fetchImpl });

    expect(result.loaded).toEqual([]);
    expect(result.fallback).toEqual(['lufs-processor']);
    // zwei Aufrufe: Kandidat gescheitert, danach der Dummy
    expect(calls.length).toBe(2);
    expect(calls[1]).toMatch(/^data:application\/javascript/);
  });

  it('meldet ein unlesbares Manifest, ohne zu werfen', async () => {
    const fetchImpl = jsonFetcher({}, false, 404);
    const { ctx } = fakeCtx();
    const result = await loadWorkletsOnce({ ctx, fetchImpl });
    expect(result.manifestError).toContain('404');
    expect(result.loaded).toEqual([]);
  });

  it('bricht ohne audioWorklet nicht hart ab', async () => {
    const result = await loadWorkletsOnce({ ctx: {}, fetchImpl: jsonFetcher(manifest(['x'])) });
    expect(result.manifestError).toContain('audioWorklet');
  });

  it('readWorkletManifest liefert bei Netzfehler einen Grund statt einer Ausnahme', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('offline');
    });
    const out = await readWorkletManifest(fetchImpl as never, '/plugin-manifest.json');
    expect(out.entries).toEqual([]);
    expect(out.error).toBe('offline');
  });

  it('laedt nur EINMAL, egal wie oft (und parallel) gefragt wird', async () => {
    const fetchImpl = jsonFetcher(manifest(['dsp-processor']));
    const { ctx, calls } = fakeCtx();

    const [a, b] = await Promise.all([
      ensureAudioWorkletsLoaded({ ctx, fetchImpl }),
      ensureAudioWorkletsLoaded({ ctx, fetchImpl }),
    ]);
    // dritter Aufruf (auch nach Abschluss) nutzt das Ergebnis weiter
    const c = await ensureAudioWorkletsLoaded({ ctx, fetchImpl });

    expect(a.loaded).toEqual(['dsp-processor']);
    expect(b.loaded).toEqual(['dsp-processor']);
    expect(c.loaded).toEqual(['dsp-processor']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['/worklets/dsp-processor.js']);
  });
});
