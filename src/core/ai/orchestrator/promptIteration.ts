// src/core/ai/orchestrator/promptIteration.ts
// ============================================================================
// P3-2: Iterations-Loop – pro Plugin Prompt-Version anlegen, Eval laufen lassen,
// Score messen, Prompt heuristisch optimieren, neue Version anlegen.
// ============================================================================

import { promptStore, type PromptStore } from './promptStore';
import { evaluationStore, type EvaluationStore } from './evaluationStore';
import { moaSystemPromptForPlugin, PLUGIN_COMMAND_CATALOG } from '../../../utils/prompts';

export interface PromptIterationReport {
  pluginId: string;
  iterations: number;
  promptVersion: number;
  /** Accuracy 0..1 der letzten Eval-Runde. */
  score: number;
  status: 'KEEP' | 'MAX_ITERATIONS';
  evaluations: number;
  changelog: string[];
}

export interface PromptIterationOptions {
  /** Accuracy-Schwelle 0..1 (Default: 1.0 = 100 % Kern-Kommandos). */
  minScore?: number;
  /** Maximale Iterationen (Default: 3). */
  maxIterations?: number;
  /** Evaluator: (pluginId, version, promptContent) → Accuracy 0..1. */
  evaluate?: (pluginId: string, version: number, promptContent: string) => number;
  /** Injizierbare Stores (Tests); Default = Singletons. */
  prompts?: PromptStore;
  evals?: EvaluationStore;
}

/**
 * Default-Evaluator: prüft, ob der Prompt alle Kern-Kommandos des
 * Plugin-Katalogs enthält. Deterministisch und offline testbar.
 */
export function evaluatePromptCoverage(pluginId: string, _version: number, promptContent: string): number {
  const catalog = PLUGIN_COMMAND_CATALOG[pluginId];
  if (!catalog) return 0;
  const commands = catalog
    .split(',')
    .map((c) => c.trim().split('(')[0].trim())
    .filter(Boolean);
  if (commands.length === 0) return 1;
  const hits = commands.filter((cmd) => promptContent.includes(cmd)).length;
  return hits / commands.length;
}

/** Heuristische Optimierung: hängt die erlaubten Kommandos an den Prompt an. */
export function optimizePromptContent(pluginId: string, content: string): string {
  const catalog = PLUGIN_COMMAND_CATALOG[pluginId] ?? 'status';
  const block = `\n\n## Erlaubte Kommandos\n${pluginId}: ${catalog}\n\nFehlerbehandlung: Wenn ein Kommando nicht verfügbar ist, wähle 'status' und melde den Fehler.`;
  if (content.includes('## Erlaubte Kommandos')) return content;
  return `${content.trim()}${block}`;
}

/**
 * Führt den Iterations-Loop für ein Plugin aus:
 * Prompt-Version anlegen → Eval-Suite → Score → optimieren → neue Version.
 * Bricht ab, sobald minScore erreicht ist (oder maxIterations).
 */
export function runPromptIteration(pluginId: string, options: PromptIterationOptions = {}): PromptIterationReport {
  const prompts = options.prompts ?? promptStore;
  const evals = options.evals ?? evaluationStore;
  const minScore = options.minScore ?? 1;
  const maxIterations = options.maxIterations ?? 3;
  const evaluate = options.evaluate ?? evaluatePromptCoverage;
  const changelog: string[] = [];

  let active = prompts.getActive(pluginId);
  if (!active) {
    active = prompts.upsert(pluginId, moaSystemPromptForPlugin(pluginId), { changelog: 'Initial-Prompt aus PLUGIN_MOA_SYSTEM_PROMPTS' });
    changelog.push(`v${active.version}: Initial-Prompt angelegt`);
  }

  let score = 0;
  let iterations = 0;
  while (iterations < maxIterations) {
    iterations++;
    const prompt = prompts.getActive(pluginId) ?? active;
    score = evaluate(pluginId, prompt.version, prompt.content);

    evals.record({
      pluginId,
      task: 'plan',
      promptVersion: prompt.version,
      model: 'heuristic',
      provider: 'offline',
      input: 'kern-kommandos',
      output: { accuracy: score },
      score: Math.round(score * 5 * 100) / 100,
      metrics: { accuracy: score, iterations },
    });

    if (score >= minScore) {
      return { pluginId, iterations, promptVersion: prompt.version, score, status: 'KEEP', evaluations: iterations, changelog };
    }

    const optimized = optimizePromptContent(pluginId, prompt.content);
    const next = prompts.upsert(pluginId, optimized, {
      changelog: `Iteration ${iterations}: Score ${score.toFixed(2)} < ${minScore} → Kommando-Katalog ergänzt`,
    });
    changelog.push(`v${next.version}: Score ${score.toFixed(2)} < ${minScore} → optimiert`);
    active = next;
  }

  const finalPrompt = prompts.getActive(pluginId) ?? active;
  return {
    pluginId,
    iterations,
    promptVersion: finalPrompt.version,
    score,
    status: 'MAX_ITERATIONS',
    evaluations: iterations,
    changelog,
  };
}
