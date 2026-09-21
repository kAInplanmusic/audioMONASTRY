/**
 * AI-P2-006 · Drop-Cache (Einheit) + Route (Integration)
 * =====================================================
 * Der Cache sitzt VOR dem bezahlten Modellaufruf von
 * `POST /api/ai/generate-drop`. Beides wird hier geprueft: die Einheit
 * (Schluessel-Stabilitaet, TTL, Verdrängung, Zaehler) und die Route (zwei
 * identische Anfragen -> EIN Modellaufruf, zweite Antwort mit `cached: true`;
 * der lokale Fallback wird bewusst NICHT gecacht).
 */
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const completeMock = vi.fn();
vi.mock('../src/core/ai/LlmRouter', () => ({
  llmRouter: { complete: (...args: unknown[]) => completeMock(...args) },
}));

import { createDropCache, dropCacheKey } from '../server/dropCache.ts';
import { registerAiRoutes } from '../server/routes/aiRoutes.ts';

const input = {
  userPrompt: 'dunkler Techno-Drop',
  bpm: 128,
  currentEnergy: 0.5,
  activePlugins: ['reverb', 'synth'],
  style: 'moderate' as const,
};

describe('dropCache (Einheit)', () => {
  it('Schluessel ist stabil gegen Plugin-Reihenfolge', () => {
    const a = dropCacheKey({ ...input, activePlugins: ['synth', 'reverb'] });
    const b = dropCacheKey({ ...input, activePlugins: ['reverb', 'synth'] });
    expect(a).toBe(b);
  });

  it('Schluessel aendert sich mit Prompt, Stil, BPM und Version', () => {
    const base = dropCacheKey(input);
    expect(dropCacheKey({ ...input, userPrompt: 'anderer Prompt' })).not.toBe(base);
    expect(dropCacheKey({ ...input, style: 'aggressive' })).not.toBe(base);
    expect(dropCacheKey({ ...input, bpm: 140 })).not.toBe(base);
    expect(dropCacheKey(input, 'v2')).not.toBe(base);
  });

  it('liefert Treffer, zaehlt Misser und laeuft nach der TTL ab', () => {
    let now = 1_000;
    const cache = createDropCache({ ttlMs: 100, now: () => now });
    const key = cache.key(input);
    expect(cache.get(key)).toBeNull();
    cache.set(key, { name: 'Drop' });
    expect(cache.get(key)).toEqual({ name: 'Drop' });
    now += 99;
    expect(cache.get(key)).toEqual({ name: 'Drop' });
    now += 2; // TTL ueberschritten
    expect(cache.get(key)).toBeNull();
    const stats = cache.stats();
    expect(stats.hits).toBe(2);
    expect(stats.misses).toBe(2);
    expect(stats.expired).toBe(1);
    expect(stats.stored).toBe(1);
  });

  it('verdraengt den aeltesten Eintrag ab der Obergrenze', () => {
    const cache = createDropCache({ maxEntries: 2 });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    expect(cache.stats().entries).toBe(2);
    expect(cache.stats().evicted).toBe(1);
    expect(cache.get('a')).toBeNull();
    expect(cache.get('c')).toBe(3);
  });
});

describe('POST /api/ai/generate-drop · Cache in der Route', () => {
  let server: http.Server;
  let base = '';
  const metrics = { aiRequests: 0, aiFailures: 0, aiCacheHits: 0, aiCacheMisses: 0 };
  const cache = createDropCache({ ttlMs: 60_000 });

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    registerAiRoutes(app, { metrics, fleetTargets: { ollama: 'http://127.0.0.1:1' }, dropCache: cache });
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    completeMock.mockReset();
    cache.clear();
    metrics.aiCacheHits = 0;
    metrics.aiCacheMisses = 0;
  });

  const post = (body: unknown) =>
    fetch(`${base}/api/ai/generate-drop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  // Muss die Server-Whitelist treffen (SUPPORTED_DROP_PARAMETERS) - sonst wirft
  // sanitizeAiDropResponse('AI response contains no supported parameters') und die
  // Route faellt auf den lokalen Fallback (der bewusst nicht gecacht wird).
  const aiAnswer = JSON.stringify({
    name: 'Dunkler Techno-Drop',
    description: 'Test',
    category: 'buildup',
    parameterSequence: [
      { pluginId: 'synthesizer', parameterId: 'cutoff', startValue: 0.2, endValue: 0.9, duration: 2000, curve: 'linear', delay: 0 },
    ],
    buildupTime: 8000,
    dropDuration: 16000,
    quantization: '4bar',
    intensity: 0.8,
    confidence: 0.9,
    tags: ['techno'],
  });

  it('erste Anfrage fragt das Modell, zweite identische kommt aus dem Cache', async () => {
    completeMock.mockResolvedValue({ text: aiAnswer, provider: 'deepseek' });
    const first = await post({ userPrompt: input.userPrompt, context: input });
    const firstBody = (await first.json()) as { cached?: boolean; provider?: string };
    expect(first.status).toBe(200);
    expect(firstBody.cached).toBe(false);
    expect(completeMock).toHaveBeenCalledTimes(1);

    const second = await post({ userPrompt: input.userPrompt, context: input });
    const secondBody = (await second.json()) as { cached?: boolean; name?: string };
    expect(secondBody.cached).toBe(true);
    expect(secondBody.name).toBe('Dunkler Techno-Drop');
    expect(completeMock).toHaveBeenCalledTimes(1); // kein zweiter Modellaufruf
    expect(metrics.aiCacheHits).toBe(1);
    expect(metrics.aiCacheMisses).toBe(1);
  });

  it('anderer Prompt ist ein Misser (kein falscher Treffer)', async () => {
    completeMock.mockResolvedValue({ text: aiAnswer, provider: 'deepseek' });
    await post({ userPrompt: input.userPrompt, context: input });
    await post({ userPrompt: 'voellig anderer Prompt', context: input });
    expect(completeMock).toHaveBeenCalledTimes(2);
    expect(metrics.aiCacheHits).toBe(0);
  });

  it('cacht den lokalen Fallback NICHT (sonst verdeckt der Treffer den Modellausfall)', async () => {
    completeMock.mockRejectedValue(new Error('kein Modell erreichbar'));
    const first = await post({ userPrompt: input.userPrompt, context: input });
    const firstBody = (await first.json()) as { provider?: string; cached?: boolean };
    expect(firstBody.provider).toBe('local');
    expect(firstBody.cached).toBe(false);
    const second = await post({ userPrompt: input.userPrompt, context: input });
    const secondBody = (await second.json()) as { provider?: string; cached?: boolean };
    expect(secondBody.cached).toBe(false); // kein Cache-Treffer
    expect(metrics.aiCacheHits).toBe(0);
  });
});
