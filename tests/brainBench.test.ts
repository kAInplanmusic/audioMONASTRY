/**
 * RT-AUDIT-P1-015 · benchmark-brain: TTFT warm + sauberes BLOCKIERT ohne Live-Endpunkt.
 */
import { describe, expect, it } from 'vitest';
import { BRAIN_TTFT_WARM_LIMIT_MS, brainBenchPreflight, summarizeTtft } from '../src/core/ai/orchestrator/brainBench';

describe('brainBenchPreflight', () => {
  it('meldet BLOCKED mit den fehlenden Variablen statt einen Wert zu erfinden', () => {
    const result = brainBenchPreflight({});
    expect(result.status).toBe('BLOCKED');
    if (result.status === 'BLOCKED') {
      expect(result.missing).toHaveLength(2);
      expect(result.reason).toContain('TTFT nicht messbar');
    }
    expect(brainBenchPreflight({ RP_BRAIN_OPENAI_URL: 'https://x/v1' }).status).toBe('BLOCKED');
  });

  it('ist READY mit URL + Key und nimmt das konfigurierte Modell', () => {
    const result = brainBenchPreflight({ RUNPOD_BRAIN_OPENAI_URL: 'https://x/openai/v1/', RP_AGENT_KEY: 'k', RUNPOD_BRAIN_OPENAI_MODEL: 'Qwen/Q' });
    expect(result).toEqual({ status: 'READY', target: { baseUrl: 'https://x/openai/v1', apiKey: 'k', model: 'Qwen/Q' } });
  });
});

describe('summarizeTtft', () => {
  it('Gate verlangt p50 UND p95 unter 300 ms', () => {
    const fast = Array.from({ length: 10 }, (_, i) => ({ ttftMs: 100 + i * 10, totalMs: 600 + i * 10, deltas: 51 }));
    const ok = summarizeTtft(fast);
    expect(ok).toMatchObject({ runs: 10, p50Ms: 140, p95Ms: 190, minMs: 100, maxMs: 190, limitMs: BRAIN_TTFT_WARM_LIMIT_MS, pass: true });
    expect(ok.tokensPerSecond).toBeCloseTo(100, 0);

    const tail = [...fast.slice(0, 9), { ttftMs: 900, totalMs: 1400, deltas: 51 }];
    expect(summarizeTtft(tail).pass).toBe(false); // ein langsamer Schwanz reicht
  });

  it('ohne Messung kein Pass', () => {
    expect(summarizeTtft([]).pass).toBe(false);
  });
});
