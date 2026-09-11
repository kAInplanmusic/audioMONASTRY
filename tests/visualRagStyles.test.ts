import { describe, expect, it } from 'vitest';
import {
  normalizeStyleRanking,
  suggestStyleFromRanking,
  topStyles,
} from '../src/core/ai/vision/visualFeedback';
import { AiVisionStylesQuerySchema } from '../src/types/zod/schemas';

describe('VisualMONK RAG – View-Zeilen normalisieren', () => {
  it('mappt snake_case der SQL-View auf camelCase', () => {
    // So liefert `visual_style_ranking` (Migration 008) wirklich:
    const rows = normalizeStyleRanking([
      { style: 'cosmic', generations: 7, avg_rating: 4.67, feedback_count: 3 },
    ]);
    expect(rows[0]).toEqual({ style: 'cosmic', generations: 7, avgRating: 4.67, feedbackCount: 3 });
  });

  it('verwirft Zeilen ohne Stil und klemmt unsinnige Zahlen', () => {
    const rows = normalizeStyleRanking([
      { style: '   ', avg_rating: 5, feedback_count: 2 },
      { style: 'noir', avg_rating: 9.5, feedback_count: -3 },
      { style: 'fire', avg_rating: 'keine-zahl', feedback_count: null },
    ]);
    expect(rows.map((r) => r.style)).toEqual(['noir', 'fire']);
    expect(rows[0]).toMatchObject({ avgRating: 5, feedbackCount: 0 });
    expect(rows[1]).toMatchObject({ avgRating: 0, feedbackCount: 0 });
  });
});

describe('VisualMONK RAG – Stilvorschlag', () => {
  it('nimmt den bestbewerteten Stil, wenn genug Bewertungen vorliegen', () => {
    const rows = normalizeStyleRanking([
      { style: 'noir', avg_rating: 3.6, feedback_count: 5 },
      { style: 'cosmic', avg_rating: 4.8, feedback_count: 4 },
      { style: 'fire', avg_rating: 4.9, feedback_count: 1 },
    ]);
    const s = suggestStyleFromRanking(rows, { energy: 0.9, bpm: 150 });
    expect(s.source).toBe('ranking');
    expect(s.style).toBe('cosmic');
    expect(s.reason).toContain('4');      // nennt die Bewertung
    expect(s.confidence).toBeGreaterThan(0.5);
    expect(s.confidence).toBeLessThanOrEqual(1);
  });

  it('ignoriert Stile mit zu wenig Feedback oder zu schlechter Bewertung', () => {
    const rows = normalizeStyleRanking([
      { style: 'fire', avg_rating: 4.9, feedback_count: 1 },  // zu wenig Feedback
      { style: 'noir', avg_rating: 2.1, feedback_count: 9 },  // zu schlecht bewertet
    ]);
    const s = suggestStyleFromRanking(rows, { energy: 0.9, bpm: 150 });
    expect(s.source).toBe('fallback');
    expect(s.style).toBe('industrial'); // Energie 0.9 + BPM 150 → Heuristik
    expect(s.confidence).toBeLessThan(0.5);
  });

  it('fällt ohne jede Bewertung ehrlich auf die Heuristik zurück', () => {
    expect(suggestStyleFromRanking([], { energy: 0.1, bpm: 90 }).style).toBe('abstract');
    expect(suggestStyleFromRanking([], { energy: 0.5, bpm: 128 }).style).toBe('psychedelic');
    expect(suggestStyleFromRanking([], {}).source).toBe('fallback');
  });

  it('nutzt bei gleicher Bewertung die größere Stichprobe', () => {
    const rows = normalizeStyleRanking([
      { style: 'liquid', avg_rating: 4.5, feedback_count: 2 },
      { style: 'geometry', avg_rating: 4.5, feedback_count: 7 },
    ]);
    expect(suggestStyleFromRanking(rows, { energy: 0.3, bpm: 100 }).style).toBe('geometry');
  });

  it('passt zu topStyles (gleiche Datenbasis, andere Ausgabe)', () => {
    const rows = normalizeStyleRanking([
      { style: 'cosmic', avg_rating: 4.8, feedback_count: 4 },
      { style: 'noir', avg_rating: 4.1, feedback_count: 3 },
      { style: 'fire', avg_rating: 5, feedback_count: 1 },
    ]);
    expect(topStyles(rows, { minFeedback: 2, limit: 2 })).toEqual(['cosmic', 'noir']);
  });
});

describe('VisualMONK RAG – Query-Validierung', () => {
  it('nimmt Zahlen aus Query-Strings an und klemmt die Grenzen', () => {
    const ok = AiVisionStylesQuerySchema.safeParse({ energy: '0.75', bpm: '150', limit: '5' });
    expect(ok.success).toBe(true);
    if (ok.success) {
      expect(ok.data).toEqual({ energy: 0.75, bpm: 150, limit: 5 });
    }
    expect(AiVisionStylesQuerySchema.safeParse({ energy: '2' }).success).toBe(false);
    expect(AiVisionStylesQuerySchema.safeParse({ bpm: '10' }).success).toBe(false);
    expect(AiVisionStylesQuerySchema.safeParse({ limit: '999' }).success).toBe(false);
    expect(AiVisionStylesQuerySchema.safeParse({}).success).toBe(true);
  });
});
