/**
 * audioMONASTRY · AI Orchestrator – Supabase-Persistenz
 * ======================================================
 * Persistiert AI-Sessions, Jobs, Model-Usage, Errors, Kosten und MCP-Audit-Events
 * in der bestehenden Supabase-Datenbank (keine neue DB). Ohne konfiguriertes
 * Supabase degradiert das Modul zu No-Ops (Offline-Betrieb bleibt möglich).
 *
 * Schema: database/ai_migration_001.sql (versioniert, nicht-destruktiv).
 */
import { PostgrestClient } from '@supabase/postgrest-js';
import { aiLogger } from './aiLogger';
import { supabaseServerKey, supabaseUrl } from '../../../config/supabaseKeys';
import type { AiJob, AiSession } from './types';

let client: PostgrestClient | null = null;
let testClient: PostgrestClient | null = null;

/** Nur für Tests: injiziert einen Mock-Supabase-Client (serverlos). */
export function setAiPersistenceClientForTests(mock: PostgrestClient | null): void {
  testClient = mock;
}

function getClient(): PostgrestClient | null {
  if (testClient !== null) return testClient;
  if (client) return client;
  // AI-P1-007 (live gemessen 2026-09-17): hier stand `process.env.SUPABASE_URL`.
  // Die .env benennt die URL aber `SB_URL` (seit der Umbenennung 2026-09-13,
  // siehe src/config/supabaseKeys.ts) - der Client wurde deshalb nie gebaut und
  // JEDER Schreibpfad lief still ins Leere. Genau das ist der in supabaseKeys.ts
  // beschriebene Fehlertyp (stummer No-Op statt Fehler). `supabaseUrl()` kennt
  // SB_URL vor SUPABASE_URL.
  const url = supabaseUrl();
  // EINE Prioritätsordnung (src/config/supabaseKeys.ts): der tote Legacy-PAT darf
  // den gültigen Service-Role-Key nicht mehr verdecken (Live-Bug 2026-09-11).
  const key = supabaseServerKey();
  if (!url || !key) return null;
  try {
    client = new PostgrestClient(`${url.replace(/\/+$/, '')}/rest/v1`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      schema: 'public',
    });
  } catch {
    return null;
  }
  return client;
}

/** Eine Zeile aus `ai_evaluations` in der Form, die das Laden braucht (AI-P1-007). */
export interface PersistedEvaluation {
  id: string;
  pluginId: string;
  task: string;
  model: string;
  provider: string;
  /** `input` ist jsonb: je nach Schreibpfad ein JSON-String ODER ein Objekt. */
  input: unknown;
  output: unknown;
  score: number;
  metrics: Record<string, unknown>;
  /** ISO-Zeitstempel aus der DB. */
  createdAt: string;
}

/** Ist eine Supabase-Verbindung konfiguriert? (Für ehrliche Diagnose statt No-Op.) */
export function isAiPersistenceConfigured(): boolean {
  return getClient() !== null;
}

