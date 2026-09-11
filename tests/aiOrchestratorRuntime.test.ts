import { describe, expect, it, vi } from 'vitest';
import { AiOrchestrator } from '../src/core/ai/orchestrator/aiOrchestrator';

// ---------------------------------------------------------------------------
// AI-P1-002: Der Orchestrator führt Provider-Aufrufe jetzt in der AiJobRuntime
// aus. Hier wird die Integration geprüft: Erfolg, Timeout (hängender Provider)
// und Abbruch (cancelJob) – ohne echte Provider/Netz.
// ---------------------------------------------------------------------------

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const request = { userId: 'u-1', task: 'llm' as const, model: 'test-model', input: { prompt: 'hi' } };

describe('AiOrchestrator × AiJobRuntime', () => {
  it('Erfolgsfall: Ergebnis kommt zurück, Job ist COMPLETED', async () => {
    const orch = new AiOrchestrator({ jobTimeoutMs: 500 });
    const spy = vi.spyOn(orch.providers, 'run').mockResolvedValue({ provider: 'local', result: { text: 'ok' } });
    const result = await orch.orchestrate(request);
    expect(result.result).toEqual({ text: 'ok' });
    expect(result.provider).toBe('local');
    expect(orch.jobs.get(result.job.jobId)?.status).toBe('COMPLETED');
    // Der Provider bekommt das AbortSignal der Runtime.
    expect(spy).toHaveBeenCalledWith('llm', 'test-model', { prompt: 'hi' }, expect.any(AbortSignal));
    spy.mockRestore();
  });

  it('Timeout: hängender Provider -> AiProviderError TIMEOUT, Job TIMEOUT', async () => {
    const orch = new AiOrchestrator({ jobTimeoutMs: 25 });
    const spy = vi.spyOn(orch.providers, 'run').mockImplementation(() => new Promise(() => { /* nie */ }));
    const started = Date.now();
    await expect(orch.orchestrate(request)).rejects.toMatchObject({ code: 'TIMEOUT' });
    // Timeout greift (nicht der 120-s-Standard) und der Job ist als TIMEOUT markiert.
    expect(Date.now() - started).toBeLessThan(1_000);
    const job = orch.jobs.list()[0];
    expect(job.status).toBe('TIMEOUT');
    spy.mockRestore();
  });

  it('Cancellation: cancelJob bricht ab, Job ist CANCELLED, Signal feuert', async () => {
    const orch = new AiOrchestrator({ jobTimeoutMs: 5_000 });
    let aborted = false;
    const spy = vi.spyOn(orch.providers, 'run').mockImplementation((_task, _model, _input, signal) =>
      new Promise((resolve) => {
        signal?.addEventListener('abort', () => { aborted = true; });
        setTimeout(() => resolve({ provider: 'local', result: 'zu spät' }), 200);
      }),
    );
    const pending = orch.orchestrate(request);
    await wait(10);
    const jobId = orch.jobs.list()[0].jobId;
    expect(orch.cancelJob(jobId)).toBe(true);
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(aborted).toBe(true);
    expect(orch.jobs.get(jobId)?.status).toBe('CANCELLED');
    expect(orch.runtime.snapshot().cancelled).toBe(1);
    spy.mockRestore();
  });

  it('getStatus() weist die Queue-/Timeout-Kennzahlen aus', async () => {
    const orch = new AiOrchestrator({ jobTimeoutMs: 200 });
    const spy = vi.spyOn(orch.providers, 'run').mockResolvedValue({ provider: 'local', result: 1 });
    await orch.orchestrate(request);
    const status = orch.getStatus() as { runtime?: { submitted?: number; completed?: number; maxConcurrent?: number } };
    expect(status.runtime?.submitted).toBe(1);
    expect(status.runtime?.completed).toBe(1);
    expect(status.runtime?.maxConcurrent).toBeGreaterThan(0);
    spy.mockRestore();
  });
});
