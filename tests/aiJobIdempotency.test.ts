import { describe, expect, it } from 'vitest';
import { IdempotencyConflictError, JobManager } from '../src/core/ai/orchestrator/jobManager';
import { aiOrchestrator } from '../src/core/ai/orchestrator/aiOrchestrator';
import type { IAiProvider } from '../src/core/ai/orchestrator/types';

/**
 * AI-P1-004: Idempotenz-Schlüssel für AI-Jobs.
 *
 * Erwartung:
 * - gleicher Schlüssel + gleicher Payload  ⇒ derselbe Job (auch nach COMPLETED),
 * - gleicher Schlüssel + anderer Payload   ⇒ IdempotencyConflictError,
 * - ohne Schlüssel                          ⇒ bisheriges Dedup-Verhalten.
 */
describe('AI-Jobs – Idempotenz (AI-P1-004)', () => {
  it('gleicher Schlüssel + gleicher Payload liefert denselben Job', () => {
    const jm = new JobManager();
    const a = jm.create('s1', 'u1', 'nlu', 'qwen3-14b', 'runpod', { prompt: 'hi' }, { idempotencyKey: 'k-1' });
    const b = jm.create('s1', 'u1', 'nlu', 'qwen3-14b', 'runpod', { prompt: 'hi' }, { idempotencyKey: 'k-1' });

    expect(a.idempotencyKey).toBe('k-1');
    expect(b.jobId).toBe(a.jobId);
    expect(jm.list('s1')).toHaveLength(1);
  });

  it('gibt nach COMPLETED denselben Job samt Ergebnis zurück (Retry ohne Doppelausführung)', () => {
    const jm = new JobManager();
    const a = jm.create('s1', 'u1', 'nlu', 'qwen3-14b', 'runpod', { prompt: 'hi' }, { idempotencyKey: 'k-2' });
    jm.start(a.jobId);
    jm.markRunning(a.jobId);
    jm.complete(a.jobId, { text: 'ok' });

    const b = jm.create('s1', 'u1', 'nlu', 'qwen3-14b', 'runpod', { prompt: 'hi' }, { idempotencyKey: 'k-2' });

    expect(b.jobId).toBe(a.jobId);
    expect(b.status).toBe('COMPLETED');
    expect(jm.get(a.jobId)?.result).toEqual({ text: 'ok' });
  });

  it('wirft bei gleichem Schlüssel mit anderem Payload einen Konflikt', () => {
    const jm = new JobManager();
    jm.create('s1', 'u1', 'nlu', 'qwen3-14b', 'runpod', { prompt: 'a' }, { idempotencyKey: 'k-3' });

    expect(() => jm.create('s1', 'u1', 'nlu', 'qwen3-14b', 'runpod', { prompt: 'b' }, { idempotencyKey: 'k-3' }))
      .toThrow(IdempotencyConflictError);
  });

  it('trennt Schlüssel je Session (kein Cross-Session-Replay)', () => {
    const jm = new JobManager();
    const a = jm.create('s1', 'u1', 'nlu', 'qwen3-14b', 'runpod', { prompt: 'x' }, { idempotencyKey: 'same' });
    const b = jm.create('s2', 'u2', 'nlu', 'qwen3-14b', 'runpod', { prompt: 'x' }, { idempotencyKey: 'same' });

    expect(b.jobId).not.toBe(a.jobId);
  });

  it('ohne Schlüssel bleibt das bisherige Verhalten (Dedup nur für laufende Jobs)', () => {
    const jm = new JobManager();
    const a = jm.create('s1', 'u1', 'nlu', 'qwen3-14b', 'runpod', { prompt: 'x' });
    const running = jm.create('s1', 'u1', 'nlu', 'qwen3-14b', 'runpod', { prompt: 'x' });
    expect(running.jobId).toBe(a.jobId); // laufender identischer Job wird wiederverwendet

    jm.start(a.jobId);
    jm.markRunning(a.jobId);
    jm.complete(a.jobId, {});
    const afterDone = jm.create('s1', 'u1', 'nlu', 'qwen3-14b', 'runpod', { prompt: 'x' });
    expect(afterDone.jobId).not.toBe(a.jobId); // ohne Schlüssel ist nach Abschluss wieder ein neuer Job erlaubt
  });

  it('lässt den Schlüssel nach TTL wieder zu (bounded memory)', () => {
    let t = 1_000_000;
    const jm = new JobManager({ now: () => t, idempotencyTtlMs: 1000 });
    const a = jm.create('s1', 'u1', 'nlu', 'qwen3-14b', 'runpod', { p: 1 }, { idempotencyKey: 'k-ttl' });
    jm.start(a.jobId);
    jm.markRunning(a.jobId);
    jm.complete(a.jobId, {}); // terminal ⇒ Dedupe frei, es greift nur noch die Idempotenz-TTL

    t += 500; // innerhalb der TTL → Replay (derselbe Job)
    expect(jm.create('s1', 'u1', 'nlu', 'qwen3-14b', 'runpod', { p: 1 }, { idempotencyKey: 'k-ttl' }).jobId).toBe(a.jobId);

    t += 2000; // > TTL → neuer Job
    expect(jm.create('s1', 'u1', 'nlu', 'qwen3-14b', 'runpod', { p: 1 }, { idempotencyKey: 'k-ttl' }).jobId).not.toBe(a.jobId);
  });

  it('Orchestrator: zweiter Aufruf mit gleichem Schlüssel führt den Provider nur einmal aus', async () => {
    let calls = 0;
    const fake: IAiProvider = {
      id: 'local',
      available: true,
      canRun: (task) => task === 'nlu',
      estimateCostUsd: () => 0,
      run: async () => {
        calls += 1;
        return { text: 'einmal' };
      },
    };
    aiOrchestrator.registerProvider(fake);

    const req = {
      userId: 'u1',
      task: 'nlu' as const,
      model: 'qwen3-14b',
      input: { p: 1 },
      sessionId: 'sess-idem',
      idempotencyKey: 'orch-1',
    };
    const first = await aiOrchestrator.orchestrate(req);
    const second = await aiOrchestrator.orchestrate(req);

    expect(calls).toBe(1);
    expect(second.job.jobId).toBe(first.job.jobId);
    expect(second.result).toEqual({ text: 'einmal' });
  });
});
