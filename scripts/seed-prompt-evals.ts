/**
 * GAP-5: Seed-Generator für system_prompts/plugin_prompt_versions (DB-ready).
 * Schreibt `test-results/system-prompts-seed.json` – analog zu eval-ai.ts.
 * Aufruf: npx tsx scripts/seed-prompt-evals.ts
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { buildPromptEvalSeed } from '../src/core/ai/orchestrator/promptSeed';

const seed = buildPromptEvalSeed();
const outDir = path.resolve(process.cwd(), 'test-results');
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, 'system-prompts-seed.json'), JSON.stringify(seed, null, 2));

console.log(
  `prompt-eval-seed ok – ${seed.system_prompts.length} system_prompts, ` +
  `${seed.plugin_prompt_versions.length} plugin_prompt_versions → test-results/system-prompts-seed.json`,
);
