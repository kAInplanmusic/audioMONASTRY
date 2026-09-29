import { describe, expect, it, afterEach, vi } from 'vitest';
import { aiPersistence, setAiPersistenceClientForTests } from '../src/core/ai/orchestrator/aiPersistence';

type Call = { table: string; op: 'upsert' | 'insert'; data: Record<string, unknown>; options?: Record<string, unknown> };

function createMockClient(calls: Call[]) {
  return {
    from: (table: string) => ({
      // `options` wird mitgeschrieben: seit dem 2026-09-23 upsertet
      // `saveSystemPrompt` gegen (plugin_id, role, version). Ohne diese
      // Aufzeichnung koennte der Test nicht pruefen, WOGEGEN konfliktfrei
      // geschrieben wird - und genau das verhindert die Duplikate, die es bis
      // dahin gab (53 Zeilen fuer 22 Rollen).
      upsert: async (data: Record<string, unknown>, options?: Record<string, unknown>) => { calls.push({ table, op: 'upsert', data, options }); },
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
    // upsert GEGEN den Schluessel, den die Datenbank wirklich hat - sonst
    // kommen die Duplikate zurueck (53 Zeilen fuer 22 Rollen am 2026-09-23).
    expect(calls[0]).toMatchObject({ table: 'system_prompts', op: 'upsert' });
    expect(calls[0].options).toMatchObject({ onConflict: 'plugin_id,role,version' });
    expect(calls[0].data).toMatchObject({ plugin_id: 'mixer', version: 2, enabled: true });
    expect(calls[1]).toMatchObject({ table: 'plugin_prompt_versions', op: 'upsert' });
    expect(calls[1].options).toMatchObject({ onConflict: 'plugin_id,version' });
    expect(calls[1].data).toMatchObject({ plugin_id: 'mixer', version: 2 });
  });
});

  it('rpcMatchSamples ruft die match_samples-RPC mit Embedding auf', async () => {
    const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
    const mock = {
      rpc: async (fn: string, args: Record<string, unknown>) => {
        rpcCalls.push({ fn, args });
        return { data: [{ sample_id: 'bass-909-kick', similarity: 0.98 }], error: null };
      },
    } as any;
    setAiPersistenceClientForTests(mock);

    const matches = await aiPersistence.rpcMatchSamples([0.1, 0.2], 5);
    expect(matches).toEqual([{ sample_id: 'bass-909-kick', similarity: 0.98 }]);
    expect(rpcCalls[0]).toMatchObject({ fn: 'match_samples' });
    expect(rpcCalls[0].args.match_count).toBe(5);
  });

  it('rpcMatchSamples liefert [] bei RPC-Fehler', async () => {
    setAiPersistenceClientForTests({
      rpc: async () => ({ data: null, error: { message: 'kaputt' } }),
    } as any);
    await expect(aiPersistence.rpcMatchSamples([0.1], 3)).resolves.toEqual([]);
  });

/**
 * AI-P1-007: Lesepfad + URL-Alias. Die `.env` benennt die Supabase-URL
 * `SB_URL`; `getClient()` las aber nur `SUPABASE_URL`. Folge (live gemessen
 * 2026-09-17): ohne Client lief JEDER Schreibpfad still ins Leere, und die
 * MOS-Wertungen waren nach einem Server-Neustart weg.
 */
describe('AI-P1-007 · loadEvaluations + Supabase-URL-Alias', () => {
  afterEach(() => setAiPersistenceClientForTests(null));

  function createReadClient(rows: unknown[], error: unknown = null, calls: Array<{ table: string; filters: Array<[string, unknown]> }> = []) {
    const chain: Record<string, unknown> = {};
    const entry = { table: '', filters: [] as Array<[string, unknown]> };
    chain.select = () => chain;
    chain.eq = (col: string, val: unknown) => {
      entry.filters.push([col, val]);
      return chain;
    };
    chain.order = () => chain;
    chain.limit = () => Promise.resolve({ data: rows, error });
    return {
      from: (table: string) => {
        entry.table = table;
        calls.push(entry);
        return chain;
      },
      __calls: calls,
    } as any;
  }

  it('liest ai_evaluations gefiltert nach task/plugin und mappt die Spalten', async () => {
    const calls: Array<{ table: string; filters: Array<[string, unknown]> }> = [];
    const client = createReadClient(
      [{
        id: 'x1', plugin_id: 'voice', task: 'voice.mos', model: 'qwen3-tts-06b', provider: 'mos-listener',
        input: '{"language":"DE","evaluatorId":"peter"}', output: '4', score: '4.000', metrics: { latencyMs: 0 },
        created_at: '2026-09-14T22:44:27.490529+00:00',
      }],
      null,
      calls,
    );
    setAiPersistenceClientForTests(client);

    const rows = await aiPersistence.loadEvaluations({ task: 'voice.mos', pluginId: 'voice' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'x1', pluginId: 'voice', task: 'voice.mos', model: 'qwen3-tts-06b', provider: 'mos-listener',
      score: 4, createdAt: '2026-09-14T22:44:27.490529+00:00',
    });
    expect(typeof rows[0].input).toBe('string');
    expect(calls[0].filters).toEqual([['task', 'voice.mos'], ['plugin_id', 'voice']]);
  });

  it('liefert [] bei DB-Fehler und ohne Client (kein Wurf)', async () => {
    setAiPersistenceClientForTests(createReadClient(null, { message: 'kaputt' }));
    await expect(aiPersistence.loadEvaluations({ task: 'voice.mos' })).resolves.toEqual([]);
    setAiPersistenceClientForTests(null);
    await expect(aiPersistence.loadEvaluations({ task: 'voice.mos' })).resolves.toEqual([]);
  });

  it('SB_URL allein genuegt fuer einen konfigurierten Client (Regression)', async () => {
    const saved = { SB_URL: process.env.SB_URL, SUPABASE_URL: process.env.SUPABASE_URL, SB_SERVICE_ROLE: process.env.SB_SERVICE_ROLE };
    try {
      vi.resetModules();
      delete process.env.SB_URL;
      delete process.env.SUPABASE_URL;
      delete process.env.SB_SERVICE_ROLE;
      const empty = await import('../src/core/ai/orchestrator/aiPersistence');
      expect(empty.isAiPersistenceConfigured()).toBe(false);

      vi.resetModules();
      process.env.SB_URL = 'https://example.supabase.co';
      process.env.SB_SERVICE_ROLE = 'x'.repeat(80);
      const configured = await import('../src/core/ai/orchestrator/aiPersistence');
      expect(configured.isAiPersistenceConfigured()).toBe(true);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
