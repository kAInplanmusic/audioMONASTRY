/**
 * audioMONASTRY · Brain-Benchmark-Gate (AI-P1-003 P3)
 * =====================================================
 * Fährt einen ECHTEN MCP-Planungskorpus gegen den RunPod-Brain
 * (Qwen3 über den vLLM-OpenAI-Pfad, weil der vLLM-Worker unser
 * `{task, model, input}`-Protokoll nicht versteht).
 *
 * Korpus: der Plugin-Kommando-Katalog (`PLUGIN_COMMAND_CATALOG`) – 49 echte
 * Kommandos über die 20 Plugin-MONKs – je in DE und EN = 98 Fälle. Nichts
 * davon ist erfunden; es sind exakt die Kommandos, die der Agent später
 * ausführen muss.
 *
 * Bewertung (deterministisch, reproduzierbar):
 *   +3  das Plugin wird im Plan benannt
 *   +2  das Kommando wird im Plan benannt
 *   → 5 = korrekt, sonst 0..3. Gate je Plugin: Mindest-Score aus
 *     `PLUGIN_EVAL_MATRIX` (Default 4) + Dauer-Budget.
 *
 * Persistenz: je Fall in `ai_evaluations`, je Plugin in `ai_eval_runs`
 * (Supabase konfiguriert → real, sonst No-Op). Report unter
 * `test-results/brain-benchmark*.json|md`.
 *
 * Aufruf:  npx tsx scripts/benchmark-brain.ts
 *          BRAIN_BENCH_LIMIT=4 npx tsx scripts/benchmark-brain.ts   (Teillauf)
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  EVAL_PLUGIN_IDS,
  gradePluginResult,
  renderEvalReportMarkdown,
  type PluginEvalResult,
} from '../src/core/ai/orchestrator/evalMatrix';
import { evaluationStore } from '../src/core/ai/orchestrator/evaluationStore';
import { aiPersistence } from '../src/core/ai/orchestrator/aiPersistence';
import { PLUGIN_COMMAND_CATALOG } from '../src/utils/prompts';

interface CaseSpec {
  pluginId: string;
  command: string;
  language: 'DE' | 'EN';
  prompt: string;
}

function commandsOf(pluginId: string): string[] {
  return String(PLUGIN_COMMAND_CATALOG[pluginId] ?? '')
    .split(',')
    .map((c) => c.trim().split('(')[0].trim())
    .filter(Boolean);
}

function buildCases(): CaseSpec[] {
  const cases: CaseSpec[] = [];
  for (const pluginId of EVAL_PLUGIN_IDS) {
    for (const command of commandsOf(pluginId)) {
      cases.push({
        pluginId,
        command,
        language: 'DE',
        prompt: `Du planst Aktionen in einem Musikstudio. Erstelle einen Plan für Plugin "${pluginId}", Kommando "${command}". Antworte ausschließlich mit JSON: {"plugin":"${pluginId}","command":"${command}","steps":[]}`,
      });
      cases.push({
        pluginId,
        command,
        language: 'EN',
        prompt: `You plan actions in a music studio. Create a plan for plugin "${pluginId}", command "${command}". Answer only with JSON: {"plugin":"${pluginId}","command":"${command}","steps":[]}`,
      });
    }
  }
  return cases;
}

function env(name: string): string {
  return (process.env[name] ?? '').trim();
}

/** Deterministisches Brain-Scoring: Plugin (+3) und Kommando (+2) benannt. */
function scorePlan(pluginId: string, command: string, text: string): number {
  const t = (text ?? '').toLowerCase();
  const pluginHit = t.includes(pluginId.toLowerCase());
  const commandHit = t.includes(command.toLowerCase());
  return (pluginHit ? 3 : 0) + (commandHit ? 2 : 0);
}

async function askBrain(prompt: string, signal: AbortSignal): Promise<{ text: string; latencyMs: number }> {
  const base = env('RUNPOD_BRAIN_OPENAI_URL').replace(/\/+$/, '');
  const key = env('RUNPOD_API_KEY') || env('RP_API_KEY');
  const model = env('RUNPOD_BRAIN_MODEL') || 'Qwen/Qwen3-14B-AWQ';
  if (!base || !key) throw new Error('RUNPOD_BRAIN_OPENAI_URL / RUNPOD_API_KEY fehlen');
  const started = performance.now();
  const resp = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 120,
      temperature: 0,
      // vLLM reicht das an das Qwen3-Chat-Template durch (kein <think>-Block) –
      // konsistent mit fleetWake.ts und LlmRouter.ts.
      chat_template_kwargs: { enable_thinking: false },
    }),
    signal,
  });
  if (!resp.ok) throw new Error(`Brain HTTP ${resp.status}: ${(await resp.text().catch(() => '')).slice(0, 200)}`);
  const payload = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const text = payload.choices?.[0]?.message?.content ?? '';
  return { text, latencyMs: performance.now() - started };
}

