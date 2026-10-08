/**
 * audioMONASTRY · True-Peak (ITU-R BS.1770-4, Annex 2)
 * ====================================================
 * 4×-Oversampling per Interpolations-FIR (4 Phasen à 12 Taps). Ein Detektor
 * hält die Historie der letzten 12 Samples und liefert für jedes Eingangs-
 * Sample den maximalen True-Peak über die vier Zwischenphasen.
 *
 * Die Koeffizienten sind identisch zum Limiter in `masteringDynamics.ts`
 * (dort importiert) – eine Quelle, keine zweite Kopie.
 */

export const TRUE_PEAK_TAPS = 12;
export const TRUE_PEAK_PHASES = 4;

/**
 * Interpolations-FIR für 4×-Oversampling, 48 Taps in 4 Phasen à 12
 * (Tap k gewichtet x[n−k]).
 */
export const TRUE_PEAK_COEFFS = new Float64Array([
  // Phase 0
  0.0017089843750, 0.0109863281250, -0.0196533203125, 0.0332031250000,
  -0.0594482421875, 0.1373291015625, 0.9721679687500, -0.1022949218750,
  0.0476074218750, -0.0266113281250, 0.0148925781250, -0.0083007812500,
  // Phase 1
  -0.0291748046875, 0.0292968750000, -0.0517578125000, 0.0891113281250,
  -0.1665039062500, 0.4650878906250, 0.7797851562500, -0.2003173828125,
  0.1015625000000, -0.0582275390625, 0.0330810546875, -0.0189208984375,
  // Phase 2
  -0.0189208984375, 0.0330810546875, -0.0582275390625, 0.1015625000000,
  -0.2003173828125, 0.7797851562500, 0.4650878906250, -0.1665039062500,
  0.0891113281250, -0.0517578125000, 0.0292968750000, -0.0291748046875,
  // Phase 3
  -0.0083007812500, 0.0148925781250, -0.0266113281250, 0.0476074218750,
  -0.1022949218750, 0.9721679687500, 0.1373291015625, -0.0594482421875,
  0.0332031250000, -0.0196533203125, 0.0109863281250, 0.0017089843750,
]);

/**
 * Obere Schranke der FIR-Verstärkung: max über die Phasen von Σ|h| (≈ 2,02).
 * Ist max|y| der letzten 12 Samples · TRUE_PEAK_ABS_GAIN ≤ ceiling, kann keine
 * Phase das Ceiling überschreiten (Dreiecksungleichung) – die FIR entfällt
 * dann exakt ohne Genauigkeitsverlust.
 */
export const TRUE_PEAK_ABS_GAIN = ((): number => {
  let max = 0;
  for (let p = 0; p < TRUE_PEAK_PHASES; p++) {
    let sum = 0;
    for (let k = 0; k < TRUE_PEAK_TAPS; k++) sum += Math.abs(TRUE_PEAK_COEFFS[p * TRUE_PEAK_TAPS + k]);
    if (sum > max) max = sum;
  }
  return max;
})();

/**
 * Zustandsbehafteter True-Peak-Detektor je Kanal. `push()` ist allokationsfrei
 * und liefert den True-Peak des aktuellen Frames (Maximum der 4 Phasen).
 */
export class TruePeakDetector {
  /** Doppelt abgelegte Historie (2·TAPS) → kein Modulo pro Tap. */
  private readonly hist = new Float64Array(2 * TRUE_PEAK_TAPS);
  private pos = 0;

  reset(): void {
    this.hist.fill(0);
    this.pos = 0;
  }

  /** Speist ein Sample ein und liefert max|y| über die 4 Oversampling-Phasen. */
  push(x: number): number {
    const h = this.hist;
    const n = TRUE_PEAK_TAPS;
    const p = this.pos;
    h[p] = x;
    h[p + n] = x;
    const base = p + n;
    let peak = 0;
    for (let ph = 0; ph < TRUE_PEAK_PHASES; ph++) {
      const off = ph * n;
      let acc = 0;
      for (let k = 0; k < n; k++) acc += TRUE_PEAK_COEFFS[off + k] * h[base - k];
      const a = acc < 0 ? -acc : acc;
      if (a > peak) peak = a;
    }
    this.pos = (p + 1) % n;
    return peak;
  }
}
