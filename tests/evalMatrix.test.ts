import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MIN_SCORE,
  EVAL_PLUGIN_IDS,
  PLUGIN_EVAL_MATRIX,
  evalSpecFor,
  gradePluginResult,
  minScoreFor,
  renderEvalReportMarkdown,
} from '../src/core/ai/orchestrator/evalMatrix';

/**
 * P3-3 / GAP-5: Die Eval-Matrix ist das Gate der Nightly-CI.
 * Sie muss alle 20 Plugins abdecken und Score/Dauer/Fehler bewerten.
 */
describe('evalMatrix – Mindest-Score je Plugin (GAP-5)', () => {
  it('deckt genau die 20 Plugins ab', () => {
    expect(EVAL_PLUGIN_IDS).toHaveLength(20);
    expect(new Set(EVAL_PLUGIN_IDS).size).toBe(20);
    expect(Object.keys(PLUGIN_EVAL_MATRIX)).toHaveLength(20);
  });

  it('definiert je Plugin einen Mindest-Score ≥ Default und ein Laufzeit-Budget', () => {
    for (const pluginId of EVAL_PLUGIN_IDS) {
      const spec = evalSpecFor(pluginId);
      expect(spec.minScore).toBeGreaterThanOrEqual(DEFAULT_MIN_SCORE);
      expect(spec.minScore).toBeLessThanOrEqual(5);
      expect(spec.maxDurationMs).toBeGreaterThan(0);
    }
  });

  it('hebt das Gate für audio-kritische Plugins an', () => {
    expect(minScoreFor('mixer')).toBeGreaterThan(minScoreFor('library'));
    expect(minScoreFor('mastering')).toBeGreaterThan(DEFAULT_MIN_SCORE);
  });

  it('fällt für unbekannte Plugin-IDs auf den Default zurück', () => {
    expect(minScoreFor('gibtsnicht')).toBe(DEFAULT_MIN_SCORE);
  });
});

describe('gradePluginResult – Score, Dauer, Fehler', () => {
  it('bewertet einen sauberen Lauf als PASS', () => {
    const result = gradePluginResult({ pluginId: 'drum', score: 5, durationMs: 12.345 });
    expect(result.status).toBe('PASS');
    expect(result.errors).toEqual([]);
    expect(result.durationMs).toBeCloseTo(12.345, 3);
    expect(result.task).toBe('plan');
  });

  it('meldet Score-Abfall als FAIL (Nightly-Gate)', () => {
    const result = gradePluginResult({ pluginId: 'mixer', score: 4.2, durationMs: 5 });
    expect(result.status).toBe('FAIL');
    expect(result.errors.join(' ')).toContain('minScore');
  });

  it('meldet Laufzeit-Überschreitung als FAIL', () => {
    const result = gradePluginResult({ pluginId: 'drum', score: 5, durationMs: 9999 });
    expect(result.status).toBe('FAIL');
    expect(result.errors.join(' ')).toContain('budget');
  });

  it('übernimmt gemeldete Laufzeitfehler', () => {
    const result = gradePluginResult({ pluginId: 'drum', score: 5, durationMs: 1, errors: ['worklet crash'] });
    expect(result.status).toBe('FAIL');
    expect(result.errors).toContain('worklet crash');
  });
});

describe('renderEvalReportMarkdown – Report-Inhalt (P3-3-Prüfpunkt)', () => {
  it('enthält je Plugin Score, Dauer und Fehler', () => {
    const results = ['mixer', 'drum'].map((pluginId, index) =>
      gradePluginResult({ pluginId, score: index === 0 ? 5 : 3, durationMs: 1.5 }),
    );
    const md = renderEvalReportMarkdown(results, { generatedAt: '2026-09-03T00:00:00.000Z' });
    expect(md).toContain('| Plugin | Task | Score | Min-Score | Dauer (ms) | Status | Fehler |');
    expect(md).toContain('| mixer | plan | 5.00 |');
    expect(md).toContain('❌ FAIL');
    expect(md).toContain('FAIL: 1');
  });
});
