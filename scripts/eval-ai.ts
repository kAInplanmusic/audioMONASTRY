/**
 * P3-3 + INFRA-AI-001: AI-Eval-Runner
 * ===================================
 * Bewertet je Plugin einen Planungs-Case über den Plugin-Kommando-Katalog und
 * schreibt:
 *   - test-results/ai-eval.json            (Gesamt-Report inkl. Selbsttest)
 *   - test-results/ai-evaluations.json     (DB-ready, Schema ai_evaluations)
 *   - test-results/ai-eval-runs.json       (DB-ready, Schema ai_eval_runs, Gate)
 *   - test-results/ai-eval-report.json/.md (Report je Plugin: Score, Dauer, Fehler)
 * und persistiert bei konfiguriertem Supabase in `ai_evaluations`/`ai_eval_runs`
 * (sonst No-Op).
 *
 * WARUM DIESER UMBau (Audit INFRA-AI-001): Vorher konstruierte das Skript
 * expected und actual identisch und schrieb `model: 'mock'`, `score: 5`,
 * `exactMatch: true` – ohne einen einzigen Modellaufruf. Das Gate konnte damit
 * per Konstruktion nicht fehlschlagen. Jetzt gilt:
 *
 *   * **Echtes Modell:** je Plugin geht ein Planungs-Prompt über den LlmRouter
 *     (Provider-Kette respektiert AI-Schalter/Circuit-Breaker/Kosten, siehe
 *     `src/core/ai/LlmRouter.ts`), die Antwort wird deterministisch bewertet
 *     (`evalGrading.ts`: 5 = Plan exakt, 4 = gültiges anderes Kommando,
 *     2 = falsches Plugin, 1 = kein verwertbares JSON, 0 = keine Antwort).
 *   * **Ehrliches „nicht geprüft":** ist kein Provider erreichbar (Fleet aus,
 *     keine Keys), werden die Läufe als `UNCHECKED` gemeldet – es wird KEIN
 *     Score erfunden. Exit 0 (Nightly bleibt grün, aber ehrlich), außer
 *     `AI_EVAL_REQUIRE_MODEL=1` bzw. `--require-model`: dann Exit 1.
 *   * **Selbsttest getrennt:** die 21 deterministischen Kern-Kommandos bleiben
 *     als `selfcheck` im Report (Beweis, dass Katalog/Matrix vollständig sind) –
 *     sie zählen ausdrücklich NICHT als Modell-Score.
 *
 * RT-AUDIT-P1-015 · DAW-Executor-Eval (`--executor`): 50 Prompts aus
 * `executorEvalSet.ts` gegen den DawExecutor (Executor-Modell, guided_json +
 * Validierung). Gate: 100 % gültiges, schema-konformes JSON; zusätzlich wird
 * die Trefferquote gegen die erwarteten Kommandos berichtet. `--mock` nimmt das
 * deterministische Mock-Modell (läuft ohne Netz, wie der Vitest-Gate-Test);
 * ohne `--mock` und ohne Provider: ehrlich UNCHECKED. Report:
 * test-results/executor-eval.json.
 *
 * Aufruf: npx tsx scripts/eval-ai.ts [--require-model] [--plugins=a,b,c]
 *         npx tsx scripts/eval-ai.ts --executor [--mock] [--require-model]
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { EvalRunner } from '../src/core/ai/orchestrator/evaluation';
import { evaluationStore } from '../src/core/ai/orchestrator/evaluationStore';
import { aiPersistence } from '../src/core/ai/orchestrator/aiPersistence';
import {
  EVAL_PLUGIN_IDS,
  evalSpecFor,
  gradePluginResult,
  renderEvalReportMarkdown,
  type PluginEvalResult,
} from '../src/core/ai/orchestrator/evalMatrix';
import { buildPlanPrompt, gradeEmptyAnswer, gradePlanAnswer, type PlanGrade } from '../src/core/ai/orchestrator/evalGrading';
import { llmRouter } from '../src/core/ai/LlmRouter';
import { PLUGIN_COMMAND_CATALOG } from '../src/utils/prompts';
import { DawExecutor, pluginCommandJsonSchema, validateExecutorOutput } from '../src/core/ai/dawExecutor';
import { EXECUTOR_EVAL_SET, createMockExecutorModel } from '../src/core/ai/orchestrator/executorEvalSet';

const ALL_PLUGIN_IDS = [...EVAL_PLUGIN_IDS];

/** CLI-Schalter des Laufs. */
interface EvalOptions {
  requireModel: boolean;
  plugins: string[];
}

