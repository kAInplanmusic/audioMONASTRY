// src/core/ai/orchestrator/promptIteration.ts
// ============================================================================
// P3-2 + INFRA-AI-002: Iterations-Loop – pro Plugin Prompt-Version anlegen,
// WIRKUNG messen, Prompt heuristisch optimieren, neue Version anlegen.
//
// WARUM DAS UMGESCHRIEBEN WURDE: der fruehere Evaluator zaehlte, wie viele
// Kommando-NAMEN als Substring im Prompt stehen – und der Optimierer haengte
// genau diese Namensliste an den Prompt. Der Loop konvergierte damit garantiert
// in der zweiten Runde auf 1.0, unabhaengig davon, ob ein Modell die Kommandos
// benutzt; ein Modell wurde nie aufgerufen. Gemessen wird jetzt die ANTWORT eines
// Modells (5..1 Punkte aus `evalGrading.gradePlanAnswer`), die Kommando-Abdeckung
// bleibt nur als schnelle Offline-Vorpruefung erhalten.
// ============================================================================

import { promptStore, type PromptStore } from './promptStore';
import { evaluationStore, type EvaluationStore } from './evaluationStore';
import { moaSystemPromptForPlugin, PLUGIN_COMMAND_CATALOG } from '../../../utils/prompts';
import { buildPlanPrompt, gradeEmptyAnswer, gradePlanAnswer, type PlanGrade } from './evalGrading';
import { evalSpecFor } from './evalMatrix';
import { llmRouter } from '../LlmRouter';

/** Was gemessen wird (INFRA-AI-002). */
export type PromptIterationMetric = 'plan-effect' | 'coverage-selfcheck';

export interface PromptIterationReport {
  pluginId: string;
  iterations: number;
  promptVersion: number;
  /** 0..1 nach der gewaehlten Metrik (bei `UNCHECKED` immer 0). */
  score: number;
  status: 'KEEP' | 'MAX_ITERATIONS' | 'UNCHECKED';
  metric: PromptIterationMetric;
  /** false = es wurde nicht gemessen (kein Modell erreichbar / Modellaufruf gescheitert). */
  checked: boolean;
  skipReason?: string;
  evaluations: number;
  changelog: string[];
}

/** Ein Plan-Completions-Aufruf (injizierbar fuer Tests/Offline-Beweise). */
export type PlanCompleteFn = (req: {
  prompt: string;
  complexity: 'moderate';
  maxTokens: number;
  temperature: number;
  timeoutMs?: number;
}) => Promise<{ text: string; provider?: string; model?: string }>;

export interface PromptIterationOptions {
  /** Schwelle 0..1 (Default: 1.0 = Plan exakt). */
  minScore?: number;
  /** Maximale Iterationen (Default: 3). */
  maxIterations?: number;
  /** Eigener Evaluator (sync/async) – dann gilt `metric: 'coverage-selfcheck'`. */
  evaluate?: (pluginId: string, version: number, promptContent: string) => number | Promise<number>;
  /** Injizierbare Stores (Tests); Default = Singletons. */
  prompts?: PromptStore;
  evals?: EvaluationStore;
  /** Metrik (Default: `plan-effect`, also ein echtes Modell). */
  metric?: PromptIterationMetric;
  /** Modellaufruf fuer die Wirkungs-Metrik (Default: LlmRouter). */
  complete?: PlanCompleteFn;
  timeoutMs?: number;
  /** Aufgabenstellung, gegen die bewertet wird (Default: Planungs-Task der Matrix). */
  task?: string;
}

/** Zeitlimit je Modellaufruf im Loop (env `AI_ITERATE_TIMEOUT_MS`, Default 60 s). */
export function iterationTimeoutMs(): number {
  const raw = Number(process.env.AI_ITERATE_TIMEOUT_MS ?? '');
  return Number.isFinite(raw) && raw > 0 ? raw : 60_000;
}

/**
 * Vorpruefung (KEIN Gate!): prueft, ob der Prompt die Kern-Kommandos des
 * Plugin-Katalogs ueberhaupt NENNT. Deterministisch und offline – aber genau der
 * Grund fuer den alten Fehlschluss: der Optimierer schreibt diese Namen selbst in
 * den Prompt, deshalb darf diese Zahl nicht als „Wirkung" verkauft werden.
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

/** Heuristische Optimierung: haengt die erlaubten Kommandos an den Prompt an. */
export function optimizePromptContent(pluginId: string, content: string): string {
  const catalog = PLUGIN_COMMAND_CATALOG[pluginId] ?? 'status';
  const block = `\n\n## Erlaubte Kommandos\n${pluginId}: ${catalog}\n\nFehlerbehandlung: Wenn ein Kommando nicht verfügbar ist, wähle 'status' und melde den Fehler.`;
  if (content.includes('## Erlaubte Kommandos')) return content;
  return `${content.trim()}${block}`;
}

