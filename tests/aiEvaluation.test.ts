import { describe, expect, it } from 'vitest';
import {
  EvalRunner,
  bleuScore,
  estimateTokens,
  evaluateCase,
  exactMatch,
  rougeL,
  tokenUsage,
} from '../src/core/ai/orchestrator/evaluation';

describe('AI Evaluation – Token/Accuracy', () => {
  it('schätzt Tokens als ceil(chars/4)', () => {
    expect(estimateTokens('')).toBe(1);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });

  it('tokenUsage summiert Prompt + Completion', () => {
    const usage = tokenUsage('aaaaaaaa', 'bbbb');
    expect(usage.promptTokens).toBe(2);
    expect(usage.completionTokens).toBe(1);
    expect(usage.total).toBe(3);
  });

  it('exactMatch ignoriert Case/Whitespace', () => {
    expect(exactMatch('  Hallo Welt ', 'hallo welt')).toBe(true);
    expect(exactMatch('A', 'B')).toBe(false);
  });
});

describe('AI Evaluation – BLEU/ROUGE', () => {
  it('BLEU=1 bei identischem Text', () => {
    expect(bleuScore('die katze sitzt', 'die katze sitzt')).toBeCloseTo(1, 4);
  });

  it('BLEU=0 bei komplett anderem Text', () => {
    expect(bleuScore('die katze', 'ein hund')).toBeLessThan(1e-6);
  });

  it('ROUGE-L misst LCS-F1', () => {
    const score = rougeL('a b c d', 'a b x d');
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(1);
    expect(rougeL('a b c', 'a b c')).toBeCloseTo(1, 4);
  });
});

describe('AI Evaluation – EvalRunner', () => {
  it('aggregiert Accuracy/Latenz/Token über Cases', () => {
    const runner = new EvalRunner();
    runner.add({ id: 'c1', task: 'classify', model: 'ast', input: 'audio', expected: 'speech', actual: 'speech', latencyMs: 100 });
    runner.add({ id: 'c2', task: 'classify', model: 'ast', input: 'audio', expected: 'music', actual: 'noise', latencyMs: 300 });
    const report = runner.run();
    expect(report.summary.count).toBe(2);
    expect(report.summary.avgLatencyMs).toBeCloseTo(200, 1);
    expect(report.summary.accuracy).toBeCloseTo(0.5, 4);
    expect(report.summary.totalTokens).toBeGreaterThan(0);
    expect(report.cases[0].metrics.exactMatch).toBe(true);
  });
});

describe('AI Evaluation – evaluateCase', () => {
  it('liefert alle Metriken', () => {
    const metrics = evaluateCase({ id: 'x', task: 'llm', model: 'deepseek-flash', input: 'Hallo Welt', expected: 'Hallo Welt', actual: 'Hallo Welt', latencyMs: 42 });
    expect(metrics.exactMatch).toBe(true);
    expect(metrics.bleu).toBeCloseTo(1, 4);
    expect(metrics.rougeL).toBeCloseTo(1, 4);
    expect(metrics.tokenUsage.total).toBeGreaterThan(0);
    expect(metrics.latencyMs).toBe(42);
  });
});
