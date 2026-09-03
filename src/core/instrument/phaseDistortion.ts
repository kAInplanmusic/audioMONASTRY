/**
 * audioMONASTRY · Phase-Distortion-Oszillator (Nakst/Casio-CZ-Referenz)
 * ======================================================================
 * Eigener PD-Kern: Piecewise-linear Reshaping der Phase (Casio-CZ-Prinzip),
 * danach Cosinus. `amount` = Verzerrungsgrad 0..1 (0 = reiner Sinus).
 * Kein Fremdcode; deterministisch und serverlos testbar.
 */

export function czPhaseDistortion(phase01: number, amount: number): number {
  const p = Math.max(0, Math.min(1, phase01));
  if (amount <= 0) return Math.cos(2 * Math.PI * p);
  const a = Math.min(0.999, amount);
  const reshaped = p < a
    ? (p / a) * 0.5
    : 0.5 + ((p - a) / (1 - a)) * 0.5;
  return Math.cos(2 * Math.PI * reshaped);
}
