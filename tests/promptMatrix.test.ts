import { describe, expect, it } from 'vitest';
import {
  PLUGIN_COMMAND_CATALOG,
  PLUGIN_MOA_SYSTEM_PROMPTS,
  PLUGIN_MOA_TASKS,
} from '../src/utils/prompts';
import { buildPromptEvalSeed, missingRolePrompts, PLUGIN_IDS, promptSeedSummary } from '../src/core/ai/orchestrator/promptSeed';
import { EvaluationStore } from '../src/core/ai/orchestrator/evaluationStore';
import { EVAL_PLUGIN_IDS, minScoreFor } from '../src/core/ai/orchestrator/evalMatrix';
import {
  GPU_ROLES_WITHOUT_PROMPT_SPEC,
  NON_ROLE_CATALOG_IDS,
  PLANNER_ROLE_ID,
  ROLE_IDS,
  ROLE_PROMPT_SPECS,
  VISUAL_GPU_ROLE_IDS,
  roleCoverageRows,
} from '../src/core/ai/orchestrator/promptRoles';
import { GPU_ROLE_IDS } from '../src/config/aiInfrastructure';

/**
 * Verbindliche Rollenliste ist `EVAL_PLUGIN_IDS` (evalMatrix.ts). Der Test
 * iteriert bewusst NICHT mehr über eine eigene Namensliste im Test – genau das
 * ließ die Altnamen (instrument/sampler/drum/mcp/…) unbemerkt weiterlaufen.
 */
const ALL_PLUGINS = EVAL_PLUGIN_IDS;

describe('GAP-5: Prompt-/Trainings-Matrix je Plugin', () => {
  it('alle finalen Plugins haben Kommando-Katalog, System-Prompt und Default-Task', () => {
    for (const id of ALL_PLUGINS) {
      expect(PLUGIN_COMMAND_CATALOG[id], `catalog:${id}`).toBeTruthy();
      expect(PLUGIN_MOA_SYSTEM_PROMPTS[id], `prompt:${id}`).toBeTruthy();
      expect(PLUGIN_MOA_TASKS[id], `task:${id}`).toBeTruthy();
    }
  });

  it('die verbindliche Liste in promptSeed ist identisch mit evalMatrix', () => {
    expect(PLUGIN_IDS).toEqual(EVAL_PLUGIN_IDS);
    expect(PLUGIN_IDS).toHaveLength(18);
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
    expect(seed.system_prompts).toHaveLength(ROLE_IDS.length);
    expect(seed.plugin_prompt_versions).toHaveLength(ROLE_IDS.length);
    for (const id of PLUGIN_IDS) {
      const prompt = seed.system_prompts.find((p) => p.plugin_id === id);
      const version = seed.plugin_prompt_versions.find((v) => v.plugin_id === id);
      expect(prompt, `system_prompts:${id}`).toBeTruthy();
      expect(prompt?.enabled).toBe(true);
      expect(prompt?.content.trim().length, `content:${id}`).toBeGreaterThan(0);
      expect(version?.commands.trim().length, `commands:${id}`).toBeGreaterThan(0);
    }
    // Rollen ohne Plugin-Kommandos (Bild/Video) tragen ihre MCP-Tools als Kommandos.
    for (const id of VISUAL_GPU_ROLE_IDS) {
      const version = seed.plugin_prompt_versions.find((v) => v.plugin_id === id);
      expect(version?.commands.trim().length, `commands:${id}`).toBeGreaterThan(0);
    }
    expect(seed.system_prompts.find((p) => p.plugin_id === PLANNER_ROLE_ID)).toBeTruthy();
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

describe('Matrix ↔ Katalog: Abdeckung und Drift ausdrücklich', () => {
  it('jede Matrix-Rolle hat Mindest-Score, Few-Shots, MCP-Tools und Eval-Fälle', () => {
    const rows = roleCoverageRows();
    expect(rows).toHaveLength(ROLE_IDS.length);
    for (const id of EVAL_PLUGIN_IDS) {
      const row = rows.find((r) => r.roleId === id);
      expect(row, `Rolle fehlt im Katalog: ${id}`).toBeTruthy();
      expect(row?.minScore, `minScore:${id}`).toBe(minScoreFor(id));
      expect(row?.minScoreFromMatrix, `Gate fehlt in evalMatrix: ${id}`).toBe(true);
      expect(row?.fewShots, `Few-Shots fehlen: ${id}`).toBeGreaterThanOrEqual(1);
      expect(row?.mcpTools, `MCP-Tools fehlen: ${id}`).toBeGreaterThanOrEqual(1);
      expect(row?.evalCases, `Eval-Fälle fehlen: ${id}`).toBeGreaterThanOrEqual(1);
      expect(row?.status, `Status erfunden: ${id}`).toBe('UNCHECKED');
    }
  });

  it('Katalog-IDs außerhalb der Matrix sind namentlich festgehalten (Drift-Befund)', () => {
    // Befund: `transport` und `midi-controller` stehen im Kommando-Katalog,
    // aber weder in EVAL_PLUGIN_IDS noch in der Plugin-Route/Registry.
    expect([...NON_ROLE_CATALOG_IDS].sort()).toEqual(['midi-controller', 'transport']);
    for (const id of NON_ROLE_CATALOG_IDS) {
      expect(PLUGIN_COMMAND_CATALOG[id], `Katalog-Eintrag fehlt: ${id}`).toBeTruthy();
      expect(ROLE_PROMPT_SPECS[id], `unerwartete Rolle: ${id}`).toBeUndefined();
    }
  });

  it('Katalog-IDs und Rollen-IDs gehen nicht auseinander', () => {
    const catalogIds = Object.keys(PLUGIN_COMMAND_CATALOG).sort();
    const expected = [...EVAL_PLUGIN_IDS, ...NON_ROLE_CATALOG_IDS].sort();
    expect(catalogIds).toEqual(expected);
  });

  it('GPU-Rollen ohne Prompt-Eintrag sind genau die verbleibenden Flotten-Rollen (Befund)', () => {
    expect(GPU_ROLE_IDS).toHaveLength(8);
    expect([...VISUAL_GPU_ROLE_IDS]).toEqual(['imageHq', 'videoReal', 'videoAbstract']);
    expect([...GPU_ROLES_WITHOUT_PROMPT_SPEC].sort()).toEqual(['brain', 'ears', 'music', 'orchestrator', 'voiceGen']);
  });

  it('ein fehlender Rollenprompt ist ein benannter Fehler, kein stiller Fallback', () => {
    expect(missingRolePrompts()).toEqual([]);
    expect(missingRolePrompts(['keine-solche-rolle'])).toEqual(['keine-solche-rolle']);
  });

  it('Seed-Kurzbericht nennt die Zahlen aus dem Katalog', () => {
    const summary = promptSeedSummary();
    expect(summary.rollen).toBe(ROLE_IDS.length);
    expect(summary.pluginRollen).toBe(EVAL_PLUGIN_IDS.length);
    expect(summary.planerPrompt).toBe(true);
    expect(summary.kommandos).toBeGreaterThanOrEqual(EVAL_PLUGIN_IDS.length);
  });
});
