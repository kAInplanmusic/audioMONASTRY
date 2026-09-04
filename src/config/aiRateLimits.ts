/**
 * audioMONASTRY · AI-Rate-Limits (AITodo Phase 18)
 * =================================================
 * Explizite, zentral konfigurierbare AI_RATE_*-Limits für den Server.
 * Ohne gesetzte Env-Variablen gelten konservative Defaults (Kostenbremse).
 * Pure Resolver-Funktion → serverlos testbar.
 */

export interface AiRateLimitConfig {
  windowMs: number;
  max: number;
  expensiveWindowMs: number;
  expensiveMax: number;
  concurrencyMax: number;
}

export const AI_RATE_DEFAULTS: AiRateLimitConfig = {
  windowMs: 60 * 1000,
  max: 30,
  expensiveWindowMs: 60 * 1000,
  expensiveMax: 10,
  concurrencyMax: 4,
};

/** Liest AI_RATE_*-Env-Werte (Server) bzw. liefert Defaults (Browser/Tests). */
export function resolveAiRateLimits(env: Record<string, string | undefined> = {}): AiRateLimitConfig {
  const num = (key: string, fallback: number): number => {
    const raw = env[key];
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    windowMs: num('AI_RATE_WINDOW_MS', AI_RATE_DEFAULTS.windowMs),
    max: num('AI_RATE_MAX', AI_RATE_DEFAULTS.max),
    expensiveWindowMs: num('AI_RATE_EXPENSIVE_WINDOW_MS', AI_RATE_DEFAULTS.expensiveWindowMs),
    expensiveMax: num('AI_RATE_EXPENSIVE_MAX', AI_RATE_DEFAULTS.expensiveMax),
    concurrencyMax: num('AI_RATE_CONCURRENCY_MAX', AI_RATE_DEFAULTS.concurrencyMax),
  };
}