/** Ergebnis eines Wirkungs-Laufs inklusive Herkunft (fuer den Eval-Record). */
export interface PlanEffectResult {
  /** 0..1 (Plan-Grade 5..0 geteilt durch 5). */
  score: number;
  grade: PlanGrade;
  provider: string;
  model: string;
}

/**
 * INFRA-AI-002 (Wirkungs-Metrik): schickt den PROMPT IN SEINER VERSION an ein
 * echtes Modell und bewertet die ANTWORT gegen den Kommando-Katalog.
 *
 * Der Prompt-Text unter Test ist die ROLLE (Systemprompt); die Aufgabe kommt
 * dazu. Standard ist `withCatalog: false` – der Katalog steht dann NICHT in der
 * Aufgabenstellung, denn genau das ist der Punkt: eine Prompt-Version wirkt nur,
 * wenn sie die operativen Angaben (erlaubte Kommandos, Fehlerregel) selbst
 * enthaelt. Mit `withCatalog: true` wird derselbe Aufbau wie im echten Plan-Pfad
 * (`MoaAgent.plan`, Katalog in der Aufgabenstellung) geprueft – dann ist die
 * Metrik bewusst unempfindlich gegen den Rollen-Text.
 */
export async function evaluatePlanEffectWithDetails(
  pluginId: string,
  _version: number,
  promptContent: string,
  options: { complete?: PlanCompleteFn; timeoutMs?: number; task?: string; withCatalog?: boolean } = {},
): Promise<PlanEffectResult> {
  const catalog = PLUGIN_COMMAND_CATALOG[pluginId];
  const task = options.task ?? `Waehle das passende Kern-Kommando fuer ${evalSpecFor(pluginId).task}.`;
  const complete = options.complete ?? defaultPlanComplete;
  const instruction = options.withCatalog === true
    ? buildPlanPrompt(pluginId, catalog, task)
    : `Aufgabe: ${task}\nAntworte NUR mit JSON, ohne Markdown: {"pluginId":"${pluginId}","command":"<kommando aus der Rolle>"}`;
  const prompt = `${promptContent.trim()}\n\n${instruction}`;
  const completion = await complete({
    prompt,
    complexity: 'moderate',
    maxTokens: 256,
    temperature: 0,
    timeoutMs: options.timeoutMs ?? iterationTimeoutMs(),
  });
  const text = typeof completion.text === 'string' ? completion.text : '';
  const grade = text.trim().length > 0 ? gradePlanAnswer(pluginId, catalog, text) : gradeEmptyAnswer();
  return {
    score: Math.max(0, Math.min(1, grade.score / 5)),
    grade,
    provider: completion.provider ?? 'unbekannt',
    model: completion.model ?? completion.provider ?? 'unbekannt',
  };
}

/** Wie oben, nur die Zahl 0..1 (fuer `options.evaluate`-Injektion). */
export async function evaluatePlanEffect(
  pluginId: string,
  version: number,
  promptContent: string,
  options: { complete?: PlanCompleteFn; timeoutMs?: number; task?: string; withCatalog?: boolean } = {},
): Promise<number> {
  return (await evaluatePlanEffectWithDetails(pluginId, version, promptContent, options)).score;
}

/** Default-Weg: der LlmRouter (AI-Schalter/Timeout/Breaker/Kosten greifen dort). */
async function defaultPlanComplete(req: {
  prompt: string;
  complexity: 'moderate';
  maxTokens: number;
  temperature: number;
  timeoutMs?: number;
}): Promise<{ text: string; provider?: string; model?: string }> {
  const completion = await llmRouter.complete({
    prompt: req.prompt,
    complexity: req.complexity,
    maxTokens: req.maxTokens,
    temperature: req.temperature,
    timeoutMs: req.timeoutMs,
  });
  return { text: completion.text, provider: completion.provider, model: completion.model };
}

/**
 * Fuehrt den Iterations-Loop fuer ein Plugin aus:
 * Prompt-Version anlegen → Wirkung messen → optimieren → neue Version.
 * Bricht ab, sobald `minScore` erreicht ist (KEEP) oder `maxIterations` erreicht
 * sind. Ohne erreichbares Modell gilt der Lauf als `UNCHECKED` – es wird KEIN
 * Score erfunden (gleiche Regel wie im Eval-Runner, INFRA-AI-001).
 */
