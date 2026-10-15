// @vitest-environment node
/**
 * DROP-P1-001 · dropMONK Audio-Drop (xl-turbo, RP3) + AI-P2-006 Cache
 * ===================================================================
 * Einheit (generateDropAudio) und Route (POST /api/ai/drop-audio), alles mit
 * gemocktem Modell – kein Live-GPU-Lauf.
 */
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CostTracker } from '../src/core/ai/orchestrator/costTracker';
import { AiProviderError } from '../src/core/ai/orchestrator/types';
import type { LibrarySaveEntry, MusicLibraryPort } from '../src/core/ai/orchestrator/musicContextTools';
import { createDropCache } from '../server/dropCache.ts';
import {
  DROP_AUDIO_MODEL,
  DROP_AUDIO_STEPS,
  dropAudioCacheKey,
  dropDurationSeconds,
  generateDropAudio,
  type DropAudioDeps,
} from '../server/dropAudio.ts';
import { registerAiRoutes } from '../server/routes/aiRoutes.ts';

const HOLDER = 'user-alpha';

function deps(over: Partial<DropAudioDeps> = {}) {
  const saved: LibrarySaveEntry[] = [];
  const library: MusicLibraryPort = {
    resolveAudio: async () => null,
    save: vi.fn(async (entry: LibrarySaveEntry) => {
      saved.push(entry);
      return { id: `drop-${saved.length}`, url: `/api/media/uploads/drop-${saved.length}.wav` };
    }),
  };
  const costs = new CostTracker();
  const runTask = vi.fn(async () => ({ audioBase64: 'UklGRg==', sampleRate: 48000 }));
  const d: DropAudioDeps = {
    runTask,
    getLibrary: () => library,
    costs,
    lockOwner: (id) => (id === 'drop' ? HOLDER : null),
    getSessionId: () => 'sess-1',
    cache: createDropCache({ ttlMs: 60_000, maxEntries: 10, keyVersion: 'audio-test' }),
    ...over,
  };
  return { d, saved, costs, runTask: d.runTask as typeof runTask };
}

const BODY = { prompt: 'dunkler Techno-Drop', bpm: 128, key: 'Am', bars: 8 as const };

describe('generateDropAudio (Einheit)', () => {
  it('ruft song + xl-turbo mit 8 Schritten, OHNE aceTask (kein LEGO-Pfad), BPM/Tonart im Auftrag', async () => {
    const { d, runTask } = deps();
    const res = await generateDropAudio(BODY, HOLDER, d);
    expect(res.status).toBe(200);
    expect(runTask).toHaveBeenCalledTimes(1);
    const [task, model, input] = runTask.mock.calls[0] as unknown as [string, string, Record<string, unknown>];
    expect(task).toBe('song');
    expect(model).toBe(DROP_AUDIO_MODEL);
    expect(model).toBe('acestep-v15-xl-turbo');
    expect(input.inferenceSteps).toBe(DROP_AUDIO_STEPS);
    expect(input.aceTask).toBeUndefined();
    expect(input).toMatchObject({ bpm: 128, keyscale: 'A Minor', durationSeconds: 15 });
    expect(String(input.prompt)).toContain('128 BPM');
    expect(String(input.prompt)).toContain('A Minor');
  });

  it('legt das Ergebnis still in die Bibliothek und liefert ID + URL fuer das Pad', async () => {
    const { d, saved } = deps();
    const res = await generateDropAudio(BODY, HOLDER, d);
    expect(res.body).toMatchObject({ libraryId: 'drop-1', url: '/api/media/uploads/drop-1.wav', cached: false, model: DROP_AUDIO_MODEL });
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ kind: 'sound', bpm: 128, key: 'A Minor' });
    expect(saved[0].tags).toEqual(expect.arrayContaining(['ai', 'ai-drop', 'drop']));
  });

  it('Cache-Treffer: kein zweiter Modellaufruf, keine zweite Buchung, costUsd 0', async () => {
    const { d, runTask, costs } = deps();
    const first = await generateDropAudio(BODY, HOLDER, d);
    const booked = costs.costForSession('sess-1');
    const second = await generateDropAudio({ ...BODY, prompt: '  Dunkler   Techno-Drop ' }, HOLDER, d);
    expect(second.status).toBe(200);
    expect(second.body.cached).toBe(true);
    expect(second.body.costUsd).toBe(0);
    expect(second.body.libraryId).toBe(first.body.libraryId);
    expect(runTask).toHaveBeenCalledTimes(1);
    expect(costs.costForSession('sess-1')).toBe(booked);
  });

  it('Schluessel aendert sich mit Prompt/BPM/Tonart/Dauer/Seed/Modell', () => {
    const base = { prompt: 'x', bpm: 128, keyscale: 'A Minor', durationSeconds: 15, seed: 1, model: DROP_AUDIO_MODEL };
    const k = dropAudioCacheKey(base);
    for (const change of [{ prompt: 'y' }, { bpm: 130 }, { keyscale: 'C Major' }, { durationSeconds: 20 }, { seed: 2 }, { model: 'acestep-v15-xl-sft' }]) {
      expect(dropAudioCacheKey({ ...base, ...change })).not.toBe(k);
    }
    expect(dropAudioCacheKey({ ...base, bpm: 128.0 })).toBe(k);
  });

  it('TTL: nach Ablauf wieder ein Modellaufruf', async () => {
    let now = 0;
    const cache = createDropCache({ ttlMs: 100, now: () => now });
    const { d, runTask } = deps({ cache });
    await generateDropAudio(BODY, HOLDER, d);
    now = 150;
    await generateDropAudio(BODY, HOLDER, d);
    expect(runTask).toHaveBeenCalledTimes(2);
  });

  it('Lock: frei -> 423 DROP_NOT_HELD, fremder Halter -> 423 DROP_LOCKED, kein Modellaufruf', async () => {
    const free = deps({ lockOwner: () => null });
    expect((await generateDropAudio(BODY, HOLDER, free.d)).body.code).toBe('DROP_NOT_HELD');
    const foreign = deps();
    const res = await generateDropAudio(BODY, 'user-beta', foreign.d);
    expect(res.status).toBe(423);
    expect(res.body).toMatchObject({ code: 'DROP_LOCKED', lockedBy: HOLDER });
    expect(free.runTask).not.toHaveBeenCalled();
    expect(foreign.runTask).not.toHaveBeenCalled();
  });

  it('Pod nicht bereit -> 503 POD_NOT_READY, retryable, nichts gebucht, nichts gecacht', async () => {
    const runTask = vi.fn(async () => {
      throw new AiProviderError('runpod-music', 'TIMEOUT', 'Kaltstart', true);
    });
    const { d, costs } = deps({ runTask });
    const res = await generateDropAudio(BODY, HOLDER, d);
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ code: 'POD_NOT_READY', retryable: true });
    expect(Number(res.body.retryAfterMs)).toBeGreaterThan(0);
    expect(costs.costForSession('sess-1')).toBe(0);
    // Wiederholung erreicht das Modell erneut (kein Fehler im Cache).
    await generateDropAudio(BODY, HOLDER, d);
    expect(runTask).toHaveBeenCalledTimes(2);
  });

  it('Kein Audio (lokaler Text-Fallback) -> 503 POD_NOT_READY; Konfig-Fehler -> AI_NOT_CONFIGURED', async () => {
    const text = deps({ runTask: async () => ({ provider: 'local', text: 'x' }) });
    expect((await generateDropAudio(BODY, HOLDER, text.d)).body.code).toBe('POD_NOT_READY');
    const cfg = deps({ runTask: async () => { throw new AiProviderError('runpod-music', 'POD_NOT_CONFIGURED', 'RP_POD_ID_MUSIC fehlt', false); } });
    const res = await generateDropAudio(BODY, HOLDER, cfg.d);
    expect(res.body).toMatchObject({ code: 'AI_NOT_CONFIGURED', retryable: false });
  });

  it('Validierung: leerer Prompt / falsche Takte / unbekannte Felder -> 400', async () => {
    const { d, runTask } = deps();
    for (const body of [{ prompt: '' }, { prompt: 'x', bars: 3 }, { prompt: 'x', evil: 1 }, { prompt: 'x', key: 'H dur' }]) {
      expect((await generateDropAudio(body, HOLDER, d)).status).toBe(400);
    }
    expect(runTask).not.toHaveBeenCalled();
  });

  it('Dauer aus Takten und BPM, begrenzt auf 10..60 s', () => {
    expect(dropDurationSeconds(128, 8)).toBe(15);
    expect(dropDurationSeconds(174, 4)).toBe(10);
    expect(dropDurationSeconds(60, 16)).toBe(60);
    expect(dropDurationSeconds(120, 8, 12)).toBe(12);
  });
});

