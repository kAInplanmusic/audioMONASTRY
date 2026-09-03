import { beforeAll, describe, expect, it } from 'vitest';
import { AiOrchestrator } from '../src/core/ai/orchestrator/aiOrchestrator';
import { ProviderRouter } from '../src/core/ai/orchestrator/providerRouter';
import { AiProviderError, type AiProviderId, type AiTask, type IAiProvider } from '../src/core/ai/orchestrator/types';

/**
 * AI-Failure-Suite (AITodo Phase 24–26): HF offline, GPU down, Duplicate,
 * Crash – deterministische Mock-Tests der Fallback-/Breaker-/Dedup-Logik.
 */

beforeAll(() => {
  // Echte Provider isolieren: ohne Env-Keys sind HfEndpoint/HfServerless/
  // Replicate nicht verfügbar → nur die Mock-Provider sind Kandidaten.
  delete process.env.HF_ENDPOINT_URL;
  delete process.env.HF_API_KEY;
  delete process.env.HF_TOKEN;
  delete process.env.REPLICATE_API_TOKEN;
});

function failingProvider(id: string, error: AiProviderError, task: AiTask = 'audio.classify'): IAiProvider & { calls: number } {
  const state = { calls: 0 };
  return {
    id: id as AiProviderId,
    get available() { return true; },
    canRun(t: AiTask) { return t === task; },
    estimateCostUsd() { return 0.001; },
    async run() {
      state.calls += 1;
      throw error;
    },
    get calls() { return state.calls; },
  };
}

function okProvider(id: string, task: AiTask = 'audio.classify'): IAiProvider & { calls: number } {
  const state = { calls: 0 };
  return {
    id: id as AiProviderId,
    get available() { return true; },
    canRun(t: AiTask) { return t === task; },
    estimateCostUsd() { return 0.001; },
    async run() {
      state.calls += 1;
      return { provider: id, ok: true };
    },
    get calls() { return state.calls; },
  };
}

describe('AI-Failure-Suite: HF offline → Fallback', () => {
  it('orchestrate fällt auf den nächsten Provider zurück, wenn HF offline ist', async () => {
    const hf = failingProvider('mock-hf', new AiProviderError('local', 'HTTP_500', 'HF offline', true));
    const local = okProvider('mock-local');
    const orchestrator = new AiOrchestrator();
    orchestrator.registerProvider(local);
    orchestrator.registerProvider(hf);

    const result = await orchestrator.orchestrate({
      userId: 'u1', task: 'audio.classify', model: 'ast-audioset', input: { audio: 'x' },
    });
    expect(result.job.status).toBe('COMPLETED');
    expect(result.provider).toBe('mock-local');
    expect(hf.calls).toBe(1);
    expect(local.calls).toBe(1);
  });
});

describe('AI-Failure-Suite: GPU down → Circuit Breaker', () => {
  it('öffnet den Breaker nach Threshold und lehnt fail-fast ab (Provider wird nicht mehr aufgerufen)', async () => {
    process.env.AI_CB_FAILURE_THRESHOLD = '2';
    const gpu = failingProvider(
      'mock-gpu-down',
      new AiProviderError('local', 'ENDPOINT_WAKING', 'GPU down', true),
    );
    const router = new ProviderRouter();
    router.register(gpu);

    await expect(router.run('audio.classify', 'ast-audioset', { audio: 'x' })).rejects.toThrow();
    await expect(router.run('audio.classify', 'ast-audioset', { audio: 'x' })).rejects.toThrow();
    expect(gpu.calls).toBe(2);
    // Breaker ist offen → dritter Call scheitert SOFORT, ohne Provider-Aufruf.
    await expect(router.run('audio.classify', 'ast-audioset', { audio: 'x' })).rejects.toThrow(/circuit breaker open/);
    expect(gpu.calls).toBe(2);
    delete process.env.AI_CB_FAILURE_THRESHOLD;
  });
});

describe('AI-Failure-Suite: Duplicate (SingleFlight-Dedup)', () => {
  it('zwei identische Requests laufen als EIN Job (kein Doppel-Request)', async () => {
    let calls = 0;
    const slow = {
      id: 'mock-slow' as AiProviderId,
      get available() { return true; },
      canRun(t: AiTask) { return t === 'audio.classify'; },
      estimateCostUsd() { return 0.001; },
      async run() {
        calls += 1;
        await new Promise((r) => setTimeout(r, 40));
        return { ok: true };
      },
    };
    const orchestrator = new AiOrchestrator();
    orchestrator.registerProvider(slow);

    const payload = { userId: 'u1', task: 'audio.classify' as const, model: 'ast-audioset', input: { audio: 'same' } };
    const [a, b] = await Promise.all([
      orchestrator.orchestrate(payload),
      orchestrator.orchestrate(payload),
    ]);
    expect(a.job.jobId).toBe(b.job.jobId);
    expect(calls).toBe(1);
  });
});

describe('AI-Failure-Suite: Crash + Recovery', () => {
  it('nicht-retryabler Crash markiert den Job FAILED; danach läuft es wieder', async () => {
    let crash = true;
    const unstable = {
      id: 'mock-unstable' as AiProviderId,
      get available() { return true; },
      canRun(t: AiTask) { return t === 'audio.classify'; },
      estimateCostUsd() { return 0.001; },
      async run() {
        if (crash) {
          crash = false;
          throw new AiProviderError('local', 'CRASH', 'OOM in worker', false);
        }
        return { ok: 'recovered' };
      },
    };
    const orchestrator = new AiOrchestrator();
    orchestrator.registerProvider(unstable);

    await expect(
      orchestrator.orchestrate({ userId: 'u1', task: 'audio.classify', model: 'ast-audioset', input: { audio: 'x' } }),
    ).rejects.toThrow(/OOM in worker/);

    const jobs = orchestrator.jobs.list();
    expect(jobs[0]?.status).toBe('FAILED');
    expect(jobs[0]?.error).toContain('OOM in worker');

    const recovered = await orchestrator.orchestrate({
      userId: 'u1', task: 'audio.classify', model: 'ast-audioset', input: { audio: 'y' },
    });
    expect(recovered.job.status).toBe('COMPLETED');
    expect(recovered.result).toEqual({ ok: 'recovered' });
  });
});
