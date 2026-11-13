/**
 * AI-E2E-Szenario (aus AITodo Phase 24–26)
 * =========================================
 * Automatisiert den kompletten Lebenszyklus einer AI-Session:
 * Wake → Cold-Start (Scale-to-Zero-Aufwachen) → Model-Load → Request →
 * Model-Switch → Scale-to-Zero.
 *
 * Alles läuft gemockt (kein Netz, keine GPU): `fetch` wird gestubbt, der
 * Endpoint-Client ist ein Fake. Damit ist das Szenario in CI reproduzierbar.
 */
import { beforeEach as beforeCompatibilityProvider, afterEach as afterCompatibilityProvider } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JobManager } from '../src/core/ai/orchestrator/jobManager';
import { ModelManager, type EndpointClient } from '../src/core/ai/orchestrator/modelManager';
import * as registry from '../src/core/ai/orchestrator/modelRegistry';
import { listModels } from '../src/core/ai/orchestrator/modelRegistry';
import { SessionManager } from '../src/core/ai/orchestrator/sessionManager';
import { AiProviderError, type IAiProvider } from '../src/core/ai/orchestrator/types';

// Explicit compatibility fixture: production now defaults to Vast.
beforeCompatibilityProvider(() => { process.env.AI_GPU_PROVIDER = 'vast'; });
afterCompatibilityProvider(() => { delete process.env.AI_GPU_PROVIDER; });