describe('POST /api/ai/drop-audio (Route)', () => {
  let server: http.Server;
  let base = '';
  const metrics = { aiRequests: 0, aiFailures: 0, aiCacheHits: 0, aiCacheMisses: 0 };
  const cache = createDropCache({ ttlMs: 60_000, keyVersion: 'audio-route' });
  const runTask = vi.fn();
  const saved: LibrarySaveEntry[] = [];

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    registerAiRoutes(app, {
      metrics,
      lockOwner: (id) => (id === 'drop' ? HOLDER : null),
      dropAudio: {
        runTask: (...a) => runTask(...a),
        getLibrary: () => ({
          resolveAudio: async () => null,
          save: async (e) => {
            saved.push(e);
            return { id: `lib-${saved.length}`, url: `/api/media/uploads/lib-${saved.length}.wav` };
          },
        }),
        costs: new CostTracker(),
        cache,
      },
    });
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    runTask.mockReset();
    cache.clear();
    metrics.aiCacheHits = 0;
    metrics.aiCacheMisses = 0;
  });

  const post = (body: unknown, user = HOLDER) =>
    fetch(`${base}/api/ai/drop-audio`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-session-id': user },
      body: JSON.stringify(body),
    });

  it('Halter: 200, zweite identische Anfrage aus dem Cache (Metrik-Treffer)', async () => {
    runTask.mockResolvedValue({ audioBase64: 'UklGRg==' });
    const first = await post(BODY);
    expect(first.status).toBe(200);
    expect(((await first.json()) as { cached: boolean }).cached).toBe(false);
    const second = await post(BODY);
    expect(((await second.json()) as { cached: boolean }).cached).toBe(true);
    expect(runTask).toHaveBeenCalledTimes(1);
    expect(metrics.aiCacheHits).toBe(1);
    expect(metrics.aiCacheMisses).toBe(1);
  });

  it('Nicht-Halter: 423', async () => {
    const res = await post(BODY, 'user-beta');
    expect(res.status).toBe(423);
    expect(runTask).not.toHaveBeenCalled();
  });

  it('Pod nicht bereit: 503 mit Retry-After', async () => {
    runTask.mockRejectedValue(new AiProviderError('runpod-music', 'TIMEOUT', 'Kaltstart', true));
    const res = await post(BODY);
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('15');
    expect(((await res.json()) as { code: string }).code).toBe('POD_NOT_READY');
  });
});
