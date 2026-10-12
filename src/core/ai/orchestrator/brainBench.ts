/**
 * audioMONASTRY · Brain-Benchmark – Kennzahlen (RT-AUDIT-P1-015, Schritt 7)
 * ========================================================================
 * Reine, netzfreie Bausteine für `scripts/benchmark-brain.ts`:
 *
 *   * `brainBenchPreflight` – ist ein Live-Endpunkt konfiguriert? Ohne ihn meldet
 *     das Skript sauber BLOCKED (kein erfundener Messwert, kein Stacktrace).
 *   * `summarizeTtft` – TTFT warm (p50/p95/min/max), Tokens/s, Gate
 *     „TTFT warm < 300 ms“ (Akzeptanz des Tickets; geprüft wird p50 UND p95,
 *     damit ein einzelner Glückstreffer das Gate nicht grün macht).
 */

/** Akzeptanzgrenze aus RT-AUDIT-P1-015: TTFT warm < 300 ms. */
export const BRAIN_TTFT_WARM_LIMIT_MS = 300;

export interface BrainBenchTarget {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export type BrainBenchPreflight =
  | { status: 'READY'; target: BrainBenchTarget }
  | { status: 'BLOCKED'; reason: string; missing: string[] };

/** Prüft die Konfiguration des Live-Endpunkts (OpenAI-kompatibler vLLM-Brain). */
export function brainBenchPreflight(env: Record<string, string | undefined>): BrainBenchPreflight {
  const read = (name: string) => (env[name] ?? '').trim();
  const baseUrl = (read('RP_BRAIN_OPENAI_URL') || read('RUNPOD_BRAIN_OPENAI_URL')).replace(/\/+$/, '');
  const apiKey = read('RP_AGENT_KEY') || read('RP_API_KEY') || read('RUNPOD_API_KEY');
  const missing: string[] = [];
  if (!baseUrl) missing.push('RP_BRAIN_OPENAI_URL | RUNPOD_BRAIN_OPENAI_URL');
  if (!apiKey) missing.push('RP_AGENT_KEY | RP_API_KEY | RUNPOD_API_KEY');
  if (missing.length > 0) {
    return {
      status: 'BLOCKED',
      reason: `kein Live-Brain-Endpunkt konfiguriert (fehlt: ${missing.join(', ')}) – TTFT nicht messbar`,
      missing,
    };
  }
  return {
    status: 'READY',
    target: {
      baseUrl,
      apiKey,
      model: read('RUNPOD_BRAIN_OPENAI_MODEL') || read('RP_BRAIN_OPENAI_MODEL') || read('RUNPOD_BRAIN_MODEL') || 'Qwen/Qwen3-14B-AWQ',
    },
  };
}

/** Ein gemessener Streaming-Aufruf. */
export interface TtftSample {
  ttftMs: number;
  totalMs: number;
  /** Anzahl Text-Deltas (vLLM: ≈ 1 Token je Delta – als Näherung markiert). */
  deltas: number;
}

export interface TtftSummary {
  runs: number;
  p50Ms: number;
  p95Ms: number;
  minMs: number;
  maxMs: number;
  /** Näherung: Deltas / (Gesamtzeit − TTFT). */
  tokensPerSecond: number;
  limitMs: number;
  pass: boolean;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

const round1 = (value: number) => Math.round(value * 10) / 10;

/** Fasst die TTFT-Messung zusammen; leer → kein Pass. */
export function summarizeTtft(samples: readonly TtftSample[], limitMs = BRAIN_TTFT_WARM_LIMIT_MS): TtftSummary {
  const ttfts = samples.map((s) => s.ttftMs).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  let deltas = 0;
  let genMs = 0;
  for (const s of samples) {
    deltas += Math.max(0, s.deltas - 1);
    genMs += Math.max(0, s.totalMs - s.ttftMs);
  }
  const p50 = percentile(ttfts, 50);
  const p95 = percentile(ttfts, 95);
  return {
    runs: ttfts.length,
    p50Ms: round1(p50),
    p95Ms: round1(p95),
    minMs: round1(ttfts[0] ?? Number.NaN),
    maxMs: round1(ttfts[ttfts.length - 1] ?? Number.NaN),
    tokensPerSecond: genMs > 0 ? round1((deltas / genMs) * 1000) : 0,
    limitMs,
    pass: ttfts.length > 0 && p50 < limitMs && p95 < limitMs,
  };
}
