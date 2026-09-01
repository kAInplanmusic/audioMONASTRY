import { describe, expect, it } from 'vitest';
import { AI_RATE_DEFAULTS, resolveAiRateLimits } from '../src/config/aiRateLimits';

describe('AI-Rate-Limits (AITodo Phase 18)', () => {
  it('liefert konservative Defaults ohne Env', () => {
    expect(resolveAiRateLimits({})).toEqual(AI_RATE_DEFAULTS);
  });

  it('liest AI_RATE_*-Env-Werte', () => {
    const cfg = resolveAiRateLimits({
      AI_RATE_WINDOW_MS: '30000',
      AI_RATE_MAX: '15',
      AI_RATE_EXPENSIVE_WINDOW_MS: '120000',
      AI_RATE_EXPENSIVE_MAX: '3',
      AI_RATE_CONCURRENCY_MAX: '2',
    });
    expect(cfg).toEqual({ windowMs: 30000, max: 15, expensiveWindowMs: 120000, expensiveMax: 3, concurrencyMax: 2 });
  });

  it('ignoriert ungültige Werte', () => {
    const cfg = resolveAiRateLimits({ AI_RATE_MAX: 'kaputt', AI_RATE_EXPENSIVE_MAX: '-5' });
    expect(cfg.max).toBe(AI_RATE_DEFAULTS.max);
    expect(cfg.expensiveMax).toBe(AI_RATE_DEFAULTS.expensiveMax);
  });
});
