/**
 * audioMONASTRY · DSP-Benchmark (AM-E6-3)
 * ========================================
 * Misst Filter-/Mathe-Kernoperationen, um Optimierungsentscheidungen
 * (LUT vs. Math.*, Direct-Form-Filter, Block-Verarbeitung) mit Zahlen zu
 * belegen. Ausführen mit: `npx tsx scripts/dsp-benchmark.ts`.
 *
 * Keine Audio-Hardware nötig – reine CPU-Mikrobenchmarks.
 */

const N = 1_000_000;

function bench(label: string, fn: () => void): number {
  const start = performance.now();
  fn();
  const ms = performance.now() - start;
  console.log(`${label.padEnd(52)} ${ms.toFixed(1)} ms`);
  return ms;
}

function main(): void {
  console.log(`DSP-Benchmark (${N} Iterationen je Kern)\n`);

  const gain = new Float32Array(N);
  const db = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    gain[i] = Math.random();
    db[i] = (Math.random() - 0.5) * 120;
  }

  // 1) Gain-Konversion: Math.pow vs. Lookup-Table
  const LUT_SIZE = 1200;
  const grLut = new Float32Array(LUT_SIZE);
  for (let i = 0; i < LUT_SIZE; i++) {
    const d = -60 + (i * 60) / (LUT_SIZE - 1);
    grLut[i] = Math.pow(10, -d / 20);
  }
  let sink = 0;
  bench('Math.pow(10, -db/20) pro Sample', () => {
    for (let i = 0; i < N; i++) sink += Math.pow(10, -db[i] / 20);
  });
  bench('LUT (1200 Einträge, 0.05 dB-Schritte)', () => {
    for (let i = 0; i < N; i++) {
      const idx = Math.max(0, Math.min(LUT_SIZE - 1, Math.round(((db[i] + 60) / 60) * (LUT_SIZE - 1))));
      sink += grLut[idx];
    }
  });

  // 2) Peak-Konversion: Math.log10 vs. LUT
  const PEAK_LUT_SIZE = 8192;
  const peakDbLut = new Float32Array(PEAK_LUT_SIZE);
  for (let i = 0; i < PEAK_LUT_SIZE; i++) {
    const a = i / (PEAK_LUT_SIZE - 1);
    peakDbLut[i] = 20 * Math.log10(Math.max(a, 1e-8));
  }
  bench('20*Math.log10(peak) pro Sample', () => {
    for (let i = 0; i < N; i++) sink += 20 * Math.log10(Math.max(gain[i], 1e-8));
  });
  bench('Peak-dB LUT (8192 Einträge)', () => {
    for (let i = 0; i < N; i++) {
      const idx = Math.max(0, Math.min(PEAK_LUT_SIZE - 1, (gain[i] * (PEAK_LUT_SIZE - 1)) | 0));
      sink += peakDbLut[idx];
    }
  });

  // 3) Biquad Direct-Form I (Referenzstruktur) – pro Sample
  let b0 = 0.0495, b1 = 0.099, b2 = 0.0495, a1 = -1.2796, a2 = 0.4776;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  bench('Biquad DF1 (5 Mul/4 Add pro Sample)', () => {
    for (let i = 0; i < N; i++) {
      const x = gain[i];
      const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = x; y2 = y1; y1 = y;
      sink += y;
    }
  });

  // 4) Block-Verarbeitung (128 Samples, identische Operation, bessere V8-Vektorisierung)
  let bx1 = 0, bx2 = 0, by1 = 0, by2 = 0;
  bench('Biquad DF1 im 128er-Block', () => {
    for (let o = 0; o < N; o += 128) {
      for (let i = o; i < o + 128 && i < N; i++) {
        const x = gain[i];
        const y = b0 * x + b1 * bx1 + b2 * bx2 - a1 * by1 - a2 * by2;
        bx2 = bx1; bx1 = x; by2 = by1; by1 = y;
        sink += y;
      }
    }
  });

  console.log('\n(Hinweis: sink =', sink.toFixed(3), '– verhindert Dead-Code-Elimination)');
}

main();