function parseOptions(argv: string[]): EvalOptions {
  const pluginsArg = argv.find((a) => a.startsWith('--plugins='))?.slice('--plugins='.length);
  const requested = (pluginsArg ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const unknown = requested.filter((id) => !(ALL_PLUGIN_IDS as readonly string[]).includes(id));
  if (unknown.length > 0) {
    throw new Error(`unbekannte Plugin-IDs: ${unknown.join(', ')} (erlaubt: ${ALL_PLUGIN_IDS.join(', ')})`);
  }
  const envPlugins = (process.env.AI_EVAL_PLUGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const selected = requested.length > 0 ? requested : envPlugins.length > 0 ? envPlugins : ALL_PLUGIN_IDS;
  return {
    requireModel: argv.includes('--require-model') || process.env.AI_EVAL_REQUIRE_MODEL === '1',
    plugins: selected,
  };
}

function firstCommand(pluginId: string): string {
  const catalog = PLUGIN_COMMAND_CATALOG[pluginId] ?? 'status';
  return catalog.split(',')[0].trim().split('(')[0].trim();
}

/** Timeout je Modellaufruf (der LlmRouter bricht damit wirklich ab). */
function evalTimeoutMs(): number {
  const raw = Number(process.env.AI_EVAL_TIMEOUT_MS ?? 60_000);
  return Number.isFinite(raw) && raw > 0 ? raw : 60_000;
}

/** RT-AUDIT-P1-015: Executor-Eval über das 50-Prompt-Set. */
async function runExecutorEval(argv: string[]): Promise<void> {
  const useMock = argv.includes('--mock');
  const requireModel = argv.includes('--require-model') || process.env.AI_EVAL_REQUIRE_MODEL === '1';
  const outDir = path.resolve(process.cwd(), 'test-results');
  mkdirSync(outDir, { recursive: true });
  const providers = llmRouter.rankProviders('simple').map((p) => p.id);
  if (!useMock && providers.length === 0) {
    const reason = 'kein LLM-Provider erreichbar (AI aus, Fleet schlafen oder Keys fehlen)';
    writeFileSync(path.join(outDir, 'executor-eval.json'), JSON.stringify({ generatedAt: new Date().toISOString(), status: 'UNCHECKED', reason, cases: EXECUTOR_EVAL_SET.length }, null, 2));
    console.warn(`eval:ai --executor NICHT GEPRÜFT: ${reason}`);
    if (requireModel) process.exitCode = 1;
    return;
  }
  const complete = useMock
    ? createMockExecutorModel().complete
    : (req: Parameters<typeof llmRouter.complete>[0]) => llmRouter.complete({ ...req, timeoutMs: evalTimeoutMs() });
  const executor = new DawExecutor(complete);
  const schemaText = JSON.stringify(pluginCommandJsonSchema());
  const rows: Array<Record<string, unknown>> = [];
  let validJson = 0;
  let exact = 0;
  for (const entry of EXECUTOR_EVAL_SET) {
    const started = performance.now();
    const result = await executor.run(entry.task);
    // Gegenprobe: das ausgelieferte JSON MUSS parsebar sein und erneut validieren.
    let reparsed = false;
    try {
      const again = validateExecutorOutput(result.json);
      reparsed = result.ok ? again.ok && JSON.stringify(again.commands) === JSON.stringify(result.commands) : JSON.parse(result.json).commands.length === 0;
    } catch {
      reparsed = false;
    }
    if (reparsed) validJson += 1;
    const hit = JSON.stringify(result.commands) === JSON.stringify(entry.expected);
    if (hit) exact += 1;
    rows.push({
      id: entry.id,
      ok: result.ok,
      validJson: reparsed,
      exact: hit,
      attempts: result.attempts,
      commands: result.commands,
      expected: entry.expected,
      errors: result.errors,
      repairs: result.repairs,
      latencyMs: Number((performance.now() - started).toFixed(1)),
    });
  }
  const total = EXECUTOR_EVAL_SET.length;
  const report = {
    generatedAt: new Date().toISOString(),
    status: validJson === total ? 'PASS' : 'FAIL',
    model: useMock ? 'mock-executor' : providers.join(' → '),
    cases: total,
    validJsonRate: validJson / total,
    exactRate: exact / total,
    schemaBytes: schemaText.length,
    rows,
  };
  writeFileSync(path.join(outDir, 'executor-eval.json'), JSON.stringify(report, null, 2));
  console.log(`eval:ai --executor ${report.status} – ${total} Prompts, gültiges JSON ${(report.validJsonRate * 100).toFixed(0)} %, `
    + `erwartete Kommandos ${(report.exactRate * 100).toFixed(0)} % (${report.model}) → test-results/executor-eval.json`);
  if (validJson !== total) process.exitCode = 1;
}

async function main(): Promise<void> {
  if (process.argv.includes('--executor')) {
    await runExecutorEval(process.argv.slice(2));
    return;
  }
  const options = parseOptions(process.argv.slice(2));
  const runner = new EvalRunner();

  // Selbsttest: je Plugin ein deterministischer Kern-Kommando-Case. Er belegt,
  // dass Katalog/Matrix vollständig sind – er ist KEIN Modell-Score.
  options.plugins.forEach((pluginId) => {
    const action = firstCommand(pluginId);
    runner.add({
      id: `${pluginId}-${action}`,
      task: 'plan-selfcheck',
      model: 'selfcheck',
      input: `${pluginId} ${action}`,
      expected: `${pluginId}:${action}`,
      actual: `${pluginId}:${action}`,
      latencyMs: 0.1,
    });
  });
  const selfcheck = runner.run();

  const providers = llmRouter.rankProviders('moderate').map((p) => p.id);
  const canCheck = providers.length > 0;
  const skipReason = canCheck ? '' : 'kein LLM-Provider erreichbar (AI aus, Fleet schlafen oder Keys fehlen)';
  console.log(
    canCheck
      ? `eval:ai – echtes Modell, Provider-Kette: ${providers.join(' → ')}`
      : `eval:ai – NICHT GEPRÜFT: ${skipReason}`,
  );

  const outDir = path.resolve(process.cwd(), 'test-results');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, 'ai-eval.json'), JSON.stringify({ ...selfcheck, providers, canCheck }, null, 2));

  const evaluations: Array<Record<string, unknown>> = [];
  const runs: Array<Record<string, unknown>> = [];
  const results: PluginEvalResult[] = [];

  for (const pluginId of options.plugins) {
    const spec = evalSpecFor(pluginId);
    const startedAt = performance.now();
    const errors: string[] = [];
    let score = 0;

    try {
      const run = evaluationStore.startRun(pluginId);

      if (!canCheck) {
        // Ehrliches „nicht geprüft" statt Mock-Score (INFRA-AI-001).
        const summary = evaluationStore.markUnchecked(run.runId, skipReason);
        runs.push({
          run_id: summary.runId,
          plugin_id: pluginId,
          status: summary.status,
          summary: {
            avgScore: 0,
            count: 0,
            minScore: spec.minScore,
            durationMs: summary.durationMs ?? 0,
            checked: false,
            skipReason,
            errors: [skipReason],
          },
        });
        results.push(gradePluginResult({
          pluginId,
          score: 0,
          durationMs: performance.now() - startedAt,
          checked: false,
          skipReason,
        }));
        continue;
      }

      const prompt = buildPlanPrompt(pluginId, PLUGIN_COMMAND_CATALOG[pluginId], `Waehle das passende Kern-Kommando fuer ${spec.task}.`);
      let grade: PlanGrade;
      let provider = 'n/a';
      let model = 'n/a';
      try {
        const completion = await llmRouter.complete({
          prompt,
          complexity: 'moderate',
          maxTokens: 256,
          temperature: 0,
          timeoutMs: evalTimeoutMs(),
        });
        provider = completion.provider;
        model = completion.model ?? completion.provider;
        grade = completion.text.trim()
          ? gradePlanAnswer(pluginId, PLUGIN_COMMAND_CATALOG[pluginId], completion.text)
          : gradeEmptyAnswer();
      } catch (error) {
        grade = { score: 0, exactMatch: false, reason: `Modellaufruf fehlgeschlagen: ${(error as Error).message}` };
      }
      if (grade.score < spec.minScore) errors.push(grade.reason);
      score = grade.score;

      const record = evaluationStore.record({
        pluginId,
        task: spec.task,
        promptVersion: 1,
        model,
        provider,
        input: prompt,
        output: grade.answer ? JSON.stringify(grade.answer) : grade.reason,
        score: grade.score,
        metrics: { latencyMs: Number((performance.now() - startedAt).toFixed(3)), exactMatch: grade.exactMatch, reason: grade.reason },
      });
      const finished = evaluationStore.finishRun(run.runId, spec.minScore);

      evaluations.push({
        plugin_id: record.pluginId,
        task: record.task,
        prompt_version: record.promptVersion,
        model: record.model,
        provider: record.provider,
        input: record.input,
        output: record.output,
        score: record.score,
        metrics: record.metrics,
      });
      runs.push({
        run_id: finished.runId,
        plugin_id: pluginId,
        status: finished.status,
        summary: {
          avgScore: finished.avgScore,
          count: finished.count,
          minScore: spec.minScore,
          durationMs: Number((performance.now() - startedAt).toFixed(3)),
          checked: true,
          provider,
          exactMatch: grade.exactMatch,
          reason: grade.reason,
          errors,
        },
      });

      await aiPersistence.saveEvaluation({
        pluginId: record.pluginId,
        task: record.task,
        promptVersion: record.promptVersion,
        model: record.model,
        provider: record.provider,
        input: record.input,
        output: record.output,
        score: record.score,
        metrics: record.metrics,
      });
      await aiPersistence.saveEvalRun({
        runId: finished.runId,
        pluginId,
        status: finished.status,
        summary: {
          avgScore: finished.avgScore,
          count: finished.count,
          minScore: spec.minScore,
          durationMs: Number((performance.now() - startedAt).toFixed(3)),
        },
      });
    } catch (error) {
      errors.push((error as Error).message);
    }

    results.push(gradePluginResult({
      pluginId,
      score,
      durationMs: performance.now() - startedAt,
      errors,
    }));
  }

  writeFileSync(path.join(outDir, 'ai-evaluations.json'), JSON.stringify(evaluations, null, 2));
  writeFileSync(path.join(outDir, 'ai-eval-runs.json'), JSON.stringify(runs, null, 2));

  const generatedAt = new Date().toISOString();
  const failedResults = results.filter((r) => r.status === 'FAIL');
  const uncheckedResults = results.filter((r) => r.status === 'UNCHECKED');
  writeFileSync(
    path.join(outDir, 'ai-eval-report.json'),
    JSON.stringify({
      generatedAt,
      checked: canCheck,
      providers,
      plugins: results.length,
      failed: failedResults.length,
      unchecked: uncheckedResults.length,
      selfcheck: selfcheck.summary,
      results,
    }, null, 2),
  );
  writeFileSync(path.join(outDir, 'ai-eval-report.md'), renderEvalReportMarkdown(results, { generatedAt }));

  console.log(
    `eval:ai ${canCheck ? 'ok' : 'UNCHECKED'} – ${results.length} Plugins, ` +
    `${failedResults.length} FAIL, ${uncheckedResults.length} nicht geprüft · ` +
    `Selbsttest ${selfcheck.summary.count} Cases (nicht gewertet, ${(selfcheck.summary.accuracy * 100).toFixed(0)} % Deterministik) ` +
    '→ test-results/ai-eval*.json + ai-eval-report.md',
  );
  for (const failure of failedResults) {
    console.error(`  FAIL ${failure.pluginId}: ${failure.errors.join('; ')}`);
  }
  if (uncheckedResults.length > 0) {
    console.warn(`  NICHT GEPRÜFT (${uncheckedResults.length}): ${skipReason}`);
  }
  if (failedResults.length > 0) process.exitCode = 1;
  if (uncheckedResults.length > 0 && options.requireModel) {
    console.error('eval:ai --require-model: kein Modell erreichbar → Gate rot');
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('eval:ai FAILED:', e);
  process.exit(1);
});
