/**
 * audioMONASTRY · V2-Gain-Umrechnung (dB → linear)
 * ================================================
 * Kanal-/Master-Gain der V2-Graphen: dB → linearer Wert, geklemmt auf
 * [-120 dB, +24 dB]. `<= -120 dB` bedeutet Stille (0), `+24 dB` ist die
 * Obergrenze. `V2StudioGraph` und `V2MonitorGraph` nutzen dieselbe Umrechnung -
 * sie liegt deshalb genau einmal hier.
 *
 * Nicht zu verwechseln mit `dbToLinear` in `GraphStateBridge`: dort wird bewusst
 * NICHT geklemmt, weil nur ein serialisierter Zustand eingelesen wird.
 */
export function v2GainDbToLinear(db: number): number {
  if (db <= -120) return 0;
  return Math.pow(10, Math.max(-120, Math.min(24, db)) / 20);
}
