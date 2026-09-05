/**
 * audioMONASTRY · Gemeinsame Offline-Compute-Handler
 * --------------------------------------------------
 * D6/Deduplizierung: Die deterministischen Handler werden von
 * `computeLocal.ts` (Main-Thread-Fallback) und `workers/computeWorker.ts`
 * (Web-Worker) gemeinsam genutzt, damit die Job-Logik nicht doppelt gepflegt
 * werden muss.
 */

export type ComputeHandler = (input: any) => unknown;

export const COMPUTE_HANDLERS: Record<string, ComputeHandler> = {
  // Deterministischer Fallback für beliebige JSON-Jobs (Analyse, Aggregation).
  'reduce': (input: { values: number[]; op?: 'sum' | 'avg' | 'max' }) => {
    const v = input.values ?? [];
    const op = input.op ?? 'sum';
    if (op === 'avg') return v.reduce((a, b) => a + b, 0) / (v.length || 1);
    if (op === 'max') return v.length ? Math.max(...v) : 0;
    return v.reduce((a, b) => a + b, 0);
  },

  // Beispiel: simuliert eine schwere Analyseschleife (segmentierte Energie).
  'segment-energy': (input: { samples: number[]; window: number }) => {
    const s = input.samples ?? [];
    const win = Math.max(1, input.window ?? 256);
    const out: number[] = [];
    for (let i = 0; i < s.length; i += win) {
      let e = 0, n = 0;
      for (let k = i; k < i + win && k < s.length; k++) { e += s[k] * s[k]; n++; }
      out.push(n ? Math.sqrt(e / n) : 0);
    }
    return out;
  },
};
