import { describe, expect, it } from 'vitest';
import { AI_RATE_DEFAULTS, resolveAiRateLimits } from '../src/config/aiRateLimits';

describe('AI-Rate-Limits (AITodo Phase 18)', () => {
  it('liefert konservative Defaults ohne Env', () => {
    expect(resolveAiRateLimits({})).toEqual(AI_RATE_DEFAULTS);
  });

  it('liest AI_RATE_*-Env-Werte', () => {
    const cfg = resolveAiRateLimits({
      AI_RATE_EXPENSIVE_WINDOW_MS: '120000',
      AI_RATE_EXPENSIVE_MAX: '3',
    });
    expect(cfg).toEqual({ expensiveWindowMs: 120000, expensiveMax: 3 });
  });

  it('ignoriert ungültige Werte', () => {
    const cfg = resolveAiRateLimits({ AI_RATE_EXPENSIVE_MAX: '-5' });
    expect(cfg.expensiveMax).toBe(AI_RATE_DEFAULTS.expensiveMax);
  });

  /**
   * QUAL-P2-007 (2026-09-23): Das Interface hatte fünf Felder, aber nur zwei
   * hatten einen Abnehmer. `AI_RATE_WINDOW_MS`, `AI_RATE_MAX` und
   * `AI_RATE_CONCURRENCY_MAX` wurden aus der Umgebung gelesen, von keiner
   * Produktionsdatei benutzt und sind deshalb entfernt worden.
   *
   * Dieser Test hält fest, dass die Variablen NICHTS mehr erzeugen. Er ist
   * absichtlich so geschrieben, dass er bei einem Wiederaufleben fehlschlägt:
   * Wer eines der Felder zurückholt, muss diesen Test bewusst ändern — und dabei
   * die Frage beantworten, wer das Feld dann durchsetzt. Genau das war der
   * Fehler: eine Env-Variable, die wie ein Schutz aussieht und keiner ist.
   */
  it('erzeugt keine Phantom-Felder aus den entfernten Env-Variablen', () => {
    const cfg = resolveAiRateLimits({
      AI_RATE_WINDOW_MS: '30000',
      AI_RATE_MAX: '15',
      AI_RATE_CONCURRENCY_MAX: '2',
    });
    expect(cfg).toEqual(AI_RATE_DEFAULTS);
    expect(Object.keys(cfg).sort()).toEqual(['expensiveMax', 'expensiveWindowMs']);
    expect(cfg).not.toHaveProperty('max');
    expect(cfg).not.toHaveProperty('windowMs');
    expect(cfg).not.toHaveProperty('concurrencyMax');
  });
});
