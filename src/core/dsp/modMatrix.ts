/**
 * audioMONASTRY · Modulations-Matrix (FEAT-P3-001)
 * ===============================================
 * Reiner Routing-Kern: Modulationsquellen (LFO, Envelope, Audio-Feature, MIDI-CC)
 * werden auf Ziele (Parameter) gemappt, mit Tiefe und Polarität, und pro Ziel
 * **summiert**. Bewusst ohne Audio-Kontext und ohne DOM — damit ist die Logik
 * vollständig testbar, und die Engine entscheidet nur noch, was sie mit dem
 * Ergebnis anstellt.
 *
 * Regeln (ehrlich statt still):
 *   * Unbekannte Quelle → Route wird **übersprungen** und im Ergebnis gemeldet
 *     (kein stiller Null-Beitrag, der wie „funktioniert" aussieht).
 *   * `depth` außerhalb −1..1 wird geklemmt; NaN/Infinity → 0 (Route zählt nicht).
 *   * `bipolar` bildet eine 0..1-Quelle auf −1..1 ab (2v−1), `unipolar` 0..1.
 *   * Das Ergebnis je Ziel wird auf `clampMin..clampMax` (Default −1..1) begrenzt.
 */

export type ModPolarity = 'unipolar' | 'bipolar';

export interface ModRoute {
  id: string;
  /** Quelle, z. B. `lfo1`, `env.amp`, `feature.energy`, `cc21`. */
  source: string;
  /** Ziel, z. B. `eq.low`, `dsp.cutoff`, `mixer.channel3.volume`. */
  destination: string;
  /** Modulationstiefe −1..1 (Vorzeichen = Richtung). */
  depth: number;
  polarity?: ModPolarity;
  enabled?: boolean;
}

export interface ModMatrixOptions {
  clampMin?: number;
  clampMax?: number;
}

export interface ModMatrixResult {
  /** Ziel → summierter, geklemmter Wert. */
  values: Record<string, number>;
  /** Anzahl tatsächlich wirksamer Routen. */
  applied: number;
  /** IDs übersprungener Routen (deaktiviert, unbekannte Quelle, ungültige Tiefe). */
  skipped: string[];
}

const finite = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

/** Wendet die Matrix an. Reine Funktion, keine Nebenwirkungen. */
export function applyModMatrix(
  routes: readonly ModRoute[],
  sources: Readonly<Record<string, number>>,
  opts: ModMatrixOptions = {},
): ModMatrixResult {
  const min = finite(opts.clampMin, -1);
  const max = finite(opts.clampMax, 1);
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);

  const values: Record<string, number> = {};
  const skipped: string[] = [];
  let applied = 0;

  for (const route of routes) {
    if (!route || route.enabled === false) {
      if (route?.id) skipped.push(route.id);
      continue;
    }
    const rawSource = sources?.[route.source];
    if (typeof rawSource !== 'number' || !Number.isFinite(rawSource)) {
      skipped.push(route.id);
      continue;
    }
    const depth = finite(route.depth, Number.NaN);
    if (!Number.isFinite(depth) || depth === 0) {
      skipped.push(route.id);
      continue;
    }
    const clampedDepth = Math.max(-1, Math.min(1, depth));
    const shaped = route.polarity === 'bipolar' ? rawSource * 2 - 1 : rawSource;
    const contribution = shaped * clampedDepth;
    values[route.destination] = (values[route.destination] ?? 0) + contribution;
    applied += 1;
  }

  for (const [destination, value] of Object.entries(values)) {
    values[destination] = Math.max(lo, Math.min(hi, Number.isFinite(value) ? value : 0));
  }

  return { values, applied, skipped };
}

/** Wendet die Matrix auf einen Basiswert an (Parameter = Basis + Modulation). */
export function applyModulationToParameters(
  base: Readonly<Record<string, number>>,
  routes: readonly ModRoute[],
  sources: Readonly<Record<string, number>>,
  opts: ModMatrixOptions = {},
): { parameters: Record<string, number>; applied: number; skipped: string[] } {
  const { values, applied, skipped } = applyModMatrix(routes, sources, opts);
  const parameters: Record<string, number> = { ...base };
  for (const [destination, modulation] of Object.entries(values)) {
    parameters[destination] = finite(parameters[destination], 0) + modulation;
  }
  return { parameters, applied, skipped };
}
