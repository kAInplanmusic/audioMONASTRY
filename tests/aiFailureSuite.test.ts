/**
 * AI-Failure-Suite (aus AITodo Phase 24–26)
 * ==========================================
 * Automatisierte Fehlerfälle des AI-Orchestrators – alles gemockt, kein Netz:
 * - **HF offline**: Endpoint nicht erreichbar → Fallback-Kette greift.
 * - **GPU down**: kein VRAM/GPU-Fehler → kontrollierter Fehler statt OOM.
 * - **Duplicate**: identischer Request läuft nur einmal (SingleFlight).
 * - **Crash**: wiederholte Provider-Abstürze öffnen den Circuit Breaker.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CircuitBreaker } from '../src/core/ai/orchestrator/circuitBreaker';
import { JobManager } from '../src/core/ai/orchestrator/jobManager';
import { ModelManager, type EndpointClient } from '../src/core/ai/orchestrator/modelManager';
import { listModels } from '../src/core/ai/orchestrator/modelRegistry';
import { ProviderRouter } from '../src/core/ai/orchestrator/providerRouter';
import { AiProviderError, type AiTask, type IAiProvider } from '../src/core/ai/orchestrator/types';

function fakeEndpoint(overrides: Partial<EndpointClient> = {}): EndpointClient {
  return {
    async loadModel(): Promise<void> { /* ok */ },
    async unloadModel(): Promise<void> { /* ok */ },
    async listModels(): Promise<Array<{ id: string; loaded: boolean }>> {
      return listModels().map((m) => ({ id: m.id, loaded: false }));
    },
    ...overrides,
  };
}

/** Provider-Stub mit steuerbarem Verhalten (offline/crash/ok). */
function stubProvider(id: 'hf-endpoint' | 'hf-serverless' | 'local', behaviour: () => Promise<unknown>): IAiProvider {
  return {
    id,
    get available() { return true; },
    canRun(task: AiTask) { return task === 'tts'; },
    estimateCostUsd() { return 0; },
    run: behaviour,
  } as IAiProvider;
}

describe('AI-Failure-Suite', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.HF_ENDPOINT_URL;
    delete process.env.HF_API_KEY;
    delete process.env.HF_TOKEN;
    delete process.env.REPLICATE_API_TOKEN;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  // ------------------------------------------------------------ HF offline
  it('HF offline: Endpoint fällt aus → nächster Provider übernimmt', async () => {
    const router = new ProviderRouter();
    const calls: string[] = [];
    router.register(stubProvider('hf-serverless', async () => {
      calls.push('hf-serverless');
      return { audio: 'ok' };
    }));
    router.register(stubProvider('hf-endpoint', async () => {
      calls.push('hf-endpoint');
      throw new AiProviderError('hf-endpoint', 'ENDPOINT_FAILED', 'HF-Endpoint nicht erreichbar', true);
    }));

    const { provider, result } = await router.run('tts', 'mms-tts-deu', { text: 'hallo' });
    expect(calls).toEqual(['hf-endpoint', 'hf-serverless']);
    expect(provider).toBe('hf-serverless');
    expect(result).toEqual({ audio: 'ok' });
  });

  it('HF offline und kein Fallback: kontrollierter Fehler statt Hänger', async () => {
    const router = new ProviderRouter();
    // Kein Provider für stem.separate (REPLICATE_API_TOKEN fehlt).
    await expect(router.run('stem.separate', 'demucs', { audioDataUri: 'data:audio/wav;base64,AA' }))
      .rejects.toThrow(/kein Provider für Task stem.separate/);
  });

  // -------------------------------------------------------------- GPU down
  it('GPU down: Modell-Load scheitert kontrolliert (kein stiller Zustand)', async () => {
    const models = new ModelManager(fakeEndpoint({
      async loadModel(): Promise<void> {
        throw new Error('CUDA error: no CUDA-capable device is detected');
      },
    }), { vramBudgetGb: 80, vramSafetyMarginGb: 6 });
    await expect(models.load('ast-audioset')).rejects.toThrow(/CUDA/);
    expect(models.isLoaded('ast-audioset')).toBe(false);
    // Kein hängengebliebener Loading-Zustand → erneuter Versuch ist möglich.
    await expect(models.load('ast-audioset')).rejects.toThrow(/CUDA/);
  });

  it('GPU down: kein VRAM verfügbar → VRAM-Guard wirft statt OOM', async () => {
    const models = new ModelManager(fakeEndpoint(), { vramBudgetGb: 2, vramSafetyMarginGb: 0 });
    await expect(models.load('whisper-large-v3')).rejects.toThrow(/VRAM exhausted/);
    expect(models.getMemoryUsage().availableGb).toBe(2);
  });

  // ------------------------------------------------------------- Duplicate
  it('Duplicate: identischer Request wird dedupliziert (SingleFlight)', () => {
    const jobs = new JobManager();
    const input = { text: 'hallo welt' };
    const first = jobs.create('s1', 'u1', 'tts', 'mms-tts-deu', 'hf-endpoint', input);
    jobs.start(first.jobId);
    const second = jobs.create('s1', 'u1', 'tts', 'mms-tts-deu', 'hf-endpoint', { ...input });
    expect(second.jobId).toBe(first.jobId);
    expect(jobs.list('s1').length).toBe(1);

    // Nach Abschluss ist derselbe Request wieder ein neuer Job.
    jobs.complete(first.jobId);
    const third = jobs.create('s1', 'u1', 'tts', 'mms-tts-deu', 'hf-endpoint', { ...input });
    expect(third.jobId).not.toBe(first.jobId);
  });

  it('Duplicate: unterschiedlicher Input → eigener Job', () => {
    const jobs = new JobManager();
    const a = jobs.create('s1', 'u1', 'tts', 'mms-tts-deu', 'hf-endpoint', { text: 'a' });
    const b = jobs.create('s1', 'u1', 'tts', 'mms-tts-deu', 'hf-endpoint', { text: 'b' });
    expect(b.jobId).not.toBe(a.jobId);
  });

  // ----------------------------------------------------------------- Crash
  it('Crash: wiederholte Abstürze öffnen den Circuit Breaker (fail-fast)', async () => {
    const breaker = new CircuitBreaker('hf-endpoint', { failureThreshold: 3, resetTimeoutMs: 30_000 });
    const crash = async () => { throw new Error('worker crashed'); };
    for (let i = 0; i < 3; i++) {
      await expect(breaker.call(crash)).rejects.toThrow(/worker crashed/);
    }
    expect(breaker.getState()).toBe('OPEN');
    // Weitere Calls werden sofort abgelehnt (kein Thundering Herd).
    await expect(breaker.call(crash)).rejects.toThrow(/circuit breaker open/);
  });

  it('Crash: Job wird als FAILED markiert und gibt die Concurrency frei', () => {
    const jobs = new JobManager({ maxConcurrency: { tts: 1 } });
    const job = jobs.create('s1', 'u1', 'tts', 'mms-tts-deu', 'hf-endpoint', { text: 'x' });
    jobs.start(job.jobId);
    jobs.fail(job.jobId, new Error('worker crashed'));
    expect(jobs.get(job.jobId)?.status).toBe('FAILED');
    expect(jobs.get(job.jobId)?.error).toContain('worker crashed');
    expect(jobs.canStart('tts')).toBe(true);
  });
});
