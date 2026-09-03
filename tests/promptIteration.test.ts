// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { PromptStore } from '../src/core/ai/orchestrator/promptStore';
import { EvaluationStore } from '../src/core/ai/orchestrator/evaluationStore';
import {
  evaluatePromptCoverage,
  optimizePromptContent,
  runPromptIteration,
} from '../src/core/ai/orchestrator/promptIteration';

function freshStores() {
  return { prompts: new PromptStore(), evals: new EvaluationStore() };
}

describe('P3-2: Prompt-Iterations-Loop', () => {
  it('optimiert einen Prompt, bis die Kommando-Abdeckung 100 % erreicht', () => {
    const { prompts, evals } = freshStores();
    const report = runPromptIteration('mixer', { prompts, evals });

    expect(report.status).toBe('KEEP');
    expect(report.score).toBe(1);
    expect(report.promptVersion).toBeGreaterThanOrEqual(2);
    expect(report.iterations).toBe(2);
    const active = prompts.getActive('mixer');
    expect(active?.content).toContain('## Erlaubte Kommandos');
    expect(active?.content).toContain('mixer: gain(db)');
    expect(evals.listByPlugin('mixer').length).toBeGreaterThanOrEqual(1);
  });

  it('behält einen bereits guten Prompt (KEEP nach einer Iteration)', () => {
    const { prompts, evals } = freshStores();
    prompts.upsert('drum', 'Drum-Agent mit drum: kit(kit), pattern_random', { version: 1 });
    const report = runPromptIteration('drum', { prompts, evals });
    expect(report.status).toBe('KEEP');
    expect(report.iterations).toBe(1);
    expect(report.promptVersion).toBe(1);
  });

  it('stoppt nach maxIterations, wenn der Evaluator nie grün wird', () => {
    const { prompts, evals } = freshStores();
    const report = runPromptIteration('eq', {
      prompts,
      evals,
      maxIterations: 2,
      evaluate: () => 0,
    });
    expect(report.status).toBe('MAX_ITERATIONS');
    expect(report.iterations).toBe(2);
    expect(report.score).toBe(0);
  });

  it('evaluatePromptCoverage misst die Kommando-Abdeckung deterministisch', () => {
    expect(evaluatePromptCoverage('mixer', 1, 'Du bist der Mix-Agent.')).toBe(0);
    expect(evaluatePromptCoverage('mixer', 1, 'Nutze gain(db)')).toBe(1);
    expect(evaluatePromptCoverage('unbekannt', 1, 'egal')).toBe(0);
  });

  it('optimizePromptContent hängt den Kommando-Katalog genau einmal an', () => {
    const once = optimizePromptContent('synth', 'Du bist der Synth-Agent.');
    expect(once).toContain('## Erlaubte Kommandos');
    expect(once).toContain('synth: note(freq)');
    const twice = optimizePromptContent('synth', once);
    expect(twice).toBe(once);
  });
});
