/**
 * audioMONASTRY · Stem-Nutzungszähler (plattformneutral)
 * =======================================================
 * Zählt Stem-Extraktionen je Provider. Seit RT-AUDIT-P1-014 (AI nur lokal)
 * gibt es nur noch eigene Wege (lokal ONNX, stem-ai der Flotte, DSP-Notfall);
 * alle kosten 0 USD. Das Kostenfeld bleibt für Altdaten und Anzeige erhalten.
 */
import { storageGet, storageSet } from './storage';

export type StemProvider = 'local' | 'stem-ai' | 'fallback';

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

/** Kosten pro Song in USD: alle verbliebenen Wege laufen auf eigener Hardware. */
const STEM_COST_ESTIMATES: Record<StemProvider, number> = {
  local: 0,
  'stem-ai': 0,
  fallback: 0,
};

export function estimateStemCost(provider: StemProvider): number {
  return STEM_COST_ESTIMATES[provider] ?? 0;
}

export function emptyUsage(): StemUsageRecord {
  return { count: 0, estimatedCostUsd: 0, lastProvider: null, lastAt: null };
}

/** Liest den Zähler (Storage-Adapter kapselt localStorage inkl. Fallback). */
export function loadStemUsage(): StemUsageRecord {
  try {
    const raw = storageGet(STORAGE_KEY);
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
  storageSet(STORAGE_KEY, JSON.stringify(next));
  return next;
}

export function formatUsd(usd: number): string {
  return `$${usd.toFixed(2)}`;
}
