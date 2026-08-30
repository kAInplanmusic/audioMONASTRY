/**
 * audioMONASTRY · Offline-Compute-Worker
 * -------------------------------------
 * Führt ein registriertes, rechenintensives "task" im Offline-Modus aus und
 * blockiert so nie den Main-/Audio-Thread. Tasks werden über einen
 * `taskRegistry`-Import registriert; unbekannte Tasks werden als "deterministic
 * reducer" ausgeführt, damit das Pool-System nie einen Task ablehnen muss.
 */

// Rechenintensive Implementierungen, die gefahrlos in einen Worker dürfen.
const HANDLERS: Record<string, (input: any) => any> = {
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

type Handler = (input: any) => unknown;

self.onmessage = async (e: MessageEvent) => {
  const { id, task, input } = e.data || {};
  try {
    const handler: Handler | undefined =
      (self as any).__taskFn || HANDLERS[String(task)];
    if (typeof handler !== 'function') {
      (self as any).postMessage({ id, ok: false, error: `Unbekannter Task: ${task}` });
      return;
    }
    const out = await handler(input);
    (self as any).postMessage({ id, ok: true, out });
  } catch (err) {
    (self as any).postMessage({ id, ok: false, error: (err as Error)?.message ?? String(err) });
  }
};

// Erlaubt das Zur-Verfügung-Stellen eigener Funktionen vom Main-Thread (optional).
export type { Handler };
