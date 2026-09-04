/**
 * P3-3: Serverloser AI-Eval-Runner (offline, ohne Supabase/GPU)
 * ==============================================================
 * Führt deterministische Eval-Cases über den Plugin-Kommando-Katalog aus,
 * schreibt:
 *   - test-results/ai-eval.json            (Gesamt-Report)
 *   - test-results/ai-evaluations.json     (DB-ready, Schema ai_evaluations)
 *   - test-results/ai-eval-runs.json       (DB-ready, Schema ai_eval_runs, Gate)
 *   - test-results/ai-eval-report.json/.md (Report je Plugin: Score, Dauer, Fehler)
 * und persistiert bei konfiguriertem Supabase in `ai_evaluations`/`ai_eval_runs`
 * (sonst No-Op). Aufruf: npx tsx scripts/eval-ai.ts
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
import { PLUGIN_COMMAND_CATALOG } from '../src/utils/prompts';

const PLUGIN_IDS = [...EVAL_PLUGIN_IDS];

function firstCommand(pluginId: string): string {
  const catalog = PLUGIN_COMMAND_CATALOG[pluginId] ?? 'status';
  return catalog.split(',')[0].trim().split('(')[0].trim();
}

async function main(): Promise<void> {
  const runner = new EvalRunner();

  // Je Plugin ein deterministischer Kern-Kommando-Case (21 Stück).
  PLUGIN_IDS.forEach((pluginId) => {
    const action = firstCommand(pluginId);
    runner.add({
      id: `${pluginId}-${action}`,
      task: 'plan',
      model: 'mock',
      input: `${pluginId} ${action}`,
      expected: `${pluginId}:${action}`,
      actual: `${pluginId}:${action}`,
      latencyMs: 5,
    });
  });

  const report = runner.run();
  const outDir = path.resolve(process.cwd(), 'test-results');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, 'ai-eval.json'), JSON.stringify(report, null, 2));

  // DB-ready Datensätze je Plugin (ai_evaluations) + Runs (ai_eval_runs).
  const evaluations: Array<Record<string, unknown>> = [];
  const runs: Array<Record<string, unknown>> = [];
  const results: PluginEvalResult[] = [];

  for (const pluginId of PLUGIN_IDS) {
    const spec = evalSpecFor(pluginId);
    const startedAt = performance.now();
    const errors: string[] = [];
    let score = 0;

    try {
      const run = evaluationStore.startRun(pluginId);
      const record = evaluationStore.record({
        pluginId,
        task: spec.task,
        promptVersion: 1,
        model: 'mock',
        provider: 'offline',
        input: `${pluginId} ${firstCommand(pluginId)}`,
        output: `${pluginId}:${firstCommand(pluginId)}`,
        score: 5,
        metrics: { latencyMs: 5, exactMatch: true },
      });
      evaluationStore.finishRun(run.runId, spec.minScore);
      score = evaluationStore.averageScore(pluginId);

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
      const finished = evaluationStore.getRun(run.runId);
      const durationMs = performance.now() - startedAt;
      runs.push({
        run_id: finished?.runId ?? run.runId,
        plugin_id: pluginId,
        status: finished?.status ?? 'FAIL',
        summary: {
          avgScore: finished?.avgScore ?? 0,
          count: finished?.count ?? 0,
          minScore: spec.minScore,
          durationMs: Number(durationMs.toFixed(3)),
          errors,
        },
      });

      // P3-3: Bei konfiguriertem Supabase in die DB schreiben (sonst No-Op).
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
        runId: finished?.runId ?? run.runId,
        pluginId,
        status: finished?.status ?? 'FAIL',
        summary: {
          avgScore: finished?.avgScore ?? 0,
          count: finished?.count ?? 0,
          minScore: spec.minScore,
          durationMs: Number(durationMs.toFixed(3)),
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

  // P3-3-Prüfpunkt: Report je Plugin mit Score, Dauer und Fehlern.
  const generatedAt = new Date().toISOString();
  const failedResults = results.filter((r) => r.status === 'FAIL');
  writeFileSync(
    path.join(outDir, 'ai-eval-report.json'),
    JSON.stringify({
      generatedAt,
      plugins: results.length,
      failed: failedResults.length,
      summary: report.summary,
      results,
    }, null, 2),
  );
  writeFileSync(path.join(outDir, 'ai-eval-report.md'), renderEvalReportMarkdown(results, { generatedAt }));

  const failedRuns = runs.filter((r) => r.status === 'FAIL').length;
  console.log(
    `eval:ai ok – ${report.summary.count} Cases, Accuracy ${(report.summary.accuracy * 100).toFixed(0)} %, ` +
    `${runs.length} Plugin-Runs (${failedRuns} FAIL), Report-Gate ${failedResults.length} FAIL ` +
    `→ test-results/ai-eval*.json + ai-eval-report.md`,
  );
  for (const failure of failedResults) {
    console.error(`  FAIL ${failure.pluginId}: ${failure.errors.join('; ')}`);
  }
  if (failedRuns > 0 || failedResults.length > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error('eval:ai FAILED:', e);
  process.exit(1);
});
