/**
 * audioMONASTRY · 6.1.1/6.1.2 – Telemetrie & Latenz-Budgets
 * ===========================================================
 * Zentrale Metrik-Registry mit Latenz-Budgets pro Pipeline. Jede Pipeline
 * (input/mix/process/master/spatial/collab) meldet ihre gemessene Latenz;
 * Budget-Verletzungen werden als Warnungen geführt.
 */
export interface PipelineBudget {
  pipeline: string;
  budgetMs: number;
  lastMs: number;
  violations: number;
}

const DEFAULT_BUDGETS: PipelineBudget[] = [
  { pipeline: 'input', budgetMs: 1, lastMs: 0, violations: 0 },
  { pipeline: 'mix', budgetMs: 1, lastMs: 0, violations: 0 },
  { pipeline: 'process', budgetMs: 2, lastMs: 0, violations: 0 },
  { pipeline: 'master', budgetMs: 2, lastMs: 0, violations: 0 },
  { pipeline: 'spatial', budgetMs: 2, lastMs: 0, violations: 0 },
  { pipeline: 'collab', budgetMs: 50, lastMs: 0, violations: 0 },
];

export class Telemetry {
  private budgets = new Map<string, PipelineBudget>();
  private counters = new Map<string, number>();
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

  snapshot(): { budgets: PipelineBudget[]; counters: Record<string, number> } {
    return {
      budgets: [...this.budgets.values()].map((b) => ({ ...b })),
      counters: Object.fromEntries(this.counters),
    };
  }
}

export const telemetry = new Telemetry();
