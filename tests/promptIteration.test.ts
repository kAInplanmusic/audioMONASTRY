// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PromptStore } from '../src/core/ai/orchestrator/promptStore';
import { EvaluationStore } from '../src/core/ai/orchestrator/evaluationStore';
import {
  evaluatePlanEffect,
  evaluatePlanEffectWithDetails,
  evaluatePromptCoverage,
  optimizePromptContent,
  runPromptIteration,
  type PlanCompleteFn,
} from '../src/core/ai/orchestrator/promptIteration';
import { PLUGIN_COMMAND_CATALOG } from '../src/utils/prompts';
import { EVAL_PLUGIN_IDS } from '../src/core/ai/orchestrator/evalMatrix';
import { ROLE_PROMPT_SPECS } from '../src/core/ai/orchestrator/promptRoles';
import { __resetAiGate, setAiOperatingMode } from '../src/core/ai/aiGate';

/**
 * INFRA-AI-002: Der Loop mass frueher, ob Kommando-NAMEN im Prompt stehen – und
 * der Optimierer schrieb genau diese Namen hinein. Er konvergierte deshalb
 * garantiert auf 1.0, ohne je ein Modell zu fragen. Diese Tests halten fest,
 * dass jetzt die ANTWORT des Modells bewertet wird und dass ein schlechter
 * Prompt den Loop NICHT auf 1.0 bringt.
 */
function freshStores() {
  return { prompts: new PromptStore(), evals: new EvaluationStore() };
}

/** Modell, das nur mit vollstaendiger Rolle (Kommando-Katalog im Prompt) korrekt plant. */
function catalogAwareModel(pluginId: string): PlanCompleteFn {
  const first = String(PLUGIN_COMMAND_CATALOG[pluginId] ?? 'status').split(',')[0].split('(')[0].trim();
  return async ({ prompt }) => {
    const knowsCommands = /## Allowed commands/.test(prompt) || prompt.includes(`${pluginId}: `);
    return {
      text: knowsCommands ? JSON.stringify({ pluginId, command: first }) : 'Klar, ich mache das irgendwie.',
      provider: 'test-modell',
      model: 'scripted',
    };
  };
}

/**
 * Modell, das IMMER ein ungueltiges Kommando nennt (Negativ-Fall) - richtiges
 * Plugin, Kommando nicht im Katalog.
 */
function alwaysWrongModelFor(pluginId: string): PlanCompleteFn {
  return async () => ({
    text: JSON.stringify({ pluginId, command: 'zaubern' }),
    provider: 'test-modell',
    model: 'scripted-falsch',
  });
}

