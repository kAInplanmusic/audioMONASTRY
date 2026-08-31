// ============================================================================
// evaluationStore – AuditEval/AuditScore-Ergebnisse je Plugin (P3-3 / GAP-5)
// ----------------------------------------------------------------------------
// In-Memory-Referenzimplementierung. Im Betrieb werden die Ergebnisse über
// `ai_evaluations` / `ai_eval_runs` in Supabase persistiert (Migration 002).
// ============================================================================

export interface EvaluationRecord {
  id: string;
  pluginId: string;
  task: string;
  promptVersion: number;
  model: string;
  provider: string;
  input: unknown;
  output: unknown;
  score: number;
  metrics: Record<string, unknown>;
  createdAt: number;
}

export interface EvalRunSummary {
  runId: string;
  pluginId: string;
  status: 'RUNNING' | 'PASS' | 'FAIL';
  count: number;
  avgScore: number;
  createdAt: number;
}

function makeId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export class EvaluationStore {
  private evaluations = new Map<string, EvaluationRecord>();
  private runs = new Map<string, EvalRunSummary>();

  record(input: Omit<EvaluationRecord, 'id' | 'createdAt'>): EvaluationRecord {
    const full: EvaluationRecord = { ...input, id: makeId('eval'), createdAt: Date.now() };
    this.evaluations.set(full.id, full);
    return full;
  }

  listByPlugin(pluginId: string): EvaluationRecord[] {
    return [...this.evaluations.values()]
      .filter((e) => e.pluginId === pluginId)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  averageScore(pluginId: string): number {
    const items = this.listByPlugin(pluginId);
    if (items.length === 0) return 0;
    return items.reduce((sum, e) => sum + e.score, 0) / items.length;
  }

  startRun(pluginId: string): EvalRunSummary {
    const run: EvalRunSummary = {
      runId: makeId('run'),
      pluginId,
      status: 'RUNNING',
      count: 0,
      avgScore: 0,
      createdAt: Date.now(),
    };
    this.runs.set(run.runId, run);
    return run;
  }

  finishRun(runId: string, minScore = 4): EvalRunSummary {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`unknown run: ${runId}`);
    const avg = this.averageScore(run.pluginId);
    run.count = this.listByPlugin(run.pluginId).length;
    run.avgScore = Number(avg.toFixed(3));
    run.status = avg >= minScore ? 'PASS' : 'FAIL';
    this.runs.set(runId, run);
    return run;
  }

  getRun(runId: string): EvalRunSummary | undefined {
    return this.runs.get(runId);
  }

  exportJson(): { evaluations: EvaluationRecord[]; runs: EvalRunSummary[] } {
    return { evaluations: [...this.evaluations.values()], runs: [...this.runs.values()] };
  }
}

export const evaluationStore = new EvaluationStore();
