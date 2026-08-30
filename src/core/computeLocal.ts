/**
 * audioMONASTRY · Lokal-Ausführung (Main-Thread-Fallback, Aufg. 2.2.2)
 * -------------------------------------------------------------------
 * Wird genutzt, wenn Web-Worker blockiert sind (CSP etc.). Hält die Job-Logik
 * identisch zum Worker, damit Offline-Berechnungen nie einfach ausfallen.
 */
const LOCAL_HANDLERS: Record<string, (input: any) => unknown> = {
  'reduce': (input: { values: number[]; op?: 'sum' | 'avg' | 'max' }) => {
    const v = input.values ?? [];
    const op = input.op ?? 'sum';
    if (op === 'avg') return v.reduce((a, b) => a + b, 0) / (v.length || 1);
    if (op === 'max') return v.length ? Math.max(...v) : 0;
    return v.reduce((a, b) => a + b, 0);
  },
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

export async function computeLocal(task: string, input: unknown): Promise<unknown> {
  const fn = LOCAL_HANDLERS[task];
  if (!fn) throw new Error(`Unbekannter Task (lokal): ${task}`);
  return await fn(input);
}