describe('P3-2 + INFRA-AI-002: Prompt-Iterations-Loop mit Wirkungs-Metrik', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    __resetAiGate();
  });

  it('optimiert, bis das Modell die Kommandos wirklich benutzt (KEEP)', async () => {
    const { prompts, evals } = freshStores();
    const report = await runPromptIteration('mixer', {
      prompts,
      evals,
      complete: catalogAwareModel('mixer'),
    });

    expect(report.metric).toBe('plan-effect');
    expect(report.checked).toBe(true);
    expect(report.status).toBe('KEEP');
    expect(report.score).toBe(1);
    expect(report.iterations).toBe(2); // Runde 1 ohne Kommandos, Runde 2 mit
    expect(prompts.getActive('mixer')?.content).toContain('## Allowed commands');
    // Der Eval-Record nennt das echte Modell, nicht 'heuristic'.
    expect(evals.listByPlugin('mixer')[0].model).toBe('scripted');
    expect(evals.listByPlugin('mixer')[0].metrics.metric).toBe('plan-effect');
  });

  it('behält einen bereits wirksamen Prompt (KEEP nach einer Iteration)', async () => {
    const { prompts, evals } = freshStores();
    prompts.upsert('drumsampler', 'Drum-Agent. ## Allowed commands\ndrumsampler: kit(kit), pattern_random, trigger', { version: 1 });
    const report = await runPromptIteration('drumsampler', { prompts, evals, complete: catalogAwareModel('drumsampler') });
    expect(report.status).toBe('KEEP');
    expect(report.iterations).toBe(1);
    expect(report.promptVersion).toBe(1);
  });

  it('konvergiert bei einem schlechten Prompt NICHT auf 1.0 (Abnahmekriterium)', async () => {
    const { prompts, evals } = freshStores();
    const report = await runPromptIteration('eq', {
      prompts,
      evals,
      complete: alwaysWrongModelFor('eq'),
      maxIterations: 3,
    });

    expect(report.status).toBe('MAX_ITERATIONS');
    expect(report.score).toBeLessThan(1);
    expect(report.score).toBeCloseTo(0.2, 5); // Grade 1 ("Kommando nicht im Katalog") / 5
    expect(report.iterations).toBe(3);
    // Auch nach dem Anhaengen des Katalogs bleibt es falsch - die Metrik misst
    // die Modellantwort, nicht den Prompt-Text.
    expect(prompts.getActive('eq')?.content).toContain('## Allowed commands');
  });

  it('misst die Antwort, nicht den Prompt-Text (direkter Vergleich)', async () => {
    const goodPrompt = 'EQ-Agent. ## Allowed commands\neq: automate';
    const withModel = await evaluatePlanEffectWithDetails('eq', 1, goodPrompt, { complete: catalogAwareModel('eq') });
    expect(withModel.score).toBe(1);
    expect(withModel.grade.reason).toBe('Plan exakt');

    const withoutModel = await evaluatePlanEffect('eq', 1, goodPrompt, { complete: alwaysWrongModelFor('eq') });
    expect(withoutModel).toBeCloseTo(0.2, 5);
    // Gegenprobe: der alte Abdeckungs-Check sieht denselben Prompt als "perfekt".
    expect(evaluatePromptCoverage('eq', 1, goodPrompt)).toBe(1);
  });

  it('meldet UNCHECKED statt eines erfundenen Scores, wenn kein Modell antwortet', async () => {
    const { prompts, evals } = freshStores();
    const failing: PlanCompleteFn = async () => {
      throw new Error('LLM-Aufruf nach 1000 ms abgebrochen');
    };
    const report = await runPromptIteration('mixer', { prompts, evals, complete: failing });

    expect(report.status).toBe('UNCHECKED');
    expect(report.checked).toBe(false);
    expect(report.score).toBe(0);
    expect(String(report.skipReason)).toContain('Modellaufruf fehlgeschlagen');
    expect(evals.listByPlugin('mixer')).toHaveLength(0);
  });

  it('meldet UNCHECKED, wenn gar kein Provider erreichbar ist', async () => {
    const { prompts, evals } = freshStores();
    // Kein Modell, keine Keys, AI aus -> die Wirkungs-Metrik ist nicht messbar.
    setAiOperatingMode('off', { source: 'test' });
    const report = await runPromptIteration('mixer', { prompts, evals });
    expect(report.status).toBe('UNCHECKED');
    expect(report.checked).toBe(false);
    expect(report.score).toBe(0);
    expect(evals.listByPlugin('mixer')).toHaveLength(0);
  });

  it('stoppt nach maxIterations, wenn der Evaluator nie grün wird', async () => {
    const { prompts, evals } = freshStores();
    const report = await runPromptIteration('eq', {
      prompts,
      evals,
      maxIterations: 2,
      evaluate: () => 0,
    });
    expect(report.status).toBe('MAX_ITERATIONS');
    expect(report.iterations).toBe(2);
    expect(report.score).toBe(0);
    expect(report.metric).toBe('coverage-selfcheck');
  });

  it('evaluatePromptCoverage bleibt als Offline-Vorpruefung erhalten (kein Gate)', () => {
    expect(evaluatePromptCoverage('mixer', 1, 'You are the mix agent.')).toBe(0);
    expect(evaluatePromptCoverage('mixer', 1, 'Nutze gain(db)')).toBeCloseTo(1 / 3, 5);
    expect(evaluatePromptCoverage('mixer', 1, 'Nutze gain(db), fade_in_main und channel')).toBe(1);
    expect(evaluatePromptCoverage('unbekannt', 1, 'egal')).toBe(0);
  });

  it('optimizePromptContent hängt den Kommando-Katalog genau einmal an', () => {
    const once = optimizePromptContent('syntisampler', 'You are the synth agent.');
    expect(once).toContain('## Allowed commands');
    expect(once).toContain('syntisampler: note(freq)');
    const twice = optimizePromptContent('syntisampler', once);
    expect(twice).toBe(once);
  });

  it('die Fehlerregel des Optimierers nennt nur Kommandos, die die Rolle kennt', () => {
    // `status` fehlt z. B. bei eq/dsp/instru/mixer/syntisampler – die alte
    // Universalregel („choose 'status'") war für 9 der 18 Rollen technisch falsch.
    for (const roleId of ['eq', 'dsp', 'instru', 'mixer', 'syntisampler', 'drumsampler', 'biblio', 'voice', 'spatial']) {
      const optimized = optimizePromptContent(roleId, 'Rollen-Satz.');
      expect(optimized, `${roleId} nennt 'status', obwohl es das Kommando nicht gibt`).not.toContain("choose 'status'");
      expect(optimized).toContain('## Error rule');
    }
    for (const roleId of ['drop', 'song', 'effect', 'sound', 'stem', 'master', 'record', 'ai', 'perfor']) {
      expect(optimizePromptContent(roleId, 'Rollen-Satz.'), roleId).toContain("choose 'status'");
    }
  });

  it('der Katalog-Rollenprompt (v2) wirkt in EINER Runde – für jede verbindliche Rolle', async () => {
    for (const roleId of EVAL_PLUGIN_IDS) {
      const { prompts, evals } = freshStores();
      prompts.upsert(roleId, ROLE_PROMPT_SPECS[roleId].systemPrompt, { version: ROLE_PROMPT_SPECS[roleId].version });
      const report = await runPromptIteration(roleId, { prompts, evals, complete: catalogAwareModel(roleId) });
      expect(report.status, `${roleId}: ${report.skipReason ?? ''}`).toBe('KEEP');
      expect(report.score, roleId).toBe(1);
      expect(report.iterations, `${roleId} brauchte mehr als eine Runde`).toBe(1);
      // Der Prompt wurde NICHT nachoptimiert (die Rolle war vollständig).
      expect(prompts.listVersions(roleId), `${roleId} wurde unnötig versioniert`).toHaveLength(1);
      expect(evals.listByPlugin(roleId)[0].metrics.metric).toBe('plan-effect');
    }
  });

  it('ein nackter Rollensatz braucht die Optimierung – der Unterschied ist messbar', async () => {
    const { prompts, evals } = freshStores();
    const report = await runPromptIteration('drop', { prompts, evals, complete: catalogAwareModel('drop') });
    expect(report.status).toBe('KEEP');
    expect(report.iterations).toBe(2); // Runde 1 ohne Kommandos, Runde 2 mit
  });

  it('läuft im coverage-Modus weiter offline (ausdruecklich als Vorpruefung)', async () => {
    const { prompts, evals } = freshStores();
    const report = await runPromptIteration('mixer', { prompts, evals, metric: 'coverage-selfcheck' });
    expect(report.metric).toBe('coverage-selfcheck');
    expect(report.status).toBe('KEEP');
    expect(report.score).toBe(1);
    expect(evals.listByPlugin('mixer')[0].provider).toBe('coverage-selfcheck');
    expect(String(evals.listByPlugin('mixer')[0].metrics.reason)).toMatch(/Vorpruefung/);
  });
});
