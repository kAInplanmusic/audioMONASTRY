/**
 * audioMONASTRY · Stem-Nutzungszähler (plattformneutral)
 * =======================================================
 * Zählt Stem-Extraktionen und schätzt die Kosten je nach Provider.
 * Ehrliche Schätzung (keine Abrechnungsgarantie): Replicate-Preise sind
 * Durchschnittswerte inkl. Kaltstart-Overhead, lokal = 0.
 */

export type StemProvider = 'local' | 'stem-ai' | 'replicate' | 'fallback';

export interface StemUsageRecord {
  /** Anzahl Extraktionen insgesamt. */
  count: number;
  /** Geschätzte Gesamtkosten in USD (nur Cloud-Provider). */
  estimatedCostUsd: number;
  /** Letzter Provider. */
  lastProvider: StemProvider | null;
  /** Letzte Extraktion (Unix-ms). */
  lastAt: number | null;
}

const STORAGE_KEY = 'audiomonastry_stem_usage';

/**
 * Geschätzte Kosten pro Song in USD (Stand 2026, inkl. Kaltstart-Overhead).
 * Quelle: Replicate-Modellseiten + Produktions-Messungen (aistemsplitter.org).
 */
export const STEM_COST_ESTIMATES: Record<StemProvider, number> = {
  local: 0,
  'stem-ai': 0,
  replicate: 0.05,
  fallback: 0,
};

export function estimateStemCost(provider: StemProvider): number {
  return STEM_COST_ESTIMATES[provider] ?? 0;
}

export function emptyUsage(): StemUsageRecord {
  return { count: 0, estimatedCostUsd: 0, lastProvider: null, lastAt: null };
}

/** Liest den Zähler (localStorage-Fallback für Node/SSR). */
export function loadStemUsage(): StemUsageRecord {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<StemUsageRecord>;
      return {
        count: Number(parsed.count) || 0,
        estimatedCostUsd: Number(parsed.estimatedCostUsd) || 0,
        lastProvider: (parsed.lastProvider as StemProvider) ?? null,
        lastAt: Number(parsed.lastAt) || null,
      };
    }
  } catch { /* Fallback unten */ }
  return emptyUsage();
}

/** Erhöht den Zähler um eine Extraktion und persistiert. */
export function recordStemExtraction(provider: StemProvider, now = Date.now()): StemUsageRecord {
  const current = loadStemUsage();
  const next: StemUsageRecord = {
    count: current.count + 1,
    estimatedCostUsd: current.estimatedCostUsd + estimateStemCost(provider),
    lastProvider: provider,
    lastAt: now,
  };
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch { /* Persistenz optional */ }
  return next;
}

export function formatUsd(usd: number): string {
  return `$${usd.toFixed(2)}`;
}
