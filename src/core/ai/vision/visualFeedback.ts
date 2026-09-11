/**
 * audioMONASTRY · VisualMONK – Selbstlern-Loop (reine Logik)
 * ==========================================================
 * Bewertungen der Session-Ende-Umfrage normalisieren und auswerten. Bewusst
 * rein (keine DB/Netz), damit die Auswertung testbar ist.
 */

export interface VisualFeedbackEntry {
  /** Generierung, auf die sich die Bewertung bezieht. */
  generationId: string;
  rating: number;
  /** Soll dieses Visual behalten/trainiert werden? */
  keep?: boolean;
  tags?: readonly string[];
}

/** Bewertung auf 1..5 (ganzzahlig) normalisieren; ungueltig -> null. */
export function normalizeRating(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n);
  if (rounded < 1 || rounded > 5) return null;
  return rounded;
}

/** Tags bereinigen (trim, dedupe, max 8, je max 40 Zeichen). */
export function normalizeTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  const out: string[] = [];
  for (const t of tags) {
    const v = String(t ?? '').trim().slice(0, 40);
    if (v && !out.includes(v)) out.push(v);
    if (out.length >= 8) break;
  }
  return out;
}

export interface FeedbackAggregate {
  count: number;
  avgRating: number;
  keepRatio: number;
}

/** Kennzahlen einer Feedback-Liste (nur gueltige Bewertungen zaehlen). */
export function aggregateFeedback(entries: readonly VisualFeedbackEntry[]): FeedbackAggregate {
  const valid = entries.map((e) => normalizeRating(e.rating)).filter((r): r is number => r !== null);
  if (valid.length === 0) return { count: 0, avgRating: 0, keepRatio: 0 };
  const sum = valid.reduce((a, b) => a + b, 0);
  const kept = entries.filter((e) => normalizeRating(e.rating) !== null && e.keep !== false).length;
  return {
    count: valid.length,
    avgRating: Number((sum / valid.length).toFixed(2)),
    keepRatio: Number((kept / valid.length).toFixed(2)),
  };
}

/**
 * Waehlt die Stile mit dem besten Durchschnitt aus einer Ranking-Liste
 * (z. B. `visual_style_ranking`): nur Stile mit genug Feedback, sortiert.
 */
export function topStyles(
  rows: ReadonlyArray<{ style?: string | null; avgRating?: number | null; feedbackCount?: number | null }>,
  opts: { minFeedback?: number; limit?: number } = {},
): string[] {
  const minFeedback = opts.minFeedback ?? 2;
  const limit = opts.limit ?? 3;
  return rows
    .filter((r) => Boolean(r.style) && (r.feedbackCount ?? 0) >= minFeedback && (r.avgRating ?? 0) > 0)
    .sort((a, b) => (b.avgRating ?? 0) - (a.avgRating ?? 0))
    .slice(0, limit)
    .map((r) => String(r.style));
}