async function main(): Promise<void> {
  const all = buildCases();
  const limit = Number(process.env.BRAIN_BENCH_LIMIT ?? 0);
  const cases = limit > 0 ? all.slice(0, limit) : all;
  console.log(`[brain-bench] Korpus: ${all.length} Fälle (${cases.length} in diesem Lauf), `
    + `${commandsOf('mixer').length} Kommandos allein für mixer`);

  const perPlugin = new Map<string, { worstScore: number; maxDurationMs: number; errors: string[]; count: number }>();
  for (const pluginId of EVAL_PLUGIN_IDS) {
    perPlugin.set(pluginId, { worstScore: 5, maxDurationMs: 0, errors: [], count: 0 });
  }

  // Kaltstart VOR der Messung abkochen. Ohne diesen Schritt zahlt der ERSTE
  // Fall (mixer/gain DE) den Scale-to-Zero-Kaltstart des vLLM-Workers (~158 s,
  // live belegt) und scheitert am 120-s-Fall-Timeout - das Gate würde
  // Kaltstart-Glück statt Modellqualität messen.
  console.log('[brain-bench] warmup (Kaltstart vor der Messung) …');
  const warmStarted = performance.now();
  await askBrain('Warmup. Antworte mit "ok".', AbortSignal.timeout(600_000));
  console.log(`[brain-bench] warmup ok in ${Math.round(performance.now() - warmStarted)} ms`);

  let done = 0;
  for (const c of cases) {
    const entry = perPlugin.get(c.pluginId)!;
    try {
      const { text, latencyMs } = await askBrain(c.prompt, AbortSignal.timeout(120_000));
      const score = scorePlan(c.pluginId, c.command, text);
      const record = evaluationStore.record({
        pluginId: c.pluginId,
        task: 'plan',
        promptVersion: 1,
        model: env('RUNPOD_BRAIN_MODEL') || 'Qwen/Qwen3-14B-AWQ',
        provider: 'runpod-brain',
        input: c.prompt,
        output: text.slice(0, 2000),
        score,
        metrics: { latencyMs: Number(latencyMs.toFixed(1)), exactMatch: score === 5 },
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
      entry.count += 1;
      entry.worstScore = Math.min(entry.worstScore, score);
      entry.maxDurationMs = Math.max(entry.maxDurationMs, latencyMs);
      done += 1;
      if (score < 5) {
        entry.errors.push(`${c.language}/${c.command}: score ${score} (${text.slice(0, 80).replace(/\n/g, ' ')})`);
      }
      console.log(`[brain-bench] ${done}/${cases.length} ${c.pluginId}/${c.command} (${c.language}) score=${score} ${latencyMs.toFixed(0)}ms`);
    } catch (e) {
      entry.count += 1;
      entry.worstScore = 0;
      entry.errors.push(`${c.language}/${c.command}: ${(e as Error).message}`);
      done += 1;
      console.warn(`[brain-bench] ${done}/${cases.length} ${c.pluginId}/${c.command} (${c.language}) FEHLER ${(e as Error).message}`);
    }
  }

  const results: PluginEvalResult[] = [];
  for (const pluginId of EVAL_PLUGIN_IDS) {
    const entry = perPlugin.get(pluginId)!;
    if (entry.count === 0) continue;
    results.push(gradePluginResult({
      pluginId,
      score: entry.worstScore,
      durationMs: entry.maxDurationMs,
      errors: entry.errors.length > 3 ? entry.errors.slice(0, 3).concat([`… ${entry.errors.length - 3} weitere`]) : entry.errors,
    }));
  }

  const outDir = path.resolve(process.cwd(), 'test-results');
  mkdirSync(outDir, { recursive: true });
  const generatedAt = new Date().toISOString();
  const failed = results.filter((r) => r.status === 'FAIL');
  writeFileSync(path.join(outDir, 'brain-benchmark.json'), JSON.stringify({ generatedAt, cases: cases.length, failed: failed.length, results }, null, 2));
  writeFileSync(path.join(outDir, 'brain-benchmark-report.md'), renderEvalReportMarkdown(results, { generatedAt }).replace('AI-Eval-Report (P3-3)', 'Brain-Benchmark-Report (AI-P1-003 P3)'));

  console.log(`\n[brain-bench] ${cases.length} Fälle, ${results.length} Plugin-Runs, ${failed.length} FAIL`);
  for (const f of failed) console.error(`  FAIL ${f.pluginId}: ${f.errors.join('; ')}`);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((e: unknown) => {
  console.error('benchmark-brain fehlgeschlagen:', (e as Error).message);
  process.exit(1);
});
