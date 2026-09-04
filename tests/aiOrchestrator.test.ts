import { describe, expect, it, vi } from 'vitest';
import { redactSecrets } from '../src/core/ai/orchestrator/aiLogger';
import { CostTracker } from '../src/core/ai/orchestrator/costTracker';
import { JobManager } from '../src/core/ai/orchestrator/jobManager';
import { McpRuntime } from '../src/core/ai/orchestrator/mcpRuntime';
import { ModelManager, type EndpointClient } from '../src/core/ai/orchestrator/modelManager';
import { listModels, validateRegistry } from '../src/core/ai/orchestrator/modelRegistry';
import { SessionManager } from '../src/core/ai/orchestrator/sessionManager';

// ---------------------------------------------------------------------------
// Model Registry
// ---------------------------------------------------------------------------
describe('Model Registry', () => {
  it('enthält alle 9 Modelle mit gültigen Definitionen', () => {
    expect(validateRegistry()).toEqual([]);
    expect(listModels().length).toBe(9);
  });

  it('lehnt latest-Revisionen ab', () => {
    const errors = validateRegistry([{ ...listModels()[0], revision: 'latest' }]);
    expect(errors.some((e) => e.includes('revision pinning'))).toBe(true);
  });

  it('CORE vor FREQUENT nach loadPriority sortiert', () => {
    const core = listModels({ loadClass: 'CORE' });
    expect(core.map((m) => m.loadClass)).toEqual(['CORE', 'CORE']);
  });
});

// ---------------------------------------------------------------------------
// Model Manager (Client-Sicht)
// ---------------------------------------------------------------------------
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
      return listModels().map((m) => ({ id: m.id, loaded: calls.includes(`load:${m.id}`) && !calls.includes(`unload:${m.id}`) }));
    },
  };
}

describe('Model Manager', () => {
  it('load/unload/isLoaded und Dedup', async () => {
    const ep = fakeEndpoint();
    const mgr = new ModelManager(ep, { vramBudgetGb: 80, vramSafetyMarginGb: 6 });
    await mgr.load('ast-audioset');
    expect(mgr.isLoaded('ast-audioset')).toBe(true);
    await mgr.load('ast-audioset'); // erneuter Load → kein zweiter Endpoint-Call
    expect(ep.calls.filter((c) => c === 'load:ast-audioset').length).toBe(1);
    await mgr.unload('ast-audioset');
    expect(mgr.isLoaded('ast-audioset')).toBe(false);
  });

  it('VRAM-Guard: Eviction statt OOM (CORE bleibt geschützt)', async () => {
    const ep = fakeEndpoint();
    const mgr = new ModelManager(ep, { vramBudgetGb: 12, vramSafetyMarginGb: 0 });
    await mgr.load('ast-audioset');    // 3 GB CORE
    await mgr.load('bark');            // 8 GB ON_DEMAND → 11 GB belegt
    await mgr.load('musicgen-medium'); // 9 GB → evict bark (nicht CORE) → passt
    expect(mgr.isLoaded('musicgen-medium')).toBe(true);
    expect(mgr.isLoaded('bark')).toBe(false);
    expect(mgr.isLoaded('ast-audioset')).toBe(true); // CORE nie evicted
    expect(mgr.getMemoryUsage().usedGb).toBeLessThanOrEqual(12);
  });

  it('wirft kontrolliert bei VRAM-Engpass mit CORE-Schutz', async () => {
    const ep = fakeEndpoint();
    const mgr = new ModelManager(ep, { vramBudgetGb: 10, vramSafetyMarginGb: 0 });
    await mgr.load('ast-audioset'); // 3 CORE
    await mgr.load('whisper-large-v3'); // 5 CORE = 8
    await expect(mgr.load('bark')).rejects.toThrow(/VRAM exhausted/); // 8 GB nötig, CORE darf nicht evicted werden
  });
});

