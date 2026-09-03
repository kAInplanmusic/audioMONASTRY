/**
 * audioMONASTRY · 6.1.1/6.1.2 – Telemetrie & Latenz-Budgets
 * ===========================================================
 * Zentrale Metrik-Registry mit Latenz-Budgets pro Pipeline. Jede Pipeline
 * (input/mix/process/master/spatial/collab) meldet ihre gemessene Latenz;
 * Budget-Verletzungen werden als Warnungen geführt.
 *
 * AM-E6-1: Erweitert um Worklet-CPU-Budgets, Per-Sample-Allokationen und ein
 * Xrun-/Dropout-Histogramm (Ringpuffer) für das kontinuierliche Profiling im
 * perfMONK (`PerformanceMonitorTerminal`).
 */
export interface PipelineBudget {
  pipeline: string;
  budgetMs: number;
  lastMs: number;
  violations: number;
}

/** AM-E6-1: CPU-Budget eines Audio-Worklets (perfMONK-Profiling). */
export interface WorkletBudget {
  worklet: string;
  budgetMs: number;
  lastMs: number;
  violations: number;
}

/** AM-E6-1: Ein Xrun/Underrun-Eintrag im Histogramm (Ringpuffer, max. 100). */
export interface XrunEntry {
  ts: number;
  source: string;
}

const DEFAULT_BUDGETS: PipelineBudget[] = [
  { pipeline: 'input', budgetMs: 1, lastMs: 0, violations: 0 },
  { pipeline: 'mix', budgetMs: 1, lastMs: 0, violations: 0 },
  { pipeline: 'process', budgetMs: 2, lastMs: 0, violations: 0 },
  { pipeline: 'master', budgetMs: 2, lastMs: 0, violations: 0 },
  { pipeline: 'spatial', budgetMs: 2, lastMs: 0, violations: 0 },
  { pipeline: 'collab', budgetMs: 50, lastMs: 0, violations: 0 },
];

const XRUN_HISTORY_LIMIT = 100;

export class Telemetry {
  private budgets = new Map<string, PipelineBudget>();
  private counters = new Map<string, number>();
  private workletBudgets = new Map<string, WorkletBudget>();
  private xrunHistory: XrunEntry[] = [];
  private onViolation: (pipeline: string, lastMs: number, budgetMs: number) => void = () => {};

  constructor() {
    DEFAULT_BUDGETS.forEach((b) => this.budgets.set(b.pipeline, { ...b }));
  }

  onBudgetViolation(cb: (pipeline: string, lastMs: number, budgetMs: number) => void): void {
    this.onViolation = cb;
  }

  recordLatency(pipeline: string, ms: number): void {
    const budget = this.budgets.get(pipeline);
    if (!budget) return;
    budget.lastMs = ms;
    if (ms > budget.budgetMs) {
      budget.violations++;
      this.onViolation(pipeline, ms, budget.budgetMs);
    }
  }

  increment(counter: string, by = 1): void {
    this.counters.set(counter, (this.counters.get(counter) ?? 0) + by);
  }

  get(counter: string): number {
    return this.counters.get(counter) ?? 0;
  }

  /** AM-E6-1: Xrun/Underrun im Histogramm führen (Ringpuffer + Zähler). */
  recordXrun(source: string): void {
    this.xrunHistory.push({ ts: Date.now(), source: String(source).slice(0, 64) });
    if (this.xrunHistory.length > XRUN_HISTORY_LIMIT) {
      this.xrunHistory = this.xrunHistory.slice(-XRUN_HISTORY_LIMIT);
    }
    this.increment('xruns');
  }

  /** AM-E6-1: Gemessene Worklet-CPU-Zeit gegen das CPU-Budget prüfen. */
  recordWorkletCpu(worklet: string, ms: number, budgetMs = 2): void {
    let b = this.workletBudgets.get(worklet);
    if (!b) {
      b = { worklet, budgetMs, lastMs: 0, violations: 0 };
      this.workletBudgets.set(worklet, b);
    }
    b.lastMs = ms;
    b.budgetMs = budgetMs;
    if (ms > b.budgetMs) {
      b.violations++;
      this.onViolation(worklet, ms, b.budgetMs);
    }
  }

  /** AM-E6-1: Per-Sample-Allokation im Worklet zählen (ergänzt statisches Audit). */
  recordWorkletAllocation(worklet: string): void {
    this.increment('worklet.allocations');
    this.increment(`worklet.allocations.${worklet}`);
  }

  snapshot(): {
    budgets: PipelineBudget[];
    worklets: WorkletBudget[];
    counters: Record<string, number>;
    xruns: { count: number; history: XrunEntry[] };
  } {
    return {
      budgets: [...this.budgets.values()].map((b) => ({ ...b })),
      worklets: [...this.workletBudgets.values()].map((b) => ({ ...b })),
      counters: Object.fromEntries(this.counters),
      xruns: {
        count: this.counters.get('xruns') ?? 0,
        history: this.xrunHistory.map((x) => ({ ...x })),
      },
    };
  }
}

export const telemetry = new Telemetry();
