/**
 * P3-2: Prompt-Iterations-Loop über alle 21 Plugins (offline, deterministisch).
 * Aufruf: npx tsx scripts/iterate-prompts.ts
 * Schreibt test-results/prompt-iterations.json.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { runPromptIteration } from '../src/core/ai/orchestrator/promptIteration';
import { promptStore } from '../src/core/ai/orchestrator/promptStore';

const PLUGIN_IDS = [
  'masterplayer', 'instrument', 'synthesizer', 'drum', 'sampler', 'mcp', 'voice', 'sound',
  'mixer', 'controller', 'effect', 'drop', 'library', 'eq', 'dsp', 'mastering', 'stem',
  'spatial', 'recording', 'performance', 'ai',
];

async function main(): Promise<void> {
  const reports = PLUGIN_IDS.map((pluginId) => runPromptIteration(pluginId));
  const outDir = path.resolve(process.cwd(), 'test-results');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, 'prompt-iterations.json'), JSON.stringify({ reports, prompts: promptStore.exportJson().prompts }, null, 2));

  const maxed = reports.filter((r) => r.status === 'MAX_ITERATIONS').length;
  console.log(
    `prompt-iteration ok – ${reports.length} Plugins, ${reports.reduce((s, r) => s + r.iterations, 0)} Iterationen, ` +
    `${maxed} nicht konvergiert → test-results/prompt-iterations.json`,
  );
  if (maxed > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error('prompt-iteration FAILED:', e);
  process.exit(1);
});
