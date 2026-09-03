/**
 * P3-2 / GAP-5: Prompt-Iterations-Loop über alle 21 Plugins (offline,
 * deterministisch) inklusive DB-ready Export der Systemprompt-Versionen.
 * Aufruf: npx tsx scripts/iterate-prompts.ts
 * Schreibt test-results/prompt-iterations.json und test-results/system-prompts.json
 * und persistiert bei konfiguriertem Supabase in `system_prompts` /
 * `plugin_prompt_versions` (sonst No-Op).
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { runPromptIteration } from '../src/core/ai/orchestrator/promptIteration';
import { promptStore } from '../src/core/ai/orchestrator/promptStore';
import { aiPersistence } from '../src/core/ai/orchestrator/aiPersistence';
import { EVAL_PLUGIN_IDS } from '../src/core/ai/orchestrator/evalMatrix';

const PLUGIN_IDS = [...EVAL_PLUGIN_IDS];

async function main(): Promise<void> {
  const reports = PLUGIN_IDS.map((pluginId) => runPromptIteration(pluginId));
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

  const missing = PLUGIN_IDS.filter((id) => !prompts.some((p) => p.pluginId === id));
  const maxed = reports.filter((r) => r.status === 'MAX_ITERATIONS').length;
  console.log(
    `prompt-iteration ok – ${reports.length} Plugins, ${reports.reduce((s, r) => s + r.iterations, 0)} Iterationen, ` +
    `${maxed} nicht konvergiert, ${promptRows.length} Prompt-Versionen → test-results/prompt-iterations.json, system-prompts.json`,
  );
  if (missing.length > 0) console.error(`  FEHLT: Prompt-Version für ${missing.join(', ')}`);
  if (maxed > 0 || missing.length > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error('prompt-iteration FAILED:', e);
  process.exit(1);
});
