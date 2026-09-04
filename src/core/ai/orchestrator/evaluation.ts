/**
 * audioMONASTRY · AI Orchestrator – Evaluierungs-Framework (Phase 2)
 * ==================================================================
 * Metriken: Token-Usage (Schätzung), Latency, Accuracy (Exact-Match),
 * BLEU (vereinfacht), ROUGE-L. EvalRunner sammelt Cases und aggregiert.
 *
 * Hinweis: BLEU/ROUGE sind bewusst einfache, deterministische
 * Referenzimplementierungen für Text-Qualitätsvergleiche – für
 * Produktions-Benchmarks werden sie durch gemessene Latenz-/Token-Werte
 * (JobManager/CostTracker) ergänzt.
 */

export interface EvalCase {
  id: string;
  task: string;
  model: string;
  input: string;
  expected: string;
  actual: string;
  latencyMs: number;
}

export interface EvalMetrics {
  tokenUsage: { promptTokens: number; completionTokens: number; total: number };
  latencyMs: number;
  exactMatch: boolean;
  bleu: number;
  rougeL: number;
}

export interface EvalReport {
  cases: Array<{ id: string; metrics: EvalMetrics }>;
  summary: {
    count: number;
    avgLatencyMs: number;
    accuracy: number;
    avgBleu: number;
    avgRougeL: number;
    totalTokens: number;
  };
}

/** Grobe Token-Schätzung: ~4 Zeichen je Token (deutsch/englisch gemischt). */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function tokenUsage(input: string, completion: string) {
  const promptTokens = estimateTokens(input);
  const completionTokens = estimateTokens(completion);
  return { promptTokens, completionTokens, total: promptTokens + completionTokens };
}

export function exactMatch(expected: string, actual: string): boolean {
  return expected.trim().toLowerCase() === actual.trim().toLowerCase();
}

function ngrams(tokens: string[], n: number): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = 0; i + n <= tokens.length; i++) {
    const key = tokens.slice(i, i + n).join(' ');
    out.set(key, (out.get(key) ?? 0) + 1);
  }
  return out;
}

/** Vereinfachtes BLEU: n-Gramm-Präzision 1..4 mit Brevity-Penalty. */
export function bleuScore(reference: string, candidate: string): number {
  const ref = reference.toLowerCase().split(/\s+/).filter(Boolean);
  const cand = candidate.toLowerCase().split(/\s+/).filter(Boolean);
  if (cand.length === 0 || ref.length === 0) return 0;

  let logSum = 0;
  for (const n of [1, 2, 3, 4]) {
    if (cand.length < n) continue;
    const refN = ngrams(ref, n);
    const candN = ngrams(cand, n);
    let hits = 0;
    for (const [key, count] of candN) hits += Math.min(count, refN.get(key) ?? 0);
    const precision = hits / (cand.length - n + 1);
    logSum += Math.log(Math.max(precision, 1e-9));
  }
  const nCount = Math.min(4, cand.length);
  const brevity = cand.length >= ref.length ? 1 : Math.exp(1 - ref.length / Math.max(1, cand.length));
  return brevity * Math.exp(logSum / nCount);
}

/** ROUGE-L: längste gemeinsame Teilsequenz (Recall/Precision/F1). */
export function rougeL(reference: string, candidate: string) {
  const ref = reference.toLowerCase().split(/\s+/).filter(Boolean);
  const cand = candidate.toLowerCase().split(/\s+/).filter(Boolean);
  if (ref.length === 0 || cand.length === 0) return 0;

  const dp: number[][] = Array.from({ length: ref.length + 1 }, () => new Array<number>(cand.length + 1).fill(0));
  for (let i = 1; i <= ref.length; i++) {
    for (let j = 1; j <= cand.length; j++) {
      dp[i][j] = ref[i - 1] === cand[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const lcs = dp[ref.length][cand.length];
  const recall = lcs / ref.length;
  const precision = lcs / cand.length;
  const f1 = recall + precision === 0 ? 0 : (2 * recall * precision) / (recall + precision);
  return f1;
}

export function evaluateCase(testCase: EvalCase): EvalMetrics {
  return {
    tokenUsage: tokenUsage(testCase.input, testCase.actual),
    latencyMs: testCase.latencyMs,
    exactMatch: exactMatch(testCase.expected, testCase.actual),
    bleu: Number(bleuScore(testCase.expected, testCase.actual).toFixed(4)),
    rougeL: Number(rougeL(testCase.expected, testCase.actual).toFixed(4)),
  };
}

export class EvalRunner {
  private cases: EvalCase[] = [];

  add(testCase: EvalCase): void {
    this.cases.push(testCase);
  }

  run(): EvalReport {
    const evaluated = this.cases.map((c) => ({ id: c.id, metrics: evaluateCase(c) }));
    const count = evaluated.length;
    const avg = (fn: (m: EvalMetrics) => number) => (count ? evaluated.reduce((s, e) => s + fn(e.metrics), 0) / count : 0);
    return {
      cases: evaluated,
      summary: {
        count,
        avgLatencyMs: Number(avg((m) => m.latencyMs).toFixed(1)),
        accuracy: Number(avg((m) => (m.exactMatch ? 1 : 0)).toFixed(4)),
        avgBleu: Number(avg((m) => m.bleu).toFixed(4)),
        avgRougeL: Number(avg((m) => m.rougeL).toFixed(4)),
        totalTokens: evaluated.reduce((s, e) => s + e.metrics.tokenUsage.total, 0),
      },
    };
  }
}
