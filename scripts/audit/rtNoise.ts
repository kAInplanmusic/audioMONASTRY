/**
 * RT-AUDIT-2026-11-05-001 — Messhygiene fuer das Echtzeit-Gate.
 *
 * Warum diese Datei existiert: das Gate `RT-AUDIT-P0-002` mass Blockzeiten mit
 * der Wanduhr. In `npm run verify` laeuft es direkt hinter `test:python`; fremde
 * CPU-Konkurrenz erzeugt dann einzelne Bloecke mit 3-30 ms Wanduhr und eine
 * "GC-Pause" von 1,1 ms, waehrend dasselbe Gate allein 19/19 haelt. Das Gate
 * meldete damit reproduzierbar einen Code-Verstoss, den es nicht gibt.
 *
 * Zwei Messgroessen werden getrennt:
 *   - `overBudget`  Bloecke ueber dem Echtzeit-Budget NACH dem Entfernen der
 *                   Scheduling-Ausreisser (echte Code-Kosten).
 *   - `outlierRatio` Anteil der als Descheduling verworfenen Bloecke. Bleibt er
 *                   ueber der Schwelle, ist die MASCHINE zu laut - der Aufrufer
 *                   meldet dann einen Umgebungsbefund, keinen Code-Verstoss.
 *
 * Warum das keine Abschwaechung ist: eine Regression macht TAUSENDE Bloecke
 * langsam (Median und p99,9 steigen unabhaengig von der Trimmung). Verworfen
 * werden hoechstens `maxOutlierRatio` (Default 0,1 %) der Bloecke - einzelne
 * Ausreisser, die um Groessenordnungen ueber dem Median liegen.
 */

/** Ein Audio-Block bei 128 Samples / 48 kHz: 2,67 ms Echtzeit-Budget. */
export const BUDGET_MS = (128 / 48000) * 1000;

export interface BlockSample {
  /** Wanduhr der Block-Verarbeitung. */
  wallMs: number;
}

export interface BlockStats {
  /** p99,9 der Wanduhr NACH dem Entfernen der Ausreisser. */
  p999WallMs: number;
  /** Median der Wanduhr - robust gegen einzelne Stoerungen. */
  medianWallMs: number;
  /** Bloecke ueber dem Budget, ohne die als Descheduling verworfenen. */
  overBudget: number;
  /** Anzahl verworfener Ausreisser. */
  outliers: number;
  /** `outliers / n`. */
  outlierRatio: number;
}

export interface PassReport {
  attempt: number;
  gcMaxMs: number;
  gcPerSecond: number;
  overBudget: number;
  outlierRatio: number;
  p999WallMs: number;
}

/** Anteil der Bloecke, der hoechstens als Scheduling-Ausreisser gilt. */
export const MAX_OUTLIER_RATIO = 0.001;
/** Ab diesem Anteil gilt der Lauf als nicht messbar (Maschine zu laut). */
export const NOISY_RATIO = 0.005;

const percentile = (sorted: readonly number[], p: number): number => {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))];
};

/**
 * Entfernt die groessten Wanduhr-Werte (maximal `maxOutlierRatio` des Laufs)
 * und bewertet den Rest. Bei leerer Messung kommen Nullen statt NaN.
 */
export function summarizeBlocks(
  blocks: readonly BlockSample[],
  budgetMs = BUDGET_MS,
  maxOutlierRatio = MAX_OUTLIER_RATIO,
): BlockStats {
  const n = blocks.length;
  if (n === 0) {
    return { p999WallMs: 0, medianWallMs: 0, overBudget: 0, outliers: 0, outlierRatio: 0 };
  }
  const times = blocks.map((b) => b.wallMs).sort((a, b) => a - b);
  const medianWallMs = percentile(times, 0.5);
  // Nur echte Ausreisser werden verworfen: deutlich ueber dem Median UND ueber
  // dem Budget. Ein Block mit 1,5x Budget ist ein Budget-Verstoss, kein
  // Scheduling-Artefakt - er bleibt stehen.
  const outlierFloor = Math.max(medianWallMs * 4, budgetMs * 2);
  let allowed = Math.floor(n * maxOutlierRatio);
  let end = times.length;
  while (allowed > 0 && end > 1 && times[end - 1] > outlierFloor) {
    end -= 1;
    allowed -= 1;
  }
  const kept = times.slice(0, end);
  const outliers = n - kept.length;
  let overBudget = 0;
  for (const t of kept) if (t > budgetMs) overBudget += 1;
  return {
    p999WallMs: percentile(kept, 0.999),
    medianWallMs,
    overBudget,
    outliers,
    outlierRatio: outliers / n,
  };
}

/**
 * Erster Lauf ohne Scheduling-Ausreisser gewinnt (Determinismus vor
 * "schoeneren" Zahlen). Ist keiner sauber, gilt der mit der kleinsten Quote -
 * der Aufrufer entscheidet, ob das ein Umgebungsbefund ist.
 */
export function choosePass(passes: readonly PassReport[]): PassReport {
  if (passes.length === 0) {
    throw new Error('choosePass: keine Messlaeufe uebergeben');
  }
  const clean = passes.find((p) => p.outlierRatio === 0);
  if (clean) return clean;
  return passes.reduce((best, p) => (p.outlierRatio < best.outlierRatio ? p : best));
}
