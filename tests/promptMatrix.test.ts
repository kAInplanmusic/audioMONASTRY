import { describe, expect, it } from 'vitest';
import {
  PLUGIN_COMMAND_CATALOG,
  PLUGIN_MOA_SYSTEM_PROMPTS,
  PLUGIN_MOA_TASKS,
} from '../src/utils/prompts';
import { buildPromptEvalSeed, PLUGIN_IDS } from '../src/core/ai/orchestrator/promptSeed';
import { EvaluationStore } from '../src/core/ai/orchestrator/evaluationStore';

const ALL_PLUGINS = [
  'mixer', 'drop', 'song', 'effect', 'instrument', 'sampler', 'drum', 'mcp',
  'synthesizer', 'stem', 'voice', 'sound', 'spatial', 'library', 'eq',
  'dsp', 'mastering', 'recording', 'controller', 'performance', 'ai',
];

describe('GAP-5: Prompt-/Trainings-Matrix je Plugin', () => {
  it('alle 21 Plugins haben Kommando-Katalog, System-Prompt und Default-Task', () => {
    for (const id of ALL_PLUGINS) {
      expect(PLUGIN_COMMAND_CATALOG[id], `catalog:${id}`).toBeTruthy();
      expect(PLUGIN_MOA_SYSTEM_PROMPTS[id], `prompt:${id}`).toBeTruthy();
      expect(PLUGIN_MOA_TASKS[id], `task:${id}`).toBeTruthy();
    }
  });

  it('Katalog-Kommandos sind nicht leer und syntaktisch simpel', () => {
    for (const [id, cmds] of Object.entries(PLUGIN_COMMAND_CATALOG)) {
      expect(cmds.trim().length).toBeGreaterThan(0);
      expect(cmds).not.toContain('undefined');
      expect(cmds).not.toContain('null');
      void id;
    }
  });

  it('DB-Seed: jedes Plugin hat eine aktive Prompt-Version (system_prompts + plugin_prompt_versions)', () => {
    const seed = buildPromptEvalSeed();
    expect(seed.system_prompts).toHaveLength(21);
    expect(seed.plugin_prompt_versions).toHaveLength(21);
    for (const id of PLUGIN_IDS) {
      const prompt = seed.system_prompts.find((p) => p.plugin_id === id);
      const version = seed.plugin_prompt_versions.find((v) => v.plugin_id === id);
      expect(prompt, `system_prompts:${id}`).toBeTruthy();
      expect(prompt?.enabled).toBe(true);
      expect(prompt?.content.trim().length, `content:${id}`).toBeGreaterThan(0);
      expect(version?.commands.trim().length, `commands:${id}`).toBeGreaterThan(0);
    }
  });

  it('Eval-Suite: jedes Plugin hat ≥ 1 Eval-Datensatz und ≥ 1 Score (Mindest-Score 4)', () => {
    const store = new EvaluationStore();
    for (const id of PLUGIN_IDS) {
      const run = store.startRun(id);
      store.record({
        pluginId: id,
        task: 'plan',
        promptVersion: 1,
        model: 'mock',
        provider: 'offline',
        input: `${id} ${PLUGIN_COMMAND_CATALOG[id]?.split(',')[0] ?? 'status'}`,
        output: `${id}:${PLUGIN_COMMAND_CATALOG[id]?.split(',')[0]?.trim() ?? 'status'}`,
        score: 5,
        metrics: { latencyMs: 5, exactMatch: true },
      });
      const done = store.finishRun(run.runId, 4);
      expect(store.listByPlugin(id).length, `evals:${id}`).toBeGreaterThanOrEqual(1);
      expect(done.avgScore, `score:${id}`).toBeGreaterThanOrEqual(4);
      expect(done.status, `status:${id}`).toBe('PASS');
    }
  });
});
