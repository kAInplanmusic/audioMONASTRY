import { describe, expect, it } from 'vitest';
import {
  buildPlanPrompt,
  gradeEmptyAnswer,
  gradePlanAnswer,
  parsePlanAnswer,
} from '../src/core/ai/orchestrator/evalGrading';
import { EvaluationStore } from '../src/core/ai/orchestrator/evaluationStore';
import { gradePluginResult, minScoreFor, renderEvalReportMarkdown } from '../src/core/ai/orchestrator/evalMatrix';

/**
 * INFRA-AI-001: Der Eval-Lauf schrieb bisher einen Mock-Score (expected ===
 * actual, model 'mock', score 5) – das Gate konnte per Konstruktion nicht
 * fehlschlagen. Diese Tests belegen, dass eine echte Modellantwort bewertet wird
 * und dass sowohl ein schlechter Prompt als auch ein fehlendes Modell sichtbar
 * werden.
 */
const CATALOG = 'gain(level), pan(value), mute(on|off), status';

describe('Bewertung echter Modellantworten (INFRA-AI-001)', () => {
  it('zieht JSON aus Prosa und Markdown-Zäunen', () => {
    expect(parsePlanAnswer('{"pluginId":"mixer","command":"gain"}')).toEqual({ pluginId: 'mixer', command: 'gain' });
    expect(parsePlanAnswer('Klar:\n```json\n{"pluginId":"eq","command":"status"}\n```')).toEqual({
      pluginId: 'eq',
      command: 'status',
    });
    expect(parsePlanAnswer('Ich wuerde {"pluginId":"mixer","command":"pan"} waehlen.')).toEqual({
      pluginId: 'mixer',
      command: 'pan',
    });
    expect(parsePlanAnswer('kein json')).toBeNull();
    expect(parsePlanAnswer(undefined)).toBeNull();
  });

  it('bewertet exakten Plan, gültige Alternative, falsches Plugin und Unrat', () => {
    expect(gradePlanAnswer('mixer', CATALOG, '{"pluginId":"mixer","command":"gain"}'))
      .toMatchObject({ score: 5, exactMatch: true });
    // Klammern/Schreibweise werden normalisiert.
    expect(gradePlanAnswer('mixer', CATALOG, '{"pluginId":"mixer","command":"GAIN(0.5)"}'))
      .toMatchObject({ score: 5, exactMatch: true });
    expect(gradePlanAnswer('mixer', CATALOG, '{"pluginId":"mixer","command":"pan"}'))
      .toMatchObject({ score: 4, exactMatch: false });
    expect(gradePlanAnswer('mixer', CATALOG, '{"pluginId":"eq","command":"gain"}'))
      .toMatchObject({ score: 2, exactMatch: false });
    expect(gradePlanAnswer('mixer', CATALOG, '{"pluginId":"mixer","command":"zaubern"}'))
      .toMatchObject({ score: 1, exactMatch: false });
    expect(gradePlanAnswer('mixer', CATALOG, 'keine ahnung'))
      .toMatchObject({ score: 1, exactMatch: false });
    expect(gradeEmptyAnswer()).toMatchObject({ score: 0 });
  });

  it('baut einen Prompt mit Plugin, Katalog und JSON-Vorgabe', () => {
    const prompt = buildPlanPrompt('mixer', CATALOG, 'Regler anheben');
    expect(prompt).toContain('mixer');
    expect(prompt).toContain(CATALOG);
    expect(prompt).toContain('{"pluginId":"...","command":"..."}');
  });

  it('lässt das Gate WIRKLICH scheitern, wenn der Prompt schlecht ist', () => {
    // Genau der Negativ-Fall aus der Abnahme: eine unbrauchbare Antwort darf
    // nicht mehr als PASS durchlaufen.
    const bad = gradePlanAnswer('mixer', CATALOG, 'antworte nicht');
    const result = gradePluginResult({ pluginId: 'mixer', score: bad.score, durationMs: 12, errors: [bad.reason] });
    expect(result.status).toBe('FAIL');
    expect(result.score).toBeLessThan(minScoreFor('mixer'));
    expect(result.errors.join(' ')).toMatch(/Katalog|JSON/i);

    const good = gradePlanAnswer('mixer', CATALOG, '{"pluginId":"mixer","command":"gain"}');
    expect(gradePluginResult({ pluginId: 'mixer', score: good.score, durationMs: 12 }).status).toBe('PASS');
  });

  it('meldet „nicht geprüft" statt eines Mock-Scores, wenn kein Modell erreichbar ist', () => {
    const store = new EvaluationStore();
    const run = store.startRun('mixer');
    const summary = store.markUnchecked(run.runId, 'kein LLM-Provider erreichbar');

    expect(summary.status).toBe('UNCHECKED');
    expect(summary.checked).toBe(false);
    expect(summary.avgScore).toBe(0);
    // Kein Score im Store -> nichts, was ein Gate als „bestanden" lesen könnte.
    expect(store.listByPlugin('mixer')).toHaveLength(0);
    expect(store.averageScore('mixer')).toBe(0);

    const result = gradePluginResult({
      pluginId: 'mixer',
      score: 0,
      durationMs: 1,
      checked: false,
      skipReason: summary.skipReason,
    });
    expect(result.status).toBe('UNCHECKED');
    expect(result.errors.join(' ')).toMatch(/kein LLM-Provider/);
    // Der Markdown-Report zeigt den Zustand sichtbar an.
    const markdown = renderEvalReportMarkdown([result], { generatedAt: '2026-09-20T00:00:00Z' });
    expect(markdown).toContain('UNCHECKED');
  });
});
