/**
 * audioMONASTRY · Dynamics-Rechenkern (dB ↔ linear, One-Pole, Soft-Knee)
 * ======================================================================
 * Reine Rechenfunktionen ohne Audio-Kontext, DOM oder Worklet-API. Sie werden
 * von ZWEI Seiten gebraucht und lagen deshalb doppelt vor:
 *
 *   * `src/audio/worklets/dynamicsProcessor.ts` – Echtzeit-Insert im Worklet
 *     (der Worklet lädt den Kern wie die übrigen Prozessoren aus `core/`).
 *   * `src/core/audio/nodes/processingNodes.ts` – Dynamics-/Mastering-Node im
 *     V2-Graphen (Offline-Bounce und Realtime teilen denselben Graphen).
 *
 * Die Werte sind bewusst identisch (deterministisch, NaN-sicher); die Datei ist
 * damit die eine Quelle der Kennlinie.
 */

/** Linearwert → dBFS (NaN-sicher, Untergrenze -120 dB). */
export function toDb(linear: number): number {
  const a = Math.abs(linear);
  if (!Number.isFinite(a) || a < 1e-6) return -120;
  return 20 * Math.log10(a);
}

/** dB → Linearfaktor (NaN-sicher). */
export function fromDb(db: number): number {
  if (!Number.isFinite(db)) return 1;
  return Math.pow(10, db / 20);
}

/** One-Pole-Koeffizient für eine Zeitkonstante in Sekunden. */
export function smoothingCoefficient(seconds: number, sampleRate: number): number {
  const n = sampleRate * seconds;
  if (!Number.isFinite(n) || n <= 0) return 1;
  return 1 - Math.exp(-1 / n);
}

/**
 * Statische Kompressor-Kennlinie mit Soft-Knee.
 * @returns Ausgangspegel in dB für einen Eingangspegel in dB.
 */
export function compressorCurveDb(
  inputDb: number,
  threshold: number,
  ratio: number,
  knee: number,
): number {
  const r = Math.max(1, ratio);
  const k = Math.max(0, knee);
  const over = inputDb - threshold;
  if (k > 0 && over > -k / 2 && over < k / 2) {
    // Quadratische Knee-Interpolation (stetig in Wert und Steigung).
    const x = over + k / 2;
    return inputDb + ((1 / r - 1) * x * x) / (2 * k);
  }
  if (over <= 0) return inputDb;
  return threshold + over / r;
}
