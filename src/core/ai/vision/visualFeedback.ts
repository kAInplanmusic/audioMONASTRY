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

// ---------------------------------------------------------------------------
// RAG: bestbewertete Stile als Prompt-Vorschlag (Datenquelle: die SQL-View
// `visual_style_ranking`, Migration 008)
// ---------------------------------------------------------------------------

/** Eine Zeile des Stil-Rankings (camelCase, wie es der Rest der App nutzt). */
export interface StyleRankingRow {
  style?: string | null;
  generations?: number | null;
  avgRating?: number | null;
  feedbackCount?: number | null;
}

function toCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function toRating(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.min(5, n) : 0;
}

/**
 * Rohzeilen der View (`style`, `generations`, `avg_rating`, `feedback_count`)
 * auf camelCase bringen und Zahlen klemmen. Unbekannte Formen werden verworfen
 * statt sie zu raten.
 */
export function normalizeStyleRanking(rows: ReadonlyArray<Record<string, unknown>>): StyleRankingRow[] {
  const out: StyleRankingRow[] = [];
  for (const row of rows) {
    const style = String(row?.style ?? '').trim();
    if (!style) continue;
    out.push({
      style,
      generations: toCount(row.generations),
      avgRating: toRating(row.avg_rating ?? row.avgRating),
      feedbackCount: toCount(row.feedback_count ?? row.feedbackCount),
    });
  }
  return out;
}

export interface StyleSuggestion {
  style: string;
  /** `ranking` = aus echten Bewertungen, `fallback` = deterministisch aus Energie/Tempo. */
  source: 'ranking' | 'fallback';
  /** Kurzbegründung für die UI (keine Zahlen erfinden). */
  reason: string;
  /** 0..1 – Belastbarkeit (Bewertung × Stichprobengröße). */
  confidence: number;
}

/**
 * Wählt den Stil für die nächste Generierung: den bestbewerteten Stil aus dem
 * Ranking, sonst den deterministischen Vorschlag aus Energie/Tempo. Es wird
 * **nichts erfunden** — ohne Bewertungen ist die Quelle ehrlich `fallback`.
 */
export function suggestStyleFromRanking(
  rows: readonly StyleRankingRow[],
  hint: { energy?: number; bpm?: number },
  opts: { minFeedback?: number; minRating?: number } = {},
): StyleSuggestion {
  const minFeedback = opts.minFeedback ?? 2;
  const minRating = opts.minRating ?? 3.5;

  const usable = rows
    .filter((r) => Boolean(r.style) && (r.feedbackCount ?? 0) >= minFeedback && (r.avgRating ?? 0) >= minRating)
    .sort((a, b) => (b.avgRating ?? 0) - (a.avgRating ?? 0) || (b.feedbackCount ?? 0) - (a.feedbackCount ?? 0));

  const best = usable[0];
  if (best?.style) {
    const rating = best.avgRating ?? 0;
    const count = best.feedbackCount ?? 0;
    const confidence = Number(Math.min(1, (rating / 5) * Math.min(1, count / 5)).toFixed(2));
    return {
      style: best.style,
      source: 'ranking',
      reason: `bestbewertet: Ø ${rating.toFixed(1)} aus ${count} Bewertung${count === 1 ? '' : 'en'}`,
      confidence,
    };
  }

  return {
    style: fallbackStyle(hint),
    source: 'fallback',
    reason: 'noch keine Bewertungen – Vorschlag aus Energie und Tempo',
    confidence: 0.25,
  };
}

/** Deterministischer Ersatz, wenn das Ranking (noch) keine Bewertungen hat. */
function fallbackStyle(hint: { energy?: number; bpm?: number }): string {
  const energy = Math.min(1, Math.max(0, Number.isFinite(hint.energy) ? Number(hint.energy) : 0.4));
  const bpm = Number.isFinite(hint.bpm) ? Number(hint.bpm) : 0;
  if (energy >= 0.75) return bpm >= 140 ? 'industrial' : 'fire';
  if (energy >= 0.45) return bpm >= 120 ? 'psychedelic' : 'cosmic';
  if (energy >= 0.2) return bpm >= 120 ? 'geometry' : 'liquid';
  return 'abstract';
}