function fakeEndpoint(): EndpointClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async loadModel(id: string): Promise<void> {
      calls.push(`load:${id}`);
    },
    async unloadModel(id: string): Promise<void> {
      calls.push(`unload:${id}`);
    },
    async listModels(): Promise<Array<{ id: string; loaded: boolean }>> {
      return listModels().map((m) => ({
        id: m.id,
        loaded: calls.lastIndexOf(`load:${m.id}`) > calls.lastIndexOf(`unload:${m.id}`),
      }));
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('AI-E2E-Szenario: Wake → Cold-Start → Load → Request → Switch → Scale-to-Zero', () => {
  const originalEndpoint = process.env.HF_ENDPOINT_URL;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.HF_ENDPOINT_URL = 'https://endpoint.test/audiomonastry-ai';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    if (originalEndpoint === undefined) delete process.env.HF_ENDPOINT_URL;
    else process.env.HF_ENDPOINT_URL = originalEndpoint;
    vi.restoreAllMocks();
  });

  it('durchläuft das komplette Szenario ohne manuellen Eingriff', { timeout: 30000 }, async () => {
    const originalDefinition = registry.getModelDefinition;
    const fixtureMemory: Record<string, number> = { 'clap-music': 4, 'basic-pitch': 2, 'moss-music-8b-instruct': 8 };
    vi.spyOn(registry, 'getModelDefinition').mockImplementation(id => {
      const definition = originalDefinition(id);
      return definition && id in fixtureMemory ? { ...definition, estimatedVRAM: fixtureMemory[id], loadClass: id === 'basic-pitch' ? 'CORE' : 'ON_DEMAND' } : definition;
    });
    const scaleToZeroCalls: string[] = [];
    const session = new SessionManager('ai-e2e', {
      idleTimeoutMs: 60_000,
      onScaleToZero: async (s) => {
        scaleToZeroCalls.push(s.sessionId);
      },
    });
    const endpoint = fakeEndpoint();
    const models = new ModelManager(endpoint, { vramBudgetGb: 13, vramSafetyMarginGb: 0 });
    const jobs = new JobManager();

    // --- 1. Wake: Session startet und fordert die GPU an ------------------
    session.transition('STARTING');
    session.setEndpointState('waking');
    session.transition('WAKING_GPU');
    expect(session.getState()).toBe('WAKING_GPU');

    // --- 2. Cold-Start: HF-Gateway antwortet 503, bis die Replica läuft ---
    // (Scale-to-Zero-Verhalten: erst 503, dann 200 mit Ergebnis.)
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call += 1;
      if (call === 1) return jsonResponse({ error: 'scaling' }, 503);
      return jsonResponse({ result: { text: 'hallo welt' }, durationMs: 42 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    // --- 3. Load: Modelle laden (CORE zuerst) ----------------------------
    session.transition('LOADING_MODELS');
    await models.load('clap-music');
    await models.load('basic-pitch');
    expect(models.isLoaded('basic-pitch')).toBe(true);
    session.setEndpointState('ready');
    session.transition('READY');
    session.transition('ACTIVE');

    // --- 4. Request: Job anlegen und über den Endpoint ausführen ----------
    const job = jobs.create('ai-e2e', 'user-1', 'audio.transcribe', 'basic-pitch', 'vast-ears', { audioDataUri: 'data:audio/wav;base64,AA' });
    jobs.start(job.jobId);
    jobs.markRunning(job.jobId);
    session.jobStarted('basic-pitch');

    // Nach dem Cutover: der Vast-Rollen-Provider hat dieselbe Wake-Semantik
    // (Scale-to-Zero liefert 503, bis der Worker bereit ist).
    const provider: IAiProvider = {
      id: 'vast-ears',
      get available() { return true; },
      canRun: () => true,
      estimateCostUsd: () => 0.01,
      async run(_task, _model, _input) {
        let resp = await fetch('https://endpoint.test/infer', { method: 'POST' });
        if (resp.status === 503) {
          // Simuliere Backoff ohne echte Wartezeit
          resp = await fetch('https://endpoint.test/infer', { method: 'POST' });
        }
        if (!resp.ok) throw new AiProviderError('vast-ears', `HTTP_${resp.status}`, 'Endpoint kaputt', true);
        const data = (await resp.json()) as { result?: unknown };
        return data.result;
      },
    };
    const runPromise = provider.run('audio.transcribe', 'basic-pitch', { audioDataUri: 'data:audio/wav;base64,AA' });
    const result = await runPromise;
    expect(result).toEqual({ text: 'hallo welt' });
    expect(fetchMock).toHaveBeenCalledTimes(2); // 1× Wake (503) + 1× Erfolg

    jobs.complete(job.jobId, result);
    session.jobFinished('basic-pitch');
    expect(jobs.get(job.jobId)?.status).toBe('COMPLETED');

    // --- 5. Switch: anderes Modell anfordern (LRU-Eviction, CORE bleibt) --
    await models.load('moss-music-8b-instruct'); // 8 GB ON_DEMAND → clap-music (4 GB, LRU) wird evicted, basic-pitch (2 GB) bleibt
    expect(models.isLoaded('moss-music-8b-instruct')).toBe(true);
    expect(models.isLoaded('clap-music')).toBe(false);
    expect(models.isLoaded('basic-pitch')).toBe(true);
    expect(models.getMemoryUsage().usedGb).toBeLessThanOrEqual(13);

    // --- 6. Scale-to-Zero: kontrolliertes Herunterfahren ------------------
    await session.shutdown();
    expect(session.getState()).toBe('CLOSED');
    expect(scaleToZeroCalls).toEqual(['ai-e2e']);
  });

  it('Idle-Timeout löst Scale-to-Zero ohne Nutzeraktion aus', async () => {
    vi.useFakeTimers();
    const scaled: string[] = [];
    const session = new SessionManager('ai-idle', {
      idleTimeoutMs: 1000,
      onScaleToZero: async (s) => {
        scaled.push(s.sessionId);
      },
    });
    session.transition('STARTING');
    session.transition('WAKING_GPU');
    session.transition('LOADING_MODELS');
    session.transition('READY');
    session.transition('ACTIVE');
    await vi.advanceTimersByTimeAsync(1500);
    expect(session.getState()).toBe('IDLE');
    expect(scaled).toEqual(['ai-idle']);
    vi.useRealTimers();
  });
});
