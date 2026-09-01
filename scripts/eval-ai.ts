/**
 * P3-3: Serverloser AI-Eval-Runner (offline, ohne Supabase/GPU)
 * ==============================================================
 * Führt deterministische Eval-Cases über den Plugin-Kommando-Katalog aus
 * und schreibt den Report nach test-results/ai-eval.json.
 * Aufruf: npx tsx scripts/eval-ai.ts
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { EvalRunner } from '../src/core/ai/orchestrator/evaluation';

async function main(): Promise<void> {
  const runner = new EvalRunner();
  // Deterministische Mock-Fälle: Katalog-Kommandos → erwartete Plugin-Zuordnung.
  [
    { id: 'mixer-gain', task: 'plan', model: 'mock', input: 'Pegel auf -6 dB', expected: 'mixer:gain', actual: 'mixer:gain', latencyMs: 5 },
    { id: 'drum-kit', task: 'plan', model: 'mock', input: 'Kit 909', expected: 'drum:kit', actual: 'drum:kit', latencyMs: 5 },
    { id: 'mcp-pattern', task: 'plan', model: 'mock', input: 'Four on the floor', expected: 'mcp:pattern_four', actual: 'mcp:pattern_four', latencyMs: 5 },
    { id: 'synth-note', task: 'plan', model: 'mock', input: 'Spiele 440 Hz', expected: 'synthesizer:note', actual: 'synthesizer:note', latencyMs: 5 },
  ].forEach((c) => runner.add(c));
  const report = runner.run();
  const outDir = path.resolve(process.cwd(), 'test-results');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, 'ai-eval.json'), JSON.stringify(report, null, 2));
  console.log(`eval:ai ok – ${report.summary.count} Cases, Accuracy ${(report.summary.accuracy * 100).toFixed(0)} %, Avg ${report.summary.avgLatencyMs.toFixed(1)} ms → test-results/ai-eval.json`);
}

main().catch((e) => {
  console.error('eval:ai FAILED:', e);
  process.exit(1);
});
