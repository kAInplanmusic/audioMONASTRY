/**
 * audioMONASTRY · Aliasing-Messung fuer Saettiger (DSP-P1-OVS-001)
 * ================================================================
 * Gemeinsame Messung fuer Tests und `scripts/audit/rt-bench.ts` (Gate).
 *
 * Verfahren: kohaerente Abtastung. Der Testsinus liegt exakt auf DFT-Bin
 * `ALIAS_TEST_BIN` einer `ALIAS_TEST_N`-Punkte-Analyse (bei 48 kHz:
 * 19 001,95 Hz ≈ 0,396·Fs, also „nahe 0,4·Fs"). Damit liegen Grundton UND alle
 * zurueckgefalteten Oberwellen (n·k mod N) exakt auf Bins – kein Leck, kein
 * Fenster noetig. Da schon die 2. Oberwelle ueber Nyquist liegt, ist ALLES
 * ausser dem Grundton (und DC) Aliasing bzw. Filterrest.
 *
 * Ergebnis: Alias-Energie relativ zum Grundton in dB (negativ = besser).
 * Nur Entwurfs-/Messcode, nicht im Render-Pfad.
 */

/** Analyse-Laenge (Zweierpotenz nicht noetig, die DFT laeuft nur auf einem Bin). */
export const ALIAS_TEST_N = 8192;
/** DFT-Bin des Testsinus (teilerfremd zu N, damit sich Oberwellen nicht stapeln). */
export const ALIAS_TEST_BIN = 3243;

/** Frequenz des Testsinus bei gegebener Sample-Rate (≈ 0,396·Fs). */
export function aliasTestFrequency(sampleRate: number): number {
  return (ALIAS_TEST_BIN * sampleRate) / ALIAS_TEST_N;
}

/** Testsinus-Probe Nummer `i` (kohaerent, Amplitude `amp`). */
export function aliasTestSample(i: number, amp: number): number {
  return amp * Math.sin((2 * Math.PI * ALIAS_TEST_BIN * (i % ALIAS_TEST_N)) / ALIAS_TEST_N);
}

/**
 * Alias-zu-Signal-Verhaeltnis in dB eines eingeschwungenen Ausschnitts der
 * Laenge `ALIAS_TEST_N`: (Gesamtenergie − DC − Grundton) / Grundton.
 */
export function aliasToSignalDb(out: ArrayLike<number>): number {
  const n = ALIAS_TEST_N;
  if (out.length < n) throw new Error(`aliasToSignalDb: ${n} Proben noetig (war ${out.length})`);
  let total = 0;
  let mean = 0;
  for (let i = 0; i < n; i++) { total += out[i] * out[i]; mean += out[i]; }
  mean /= n;
  total /= n;
  let re = 0;
  let im = 0;
  for (let i = 0; i < n; i++) {
    const ph = (2 * Math.PI * ALIAS_TEST_BIN * i) / n;
    re += out[i] * Math.cos(ph);
    im -= out[i] * Math.sin(ph);
  }
  const amp = (2 * Math.hypot(re, im)) / n;
  const signal = (amp * amp) / 2;
  const residual = Math.max(1e-30, total - mean * mean - signal);
  return 10 * Math.log10(residual / Math.max(1e-30, signal));
}