export async function runPromptIteration(
  pluginId: string,
  options: PromptIterationOptions = {},
): Promise<PromptIterationReport> {
  const prompts = options.prompts ?? promptStore;
  const evals = options.evals ?? evaluationStore;
  const minScore = options.minScore ?? 1;
  const maxIterations = options.maxIterations ?? 3;
  const metric: PromptIterationMetric = options.metric
    ?? (options.evaluate ? 'coverage-selfcheck' : 'plan-effect');
  const timeoutMs = options.timeoutMs ?? iterationTimeoutMs();
  const changelog: string[] = [];

  let active = prompts.getActive(pluginId);
  if (!active) {
    active = prompts.upsert(pluginId, moaSystemPromptForPlugin(pluginId), { changelog: 'Initial-Prompt aus PLUGIN_MOA_SYSTEM_PROMPTS' });
    changelog.push(`v${active.version}: Initial-Prompt angelegt`);
  }

  // Ohne Provider ist die Wirkungs-Metrik nicht messbar -> ehrlich "nicht geprueft"
  // statt eines heuristischen Ersatz-Scores. Injizierte Evaluatoren/Completions
  // (Tests, Offline-Beweise) umgehen diese Vorpruefung bewusst.
  if (metric === 'plan-effect' && !options.evaluate && !options.complete && llmRouter.rankProviders('moderate').length === 0) {
    const skipReason = 'kein LLM-Provider erreichbar (AI aus, Flotte schlafen oder Keys fehlen)';
    changelog.push(skipReason);
    return {
      pluginId,
      iterations: 0,
      promptVersion: active.version,
      score: 0,
      status: 'UNCHECKED',
      metric,
      checked: false,
      skipReason,
      evaluations: 0,
      changelog,
    };
  }

  let score = 0;
  let iterations = 0;
  while (iterations < maxIterations) {
    iterations++;
    const prompt = prompts.getActive(pluginId) ?? active;

    let run: { score: number; provider: string; model: string; reason: string; input: string };
    try {
      if (options.evaluate) {
        run = {
          score: await options.evaluate(pluginId, prompt.version, prompt.content),
          provider: 'eigener-evaluator',
          model: 'custom',
          reason: 'eigener Evaluator (nicht die Wirkungs-Metrik)',
          input: 'custom',
        };
      } else if (metric === 'coverage-selfcheck') {
        run = {
          score: evaluatePromptCoverage(pluginId, prompt.version, prompt.content),
          provider: 'coverage-selfcheck',
          model: 'offline',
          reason: 'Kommando-Abdeckung im Prompt-Text (Vorpruefung, KEINE Modellwirkung)',
          input: 'kern-kommandos',
        };
      } else {
        const detail = await evaluatePlanEffectWithDetails(pluginId, prompt.version, prompt.content, {
          complete: options.complete,
          timeoutMs,
          task: options.task,
        });
        run = {
          score: detail.score,
          provider: detail.provider,
          model: detail.model,
          reason: detail.grade.reason,
          input: 'plan-antwort',
        };
      }
    } catch (error) {
      // Modellaufruf gescheitert: kein Score, Lauf als NICHT GEPRUEFT beenden.
      const skipReason = `Modellaufruf fehlgeschlagen: ${(error as Error).message}`;
      changelog.push(`v${prompt.version}: ${skipReason}`);
      return {
        pluginId,
        iterations,
        promptVersion: prompt.version,
        score: 0,
        status: 'UNCHECKED',
        metric,
        checked: false,
        skipReason,
        evaluations: iterations - 1,
        changelog,
      };
    }

    score = run.score;
    evals.record({
      pluginId,
      task: 'plan',
      promptVersion: prompt.version,
      model: run.model,
      provider: run.provider,
      input: run.input,
      output: { accuracy: score, reason: run.reason },
      score: Math.round(score * 5 * 100) / 100,
      metrics: { accuracy: score, iterations, metric, reason: run.reason },
    });

    if (score >= minScore) {
      return {
        pluginId,
        iterations,
        promptVersion: prompt.version,
        score,
        status: 'KEEP',
        metric,
        checked: true,
        evaluations: iterations,
        changelog,
      };
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
    metric,
    checked: true,
    evaluations: iterations,
    changelog,
  };
}
