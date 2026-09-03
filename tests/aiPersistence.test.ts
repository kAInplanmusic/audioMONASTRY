import { describe, expect, it, afterEach } from 'vitest';
import { aiPersistence, setAiPersistenceClientForTests } from '../src/core/ai/orchestrator/aiPersistence';

type Call = { table: string; op: 'upsert' | 'insert'; data: Record<string, unknown> };

function createMockClient(calls: Call[]) {
  return {
    from: (table: string) => ({
      upsert: async (data: Record<string, unknown>) => { calls.push({ table, op: 'upsert', data }); },
      insert: async (data: Record<string, unknown>) => { calls.push({ table, op: 'insert', data }); },
    }),
  } as any;
}

describe('AI-Supabase-Persistenz (AITodo Phase 12, gemockt)', () => {
  afterEach(() => setAiPersistenceClientForTests(null));

  it('saveSession/saveJob schreiben in ai_sessions/ai_jobs', async () => {
    const calls: Call[] = [];
    setAiPersistenceClientForTests(createMockClient(calls));

    await aiPersistence.saveSession({
      sessionId: 's1', state: 'READY', lastActivity: 123, activeJobs: 0,
      loadedModels: [], endpointState: 'cold',
    } as any);
    await aiPersistence.saveJob({
      jobId: 'j1', sessionId: 's1', userId: 'u1', task: 'transcribe', model: 'whisper',
      provider: 'hf', status: 'RUNNING', dedupeKey: 'd1',
    } as any);

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ table: 'ai_sessions', op: 'upsert' });
    expect(calls[0].data).toMatchObject({ session_id: 's1', state: 'READY' });
    expect(calls[1]).toMatchObject({ table: 'ai_jobs', op: 'upsert' });
    expect(calls[1].data).toMatchObject({ job_id: 'j1', dedupe_key: 'd1' });
  });

  it('saveError/saveModelUsage/saveCostEstimate/auditMcp nutzen die passenden Tabellen', async () => {
    const calls: Call[] = [];
    setAiPersistenceClientForTests(createMockClient(calls));

    await aiPersistence.saveError({ jobId: 'j1', sessionId: 's1', model: 'm', provider: 'p', error: 'kaputt' } as any);
    await aiPersistence.saveModelUsage('s1', 'm', 't', 'p', 123);
    await aiPersistence.saveCostEstimate('j1', 's1', 0.05);
    await aiPersistence.auditMcp('mixer.set_channel', 'u1', 's1', true, 'WRITE');

    expect(calls.map((c) => c.table)).toEqual(['ai_errors', 'ai_model_usage', 'ai_cost_estimates', 'mcp_audit_events']);
  });

  it('ohne Client ist alles No-Op (kein Wurf)', async () => {
    setAiPersistenceClientForTests(null);
    await expect(aiPersistence.saveSession({} as any)).resolves.toBeUndefined();
    await expect(aiPersistence.saveError({} as any)).resolves.toBeUndefined();
  });

  it('P3-3: saveEvaluation/saveEvalRun schreiben in ai_evaluations/ai_eval_runs', async () => {
    const calls: Call[] = [];
    setAiPersistenceClientForTests(createMockClient(calls));

    await aiPersistence.saveEvaluation({
      pluginId: 'mixer', task: 'plan', promptVersion: 1, model: 'mock', provider: 'offline',
      input: 'mixer gain', output: 'mixer:gain', score: 5, metrics: { latencyMs: 5 },
    });
    await aiPersistence.saveEvalRun({
      runId: 'run-1', pluginId: 'mixer', status: 'PASS', summary: { avgScore: 5, count: 1 },
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ table: 'ai_evaluations', op: 'insert' });
    expect(calls[0].data).toMatchObject({ plugin_id: 'mixer', score: 5, prompt_version: 1 });
    expect(calls[1]).toMatchObject({ table: 'ai_eval_runs', op: 'insert' });
    expect(calls[1].data).toMatchObject({ run_id: 'run-1', plugin_id: 'mixer', status: 'PASS' });
  });

  it('GAP-5: saveSystemPrompt/savePromptVersion schreiben in system_prompts/plugin_prompt_versions', async () => {
    const calls: Call[] = [];
    setAiPersistenceClientForTests(createMockClient(calls));

    await aiPersistence.saveSystemPrompt({
      pluginId: 'mixer', role: 'system', version: 2, content: 'Du steuerst den Mischpult-MONK.',
      enabled: true, meta: { source: 'iteration' },
    });
    await aiPersistence.savePromptVersion({ pluginId: 'mixer', version: 2, changelog: 'Kommando-Katalog ergänzt' });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ table: 'system_prompts', op: 'insert' });
    expect(calls[0].data).toMatchObject({ plugin_id: 'mixer', version: 2, enabled: true });
    expect(calls[1]).toMatchObject({ table: 'plugin_prompt_versions', op: 'insert' });
    expect(calls[1].data).toMatchObject({ plugin_id: 'mixer', version: 2 });
  });
});