// ---------------------------------------------------------------------------
// MCP Runtime
// ---------------------------------------------------------------------------
describe('MCP Runtime', () => {
  it('Permission-Check: READ darf kein EXECUTION-Tool aufrufen', async () => {
    const mcp = new McpRuntime();
    mcp.register({ name: 'model.load', category: 'session', permission: 'EXECUTION', description: 'load' }, () => 'ok');
    const denied = await mcp.invoke('model.load', { permission: 'READ' });
    expect(denied.ok).toBe(false);
    expect(denied.error).toContain('permission denied');
    const ok = await mcp.invoke('model.load', { permission: 'EXECUTION' });
    expect(ok.ok).toBe(true);
  });

  it('unbekanntes Tool → kontrollierter Fehler', async () => {
    const mcp = new McpRuntime();
    const res = await mcp.invoke('nope.tool');
    expect(res.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Session Lifecycle
// ---------------------------------------------------------------------------
describe('Session Manager', () => {
  it('durchläuft CREATED→STARTING→WAKING_GPU→LOADING_MODELS→READY→ACTIVE→IDLE→CLOSED', async () => {
    const sm = new SessionManager('s1', { idleTimeoutMs: 10_000 });
    expect(sm.getState()).toBe('CREATED');
    sm.transition('STARTING');
    sm.transition('WAKING_GPU');
    sm.transition('LOADING_MODELS');
    sm.transition('READY');
    sm.transition('ACTIVE');
    sm.jobStarted('ast-audioset');
    sm.jobFinished('ast-audioset');
    expect(sm.getState()).toBe('IDLE');
    await sm.shutdown();
    expect(sm.getState()).toBe('CLOSED');
  });

  it('verbietet ungültige Transitionen', () => {
    const sm = new SessionManager('s2', { idleTimeoutMs: 1000 });
    sm.transition('READY'); // CREATED→READY unzulässig
    expect(sm.getState()).toBe('CREATED');
  });

  it('Heartbeat verlängert Session (ACTIVE bleibt)', () => {
    vi.useFakeTimers();
    const sm = new SessionManager('s3', { idleTimeoutMs: 1000 });
    sm.transition('STARTING');
    sm.transition('WAKING_GPU');
    sm.transition('LOADING_MODELS');
    sm.transition('READY');
    sm.transition('ACTIVE');
    vi.advanceTimersByTime(500);
    sm.heartbeat();
    vi.advanceTimersByTime(500);
    expect(sm.getState()).toBe('ACTIVE');
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// Job System
// ---------------------------------------------------------------------------
describe('Job Manager', () => {
  it('Dedup: identischer Request läuft nicht doppelt', () => {
    const jm = new JobManager();
    const a = jm.create('s1', 'u1', 'audio.classify', 'ast-audioset', 'local', { audio: 'x' });
    const b = jm.create('s1', 'u1', 'audio.classify', 'ast-audioset', 'local', { audio: 'x' });
    expect(a.jobId).toBe(b.jobId);
    const c = jm.create('s1', 'u1', 'audio.classify', 'ast-audioset', 'local', { audio: 'y' });
    expect(c.jobId).not.toBe(a.jobId);
  });

  it('Concurrency-Limit je Task', () => {
    const jm = new JobManager({ maxConcurrency: { 'audio.generate': 1 } });
    const j1 = jm.create('s1', 'u1', 'audio.generate', 'musicgen-small', 'local', { prompt: 'a' });
    jm.start(j1.jobId);
    const j2 = jm.create('s1', 'u1', 'audio.generate', 'musicgen-small', 'local', { prompt: 'b' });
    expect(() => jm.start(j2.jobId)).toThrow(/concurrency limit/);
  });

  it('complete/fail setzen Zeiten und räumen Dedup frei', () => {
    const jm = new JobManager();
    const j = jm.create('s1', 'u1', 'audio.embed', 'clap-music', 'local', { audio: 'x' });
    jm.start(j.jobId);
    jm.complete(j.jobId, { ok: true });
    const done = jm.get(j.jobId)!;
    expect(done.status).toBe('COMPLETED');
    expect(done.durationMs).not.toBeNull();
    // Nach Abschluss darf ein identischer Request einen neuen Job bekommen.
    const again = jm.create('s1', 'u1', 'audio.embed', 'clap-music', 'local', { audio: 'x' });
    expect(again.jobId).not.toBe(j.jobId);
  });

  it('cleanupStale beendet hängende Jobs', () => {
    const jm = new JobManager();
    const j = jm.create('s1', 'u1', 'llm', 'deepseek-flash', 'local', { prompt: 'x' });
    jm.start(j.jobId);
    jm.cleanupStale(0);
    expect(jm.get(j.jobId)?.status).toBe('TIMEOUT');
  });
});

// ---------------------------------------------------------------------------
// Cost Tracker
// ---------------------------------------------------------------------------
describe('Cost Tracker', () => {
  it('berechnet A100-GPU-Kosten und Session-Summen', () => {
    const ct = new CostTracker();
    const entry = ct.record({
      jobId: 'j1',
      sessionId: 's1',
      provider: 'hf-endpoint',
      task: 'audio.classify',
      model: 'ast-audioset',
      gpuType: 'A100',
      gpuRuntimeMs: 3_600_000,
      inferenceMs: 2_000,
      estimatedCostUsd: ct.estimateGpuCostUsd(3_600_000),
    });
    expect(entry.estimatedCostUsd).toBeCloseTo(2.5, 1);
    expect(ct.costForSession('s1')).toBeCloseTo(2.5, 1);
    expect(ct.summary().totalUsd).toBeGreaterThan(0);
  });

  it('Replicate-Stem-Kosten sind fix konfigurierbar', () => {
    const ct = new CostTracker();
    expect(ct.estimateJobCostUsd('stem.separate', 'replicate', 'cjwbw/demucs')).toBeCloseTo(0.05, 2);
  });
});

// ---------------------------------------------------------------------------
// Logging (Secret-Redaction)
// ---------------------------------------------------------------------------
describe('AiLogger redactSecrets', () => {
  it('entfernt HF-/DeepSeek-/Replicate-Keys und Bearer-Tokens', () => {
    const out = redactSecrets({
      msg: 'call failed',
      headers: { Authorization: 'Bearer abcdefghijklmnop' },
      env: { HF_API_KEY: 'hf_abcdef123456', DEEPSEEK_API_KEY: 'sk-abcdef123456', REPLICATE_API_TOKEN: 'r8_abcdef123456' },
    }) as Record<string, unknown>;
    const text = JSON.stringify(out);
    expect(text).not.toContain('hf_abcdef123456');
    expect(text).not.toContain('sk-abcdef123456');
    expect(text).not.toContain('r8_abcdef123456');
    expect(text).not.toContain('abcdefghijklmnop');
    expect(text).toContain('[REDACTED');
  });
});

// ---------------------------------------------------------------------------
// Circuit Breaker (Phase 3 Hardening)
// ---------------------------------------------------------------------------
describe('Circuit Breaker', () => {
  it('öffnet nach failureThreshold und lehnt fail-fast ab', async () => {
    const { CircuitBreaker } = await import('../src/core/ai/orchestrator/circuitBreaker');
    const cb = new CircuitBreaker('test', { failureThreshold: 2, resetTimeoutMs: 60_000 });
    await expect(cb.call(() => Promise.reject(new Error('e1')))).rejects.toThrow('e1');
    await expect(cb.call(() => Promise.reject(new Error('e2')))).rejects.toThrow('e2');
    expect(cb.getState()).toBe('OPEN');
    await expect(cb.call(() => Promise.resolve('ok'))).rejects.toThrow(/circuit breaker open/);
  });

  it('schließt nach Erfolg und HALF_OPEN nach Reset-Timeout', async () => {
    const { CircuitBreaker } = await import('../src/core/ai/orchestrator/circuitBreaker');
    const cb = new CircuitBreaker('test2', { failureThreshold: 1, resetTimeoutMs: 60_000 });
    await expect(cb.call(() => Promise.reject(new Error('x')))).rejects.toThrow();
    expect(cb.getState()).toBe('OPEN');
    // Reset-Timeout überspringen – getState ist jetzt REIN (keine Mutation, FA-P1-8).
    (cb as unknown as { openedAt: number }).openedAt = Date.now() - 61_000;
    expect(cb.getState()).toBe('OPEN');
    await expect(cb.call(() => Promise.resolve('ok'))).resolves.toBe('ok');
    expect(cb.getState()).toBe('CLOSED');
  });

  it('HALF_OPEN erlaubt nur einen Probe-Call (kein Thundering Herd)', async () => {
    const { CircuitBreaker } = await import('../src/core/ai/orchestrator/circuitBreaker');
    const cb = new CircuitBreaker('test3', { failureThreshold: 1, resetTimeoutMs: 0 });
    await expect(cb.call(() => Promise.reject(new Error('x')))).rejects.toThrow();
    (cb as unknown as { openedAt: number }).openedAt = 0;
    const slow = cb.call(() => new Promise((r) => setTimeout(() => r('ok'), 20)));
    await expect(cb.call(() => Promise.resolve('ok2'))).rejects.toThrow(/probe busy/);
    await expect(slow).resolves.toBe('ok');
    expect(cb.getState()).toBe('CLOSED');
  });
});
