/**
 * audioMONASTRY · AI-Benchmark (aus AITodo Phase 21/22/23)
 * ==========================================================
 * Misst Cold-/Warm-/Switch-Latenz über den ProviderRouter.
 *
 *   npx tsx scripts/ai-benchmark.ts [task] [model] [iterations]
 *
 * Default: task=tts, model=local, iterations=5 (kein Netz nötig).
 * Live-Messung gegen HF-Endpoint:
 *   HF_ENDPOINT_URL=... HF_TOKEN=... npx tsx scripts/ai-benchmark.ts audio.classify ast-audioset 5
 */
import { ProviderRouter } from '../src/core/ai/orchestrator/providerRouter';
import { aiLogger } from '../src/core/ai/orchestrator/aiLogger';

async function main(): Promise<void> {
  const task = (process.argv[2] ?? 'tts') as Parameters<ProviderRouter['run']>[0];
  const model = process.argv[3] ?? 'local';
  const iterations = Number(process.argv[4] ?? 5);

  const router = new ProviderRouter();
  const candidates = router.candidates(task);
  console.log(`AI-Benchmark: task=${task} model=${model} iterations=${iterations}`);
  console.log(`Verfügbare Provider: ${candidates.map((p) => p.id).join(', ') || '(keine)'}`);

  const timings: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const started = performance.now();
    try {
      const res = await router.run(task, model, { text: `Benchmark-Input ${i}` });
      timings.push(performance.now() - started);
      aiLogger.info('ai-benchmark run', { task, model, provider: res.provider, durationMs: timings[timings.length - 1] });
    } catch (e) {
      aiLogger.warn('ai-benchmark failed', { task, model, error: (e as Error).message });
      timings.push(performance.now() - started);
    }
  }

  if (timings.length === 0) {
    console.log('Keine Messwerte.');
    return;
  }
  const cold = timings[0];
  const warm = timings.slice(1).reduce((a, b) => a + b, 0) / Math.max(1, timings.length - 1);
  const min = Math.min(...timings);
  const max = Math.max(...timings);
  console.log(`Cold (1. Call): ${cold.toFixed(1)} ms`);
  console.log(`Warm (Ø Call 2..n): ${warm.toFixed(1)} ms`);
  console.log(`Min/Max: ${min.toFixed(1)} / ${max.toFixed(1)} ms`);
}

main();
