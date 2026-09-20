/**
 * P3-2 / GAP-5 + INFRA-AI-002: Prompt-Iterations-Loop über die Plugin-IDs.
 *
 * Modi:
 *   --mode=effect   (Default) Der Prompt wird in seiner Version an ein ECHTES
 *                   Modell geschickt; bewertet wird die ANTWORT gegen den
 *                   Kommando-Katalog (evalGrading). Ohne erreichbares Modell
 *                   meldet der Lauf `UNCHECKED` – es wird kein Score erfunden.
 *   --mode=coverage Der alte, deterministische Abdeckungs-Check (nur Prompt-Text).
 *                   Ausdrücklich als Vorpruefung gekennzeichnet: der Optimierer
 *                   schreibt die Kommando-Namen selbst in den Prompt, deshalb
 *                   taugt diese Zahl NICHT als Wirkungsmaß (Audit INFRA-AI-002).
 *
 * Aufruf: npx tsx scripts/iterate-prompts.ts [--mode=effect|coverage] [--require-model] [--plugins=a,b]
 * Schreibt test-results/prompt-iterations.json und test-results/system-prompts.json
 * und persistiert bei konfiguriertem Supabase in `system_prompts` /
 * `plugin_prompt_versions` (sonst No-Op).
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { runPromptIteration, type PromptIterationMetric } from '../src/core/ai/orchestrator/promptIteration';
import { promptStore } from '../src/core/ai/orchestrator/promptStore';
import { aiPersistence } from '../src/core/ai/orchestrator/aiPersistence';
import { EVAL_PLUGIN_IDS } from '../src/core/ai/orchestrator/evalMatrix';

const ALL_PLUGIN_IDS = [...EVAL_PLUGIN_IDS];

interface IterateOptions {
  /** CLI-Modus; `coverage` entspricht der Metrik `coverage-selfcheck`. */
  mode: 'effect' | 'coverage';
  metric: PromptIterationMetric;
  requireModel: boolean;
  plugins: string[];
}

function parseOptions(argv: string[]): IterateOptions {
  const modeArg = argv.find((a) => a.startsWith('--mode='))?.slice('--mode='.length)
    ?? process.env.AI_ITERATE_MODE
    ?? 'effect';
  if (modeArg !== 'effect' && modeArg !== 'coverage') {
    throw new Error(`unbekannter Modus '${modeArg}' (erlaubt: effect, coverage)`);
  }
  const pluginsArg = argv.find((a) => a.startsWith('--plugins='))?.slice('--plugins='.length);
  const requested = (pluginsArg ?? process.env.AI_ITERATE_PLUGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const unknown = requested.filter((id) => !(ALL_PLUGIN_IDS as readonly string[]).includes(id));
  if (unknown.length > 0) {
    throw new Error(`unbekannte Plugin-IDs: ${unknown.join(', ')} (erlaubt: ${ALL_PLUGIN_IDS.join(', ')})`);
  }
  return {
    mode: modeArg,
    metric: modeArg === 'coverage' ? 'coverage-selfcheck' : 'plan-effect',
    requireModel: argv.includes('--require-model') || process.env.AI_ITERATE_REQUIRE_MODEL === '1',
    plugins: requested.length > 0 ? requested : ALL_PLUGIN_IDS,
  };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  console.log(
    options.mode === 'coverage'
      ? `iterate:prompts – Modus coverage · ${options.plugins.length} Plugins, Abdeckungs-Vorpruefung (offline, keine Modellwirkung)`
      : `iterate:prompts – Modus effect · ${options.plugins.length} Plugins, Wirkungs-Metrik (echtes Modell)`,
  );

  const reports = [];
  for (const pluginId of options.plugins) {
    reports.push(await runPromptIteration(pluginId, { metric: options.metric }));
  }

  const outDir = path.resolve(process.cwd(), 'test-results');
  mkdirSync(outDir, { recursive: true });
  const { prompts } = promptStore.exportJson();
  writeFileSync(path.join(outDir, 'prompt-iterations.json'), JSON.stringify({ reports, prompts }, null, 2));

  // GAP-5: Je Plugin mindestens eine Prompt-Version DB-ready ablegen.
  const promptRows = prompts.map((p) => ({
    plugin_id: p.pluginId,
    role: p.role,
    version: p.version,
    content: p.content,
    enabled: p.enabled,
    meta: p.meta,
  }));
  writeFileSync(path.join(outDir, 'system-prompts.json'), JSON.stringify(promptRows, null, 2));

  for (const prompt of prompts) {
    await aiPersistence.saveSystemPrompt({
      pluginId: prompt.pluginId,
      role: prompt.role,
      version: prompt.version,
      content: prompt.content,
      enabled: prompt.enabled,
      meta: prompt.meta,
    });
  }
  for (const report of reports) {
    await aiPersistence.savePromptVersion({
      pluginId: report.pluginId,
      version: report.promptVersion,
      changelog: report.changelog.join(' | ') || 'Initial-Prompt',
    });
  }

  const missing = options.plugins.filter((id) => !prompts.some((p) => p.pluginId === id));
  const maxed = reports.filter((r) => r.status === 'MAX_ITERATIONS').length;
  const unchecked = reports.filter((r) => r.status === 'UNCHECKED');
  console.log(
    `iterate:prompts ok – ${reports.length} Plugins, ${reports.reduce((s, r) => s + r.iterations, 0)} Iterationen, ` +
    `${maxed} nicht konvergiert, ${unchecked.length} nicht geprüft, ${promptRows.length} Prompt-Versionen ` +
    '→ test-results/prompt-iterations.json, system-prompts.json',
  );
  if (unchecked.length > 0) {
    console.warn(`  NICHT GEPRÜFT (${unchecked.length}): ${unchecked[0].skipReason ?? 'kein Modell erreichbar'}`);
  }
  for (const report of reports.filter((r) => r.status === 'MAX_ITERATIONS')) {
    console.error(`  NICHT KONVERGIERT ${report.pluginId}: Score ${report.score.toFixed(2)} nach ${report.iterations} Iterationen`);
  }
  if (missing.length > 0) console.error(`  FEHLT: Prompt-Version für ${missing.join(', ')}`);

  if (maxed > 0 || missing.length > 0) process.exitCode = 1;
  // Wie beim Eval-Runner: "nicht geprüft" ist standardmäßig kein Fehler (die
  // Flotte schläft meistens), mit --require-model aber sehr wohl.
  if (unchecked.length > 0 && options.requireModel) {
    console.error('iterate:prompts --require-model: kein Modell erreichbar → Gate rot');
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('prompt-iteration FAILED:', e);
  process.exit(1);
});