export const aiPersistence = {
  async saveSession(session: AiSession): Promise<void> {
    const db = getClient();
    if (!db) return;
    try {
      await db.from('ai_sessions').upsert({
        session_id: session.sessionId,
        state: session.state,
        last_activity: new Date(session.lastActivity).toISOString(),
        active_jobs: session.activeJobs,
        loaded_models: session.loadedModels,
        endpoint_state: session.endpointState,
      });
    } catch (error) {
      aiLogger.warn('supabase saveSession failed', { sessionId: session.sessionId, error: (error as Error).message });
    }
  },

  async saveJob(job: AiJob): Promise<void> {
    const db = getClient();
    if (!db) return;
    try {
      await db.from('ai_jobs').upsert({
        job_id: job.jobId,
        session_id: job.sessionId,
        user_id: job.userId,
        task: job.task,
        model: job.model,
        provider: job.provider,
        status: job.status,
        started_at: job.startedAt ? new Date(job.startedAt).toISOString() : null,
        completed_at: job.completedAt ? new Date(job.completedAt).toISOString() : null,
        duration_ms: job.durationMs,
        error: job.error,
        dedupe_key: job.dedupeKey,
      });
    } catch (error) {
      aiLogger.warn('supabase saveJob failed', { jobId: job.jobId, error: (error as Error).message });
    }
  },

  async saveModelUsage(sessionId: string, model: string, task: string, provider: string, inferenceMs: number): Promise<void> {
    const db = getClient();
    if (!db) return;
    try {
      await db.from('ai_model_usage').insert({
        session_id: sessionId,
        model,
        task,
        provider,
        inference_ms: inferenceMs,
      });
    } catch (error) {
      aiLogger.warn('supabase saveModelUsage failed', { sessionId, model, error: (error as Error).message });
    }
  },

  async saveError(job: AiJob): Promise<void> {
    const db = getClient();
    if (!db) return;
    try {
      await db.from('ai_errors').insert({
        job_id: job.jobId,
        session_id: job.sessionId,
        model: job.model,
        provider: job.provider,
        error: job.error,
      });
    } catch (error) {
      aiLogger.warn('supabase saveError failed', { jobId: job.jobId, error: (error as Error).message });
    }
  },

  async saveCostEstimate(jobId: string, sessionId: string, estimatedCostUsd: number): Promise<void> {
    const db = getClient();
    if (!db) return;
    try {
      await db.from('ai_cost_estimates').insert({
        job_id: jobId,
        session_id: sessionId,
        estimated_cost_usd: estimatedCostUsd,
      });
    } catch (error) {
      aiLogger.warn('supabase saveCostEstimate failed', { jobId, error: (error as Error).message });
    }
  },

  /**
   * Semantische Bibliotheks-Suche: ruft die `match_samples`-RPC (pgvector,
   * Kosinus-Ähnlichkeit) auf. Liefert [] bei fehlendem Client/Fehler, damit
   * der Server auf den Keyword-Fallback zurückfallen kann.
   */
  async rpcMatchSamples(embedding: number[], matchCount = 10): Promise<Array<{ sample_id: string; similarity: number }>> {
    const db = getClient();
    if (!db) return [];
    try {
      const { data, error } = await db.rpc('match_samples', {
        query_embedding: embedding,
        match_count: matchCount,
      });
      if (error) return [];
      return Array.isArray(data) ? (data as Array<{ sample_id: string; similarity: number }>) : [];
    } catch {
      return [];
    }
  },

  async auditMcp(tool: string, userId: string, sessionId: string, ok: boolean, permission: string): Promise<void> {
    const db = getClient();
    if (!db) return;
    try {
      await db.from('mcp_audit_events').insert({
        tool,
        user_id: userId,
        session_id: sessionId,
        ok,
        permission,
      });
    } catch (error) {
      aiLogger.warn('supabase auditMcp failed', { tool, error: (error as Error).message });
    }
  },

  /** GAP-5: Systemprompt-Version in `system_prompts` schreiben (Migration 002). */
  async saveSystemPrompt(prompt: {
    pluginId: string;
    role: string;
    version: number;
    content: string;
    enabled: boolean;
    meta: Record<string, unknown>;
  }): Promise<void> {
    const db = getClient();
    if (!db) return;
    try {
      await db.from('system_prompts').insert({
        plugin_id: prompt.pluginId,
        role: prompt.role,
        version: prompt.version,
        content: prompt.content,
        enabled: prompt.enabled,
        meta: prompt.meta,
      });
    } catch (error) {
      aiLogger.warn('supabase saveSystemPrompt failed', { pluginId: prompt.pluginId, error: (error as Error).message });
    }
  },

  /** GAP-5: Prompt-Version + Changelog in `plugin_prompt_versions` schreiben. */
  async savePromptVersion(entry: { pluginId: string; version: number; changelog: string }): Promise<void> {
    const db = getClient();
    if (!db) return;
    try {
      await db.from('plugin_prompt_versions').insert({
        plugin_id: entry.pluginId,
        version: entry.version,
        changelog: entry.changelog,
      });
    } catch (error) {
      aiLogger.warn('supabase savePromptVersion failed', { pluginId: entry.pluginId, error: (error as Error).message });
    }
  },

  /**
   * AI-P1-007: Eval-Zeilen wieder einlesen (Gegenstueck zu `saveEvaluation`).
   * Ohne Client oder bei Fehlern kommt `[]` zurueck - der Aufrufer entscheidet,
   * ob das "nichts gespeichert" oder "nicht erreichbar" bedeutet (`isAiPersistenceConfigured`).
   */
  async loadEvaluations(query: { task: string; pluginId?: string; limit?: number }): Promise<PersistedEvaluation[]> {
    const db = getClient();
    if (!db) return [];
    const limit = Number.isFinite(query.limit) && (query.limit as number) > 0 ? Math.floor(query.limit as number) : 1000;
    try {
      let builder = db
        .from('ai_evaluations')
        .select('id,plugin_id,task,model,provider,input,output,score,metrics,created_at')
        .eq('task', query.task);
      if (query.pluginId) builder = builder.eq('plugin_id', query.pluginId);
      const { data, error } = await builder.order('created_at', { ascending: true }).limit(limit);
      if (error) {
        aiLogger.warn('supabase loadEvaluations failed', { task: query.task, error: error.message });
        return [];
      }
      if (!Array.isArray(data)) return [];
      return data.map((row) => {
        const r = row as Record<string, unknown>;
        return {
          id: String(r.id ?? ''),
          pluginId: String(r.plugin_id ?? ''),
          task: String(r.task ?? ''),
          model: String(r.model ?? ''),
          provider: String(r.provider ?? ''),
          input: r.input,
          output: r.output,
          score: Number(r.score ?? 0),
          metrics: (r.metrics && typeof r.metrics === 'object' ? r.metrics : {}) as Record<string, unknown>,
          createdAt: String(r.created_at ?? ''),
        };
      });
    } catch (error) {
      aiLogger.warn('supabase loadEvaluations failed', { task: query.task, error: (error as Error).message });
      return [];
    }
  },

  /** P3-3: Eval-Ergebnis in `ai_evaluations` schreiben (Migration 002). */
  async saveEvaluation(record: {
    pluginId: string;
    task: string;
    promptVersion: number;
    model: string;
    provider: string;
    input: unknown;
    output: unknown;
    score: number;
    metrics: Record<string, unknown>;
  }): Promise<void> {
    const db = getClient();
    if (!db) return;
    try {
      await db.from('ai_evaluations').insert({
        plugin_id: record.pluginId,
        task: record.task,
        prompt_version: record.promptVersion,
        model: record.model,
        provider: record.provider,
        input: record.input,
        output: record.output,
        score: record.score,
        metrics: record.metrics,
      });
    } catch (error) {
      aiLogger.warn('supabase saveEvaluation failed', { pluginId: record.pluginId, error: (error as Error).message });
    }
  },

  /** P3-3: Eval-Run-Summary in `ai_eval_runs` schreiben (Gate bei Score-Abfall). */
  async saveEvalRun(run: { runId: string; pluginId: string; status: string; summary: Record<string, unknown> }): Promise<void> {
    const db = getClient();
    if (!db) return;
    try {
      await db.from('ai_eval_runs').insert({
        run_id: run.runId,
        plugin_id: run.pluginId,
        status: run.status,
        summary: run.summary,
      });
    } catch (error) {
      aiLogger.warn('supabase saveEvalRun failed', { runId: run.runId, error: (error as Error).message });
    }
  },
};
