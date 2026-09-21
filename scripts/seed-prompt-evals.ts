/**
 * GAP-5: Seed-Generator für system_prompts/plugin_prompt_versions (DB-ready).
 * Schreibt zusätzlich den Rollen-Abdeckungsbericht:
 *   - test-results/system-prompts-seed.json  (DB-ready Zeilen)
 *   - test-results/prompt-coverage.json      (Rollen × Systemprompt/Few-Shots/
 *                                             MCP-Tools/Eval-Fälle/Min-Score/Status)
 * Aufruf: npx tsx scripts/seed-prompt-evals.ts   (kein Modellaufruf, offline)
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { buildPromptEvalSeed, promptSeedSummary } from '../src/core/ai/orchestrator/promptSeed';
import {
  coverageTotals,
  formatCoverageTable,
  roleCoverageGaps,
  roleCoverageRows,
} from '../src/core/ai/orchestrator/promptRoles';

const seed = buildPromptEvalSeed();
const outDir = path.resolve(process.cwd(), 'test-results');
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, 'system-prompts-seed.json'), JSON.stringify(seed, null, 2));

const rows = roleCoverageRows();
const totals = coverageTotals(rows);
const gaps = roleCoverageGaps();
const summary = promptSeedSummary();

writeFileSync(
  path.join(outDir, 'prompt-coverage.json'),
  JSON.stringify({ generatedAt: new Date().toISOString(), totals, gaps, rows }, null, 2),
);

console.log(
  `prompt-eval-seed ok – ${seed.system_prompts.length} system_prompts, ` +
  `${seed.plugin_prompt_versions.length} plugin_prompt_versions → test-results/system-prompts-seed.json`,
);
console.log(
  `prompt-coverage – ${totals.rollen} Rollen (${summary.pluginRollen} Plugin-Rollen + Planer + Bild/Video), ` +
  `${totals.systemprompts} Systemprompts, ${totals.fewShots} Few-Shots, ${totals.mcpTools} MCP-Tools, ` +
  `${totals.evalCases} Eval-Fälle, ${totals.mitMatrixGate} mit Matrix-Gate, ${totals.unchecked} UNCHECKED ` +
  '→ test-results/prompt-coverage.json',
);
console.log(formatCoverageTable(rows));
if (gaps.length > 0) {
  console.error(`ABDECKUNGS-LÜCKEN (${gaps.length}):\n  ${gaps.join('\n  ')}`);
  process.exitCode = 1;
}
