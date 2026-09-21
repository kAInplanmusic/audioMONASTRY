// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/utils/audioEngine', () => ({
  audioEngine: { activatePlugin: vi.fn(), deactivatePlugin: vi.fn() },
  pluginAudioChannels: () => [],
}));

import {
  PLUGIN_COMMAND_CATALOG,
  PLUGIN_MOA_SYSTEM_PROMPTS,
  moaCommandCatalog,
  moaSystemPromptForPlugin,
  moaTaskForPlugin} from '../src/utils/prompts';
import { getPluginRegistry } from '../src/plugins/registry';
import { PLUGIN_ROUTE_IDS } from '../src/core/pluginAudioRouter';
import { EVAL_PLUGIN_IDS, minScoreFor } from '../src/core/ai/orchestrator/evalMatrix';
import {
  MAX_FEW_SHOTS_PER_ROLE,
  MOA_GLOBAL_SYSTEM_PROMPT,
  NEGATIVE_EVAL_COMMAND,
  PLANNER_ROLE_ID,
  ROLE_IDS,
  ROLE_PROMPT_SPECS,
  VISUAL_GPU_ROLE_IDS,
  commandNameOf,
  commandNamesFor,
  coverageTotals,
  roleCoverageGaps,
  roleCoverageRows,
} from '../src/core/ai/orchestrator/promptRoles';
import { buildPromptEvalSeed, missingRolePrompts, PROMPT_ROLE_IDS } from '../src/core/ai/orchestrator/promptSeed';
import { gradePlanAnswer } from '../src/core/ai/orchestrator/evalGrading';
import { createDefaultMcpRuntime } from '../src/core/ai/orchestrator/mcpRuntime';
import { MoaAgent } from '../src/core/ai/MoaAgent';
import { PromptStore, MOA_GLOBAL_PROMPT_KEY } from '../src/core/ai/orchestrator/promptStore';
import type { LlmCompletion, LlmRequest } from '../src/core/ai/LlmRouter';
import type { RolePromptSpec } from '../src/core/ai/orchestrator/promptRoles';

describe('P3-2: Prompt-/Kommando-Katalog für 16 MONKs + System-IDs', () => {
  it('jede Router-ID hat Kommando-Katalog + System-Prompt + Default-Task', () => {
    for (const id of PLUGIN_ROUTE_IDS) {
      expect(PLUGIN_COMMAND_CATALOG[id]).toBeTruthy();
      expect(moaSystemPromptForPlugin(id).length).toBeGreaterThan(20);
      expect(moaTaskForPlugin(id).length).toBeGreaterThan(5);
    }
  });

  it('Registry-IDs (16 MONKs) sind vollständig im Router enthalten (System-IDs zusätzlich)', () => {
    const registryIds = getPluginRegistry().map((p) => p.id).sort();
    expect(registryIds).toHaveLength(16);
    const routeSet = new Set(PLUGIN_ROUTE_IDS);
    for (const id of registryIds) {
      expect(routeSet.has(id)).toBe(true);
    }
  });

  it('Katalog-Text enthält alle Router-IDs', () => {
    const catalog = moaCommandCatalog();
    for (const id of PLUGIN_ROUTE_IDS) {
      expect(catalog).toContain(id);
    }
  });
});

/** MCP-Runtime mit No-Op-Abhängigkeiten – prüft nur die Registrierung, nicht Audio. */
function mcpRuntimeForTest() {
  return createDefaultMcpRuntime({
    runTask: async () => ({ ok: true }),
    getSessionState: () => ({}),
    searchSamples: () => [],
    getRuntimeStatus: () => ({}),
    loadModel: async () => undefined,
    unloadModel: async () => undefined,
    recordPluginCommand: () => undefined,
  });
}

describe('Rollen-Prompt-Katalog: Abdeckung als Vertrag (je Knoten/Rolle)', () => {
  it('der Katalog deckt jede verbindliche Rolle ab: Plugins + Planer + Bild/Video', () => {
    for (const roleId of EVAL_PLUGIN_IDS) {
      expect(ROLE_PROMPT_SPECS[roleId], `Rolle fehlt: ${roleId}`).toBeTruthy();
    }
    expect(ROLE_PROMPT_SPECS[PLANNER_ROLE_ID]).toBeTruthy();
    for (const roleId of VISUAL_GPU_ROLE_IDS) {
      expect(ROLE_PROMPT_SPECS[roleId], `Bild-/Video-Rolle fehlt: ${roleId}`).toBeTruthy();
    }
    expect(ROLE_IDS).toHaveLength(EVAL_PLUGIN_IDS.length + 1 + VISUAL_GPU_ROLE_IDS.length);
    expect(PROMPT_ROLE_IDS).toEqual(ROLE_IDS);
  });

  it('es gibt KEINE Abdeckungs-Lücken (fehlender Eintrag ⇒ rot)', () => {
    expect(roleCoverageGaps()).toEqual([]);
  });

  it('jede Plugin-Rolle hat Systemprompt + Kommandos + Fehlerregel + Few-Shots + MCP-Tools + Eval-Fälle', () => {
    for (const roleId of EVAL_PLUGIN_IDS) {
      const spec: RolePromptSpec = ROLE_PROMPT_SPECS[roleId];
      // Rollensatz des Bestands ist enthalten (Ableitung, kein Neutext).
      expect(spec.systemPrompt).toContain(PLUGIN_MOA_SYSTEM_PROMPTS[roleId]);
      expect(spec.systemPrompt).toContain('## Erlaubte Kommandos');
      expect(spec.systemPrompt).toContain('## Fehlerregel');
      expect(spec.systemPrompt).toContain('## Antwortformat');
      expect(spec.systemPrompt).toContain('## Beispiele (Few-Shot)');
      for (const entry of spec.commands) {
        expect(spec.systemPrompt, `Kommando fehlt im Prompt: ${entry}`).toContain(commandNameOf(entry));
      }
      expect(spec.version).toBeGreaterThanOrEqual(2);
      expect(spec.fewShots.length).toBeGreaterThanOrEqual(1);
      expect(spec.fewShots.length).toBe(Math.min(spec.commands.length, MAX_FEW_SHOTS_PER_ROLE));
      expect(spec.mcpTools).toHaveLength(spec.commands.length);
      expect(spec.evalCases.length).toBe(spec.commands.length + 1); // + Negativ-Fall
      expect(spec.minScoreFromMatrix).toBe(true);
      expect(spec.minScore).toBe(minScoreFor(roleId));
    }
  });

  it('die Fehlerregel nennt nur Kommandos, die die Rolle wirklich kennt', () => {
    for (const roleId of EVAL_PLUGIN_IDS) {
      const spec = ROLE_PROMPT_SPECS[roleId];
      if (commandNamesFor(roleId).includes('status')) {
        expect(spec.fallbackCommand).toBe('status');
        expect(spec.systemPrompt).toContain(`wähle 'status'`);
      } else {
        expect(spec.fallbackCommand).toBeNull();
        expect(spec.systemPrompt).not.toContain(`wähle 'status'`);
      }
    }
  });
});

describe('Few-Shots sind gültige Pläne (Bewertung durch den echten Grader)', () => {
  it('jeder Few-Shot besteht die Eval-Bewertung mit mindestens 4/5', () => {
    for (const roleId of EVAL_PLUGIN_IDS) {
      for (const shot of ROLE_PROMPT_SPECS[roleId].fewShots) {
        const grade = gradePlanAnswer(roleId, PLUGIN_COMMAND_CATALOG[roleId], JSON.stringify([shot.answer]));
        expect(grade.score, `${roleId}: ${shot.answer.command} (${grade.reason})`).toBeGreaterThanOrEqual(4);
      }
      // Das erste Beispiel trifft das erste Katalog-Kommando exakt.
      const first = ROLE_PROMPT_SPECS[roleId].fewShots[0];
      const firstGrade = gradePlanAnswer(roleId, PLUGIN_COMMAND_CATALOG[roleId], JSON.stringify([first.answer]));
      expect(firstGrade.exactMatch, `${roleId}: erstes Beispiel ist nicht exakt`).toBe(true);
    }
  });

  it('der Negativ-Eval-Fall fällt unter den Mindest-Score (erfundenes Kommando)', () => {
    for (const roleId of EVAL_PLUGIN_IDS) {
      const negative = ROLE_PROMPT_SPECS[roleId].evalCases.find((c) => c.negative);
      expect(negative, `Negativ-Fall fehlt: ${roleId}`).toBeTruthy();
      expect(negative?.forbiddenCommand).toBe(NEGATIVE_EVAL_COMMAND);
      const grade = gradePlanAnswer(
        roleId,
        PLUGIN_COMMAND_CATALOG[roleId],
        JSON.stringify({ pluginId: roleId, command: String(negative?.forbiddenCommand) }),
      );
      expect(grade.score, `${roleId}: erfundenes Kommando wurde nicht bestraft`).toBeLessThan(minScoreFor(roleId));
    }
  });
});

describe('MCP-Tools je Rolle sind wirklich registriert', () => {
  it('jedes Rollen-Tool existiert in der MCP-Runtime', () => {
    const runtime = mcpRuntimeForTest();
    for (const roleId of ROLE_IDS) {
      const spec = ROLE_PROMPT_SPECS[roleId];
      for (const tool of spec.mcpTools) {
        expect(runtime.hasTool(tool), `MCP-Tool fehlt: ${tool} (Rolle ${roleId})`).toBe(true);
      }
    }
  });

  it('MCP-Tool-Namen der Plugin-Rollen folgen `${rolle}.${kommando}`', () => {
    for (const roleId of EVAL_PLUGIN_IDS) {
      for (const name of commandNamesFor(roleId)) {
        expect(ROLE_PROMPT_SPECS[roleId].mcpTools).toContain(`${roleId}.${name}`);
      }
    }
  });

  it('die visuellen Rollen nutzen die bestehenden image./video_-Tools', () => {
    const runtime = mcpRuntimeForTest();
    for (const roleId of VISUAL_GPU_ROLE_IDS) {
      const tools = ROLE_PROMPT_SPECS[roleId].mcpTools;
      expect(tools.length).toBeGreaterThan(0);
      expect(tools.every((tool) => tool.startsWith('image.') || /^video_(real|abstract)\./.test(tool))).toBe(true);
      expect(tools.every((tool) => runtime.hasTool(tool))).toBe(true);
    }
  });
});

describe('Eval-Status ist ehrlich (keine erfundenen Scores)', () => {
  it('ohne Report sind alle Rollen UNCHECKED', () => {
    const rows = roleCoverageRows();
    expect(rows).toHaveLength(ROLE_IDS.length);
    expect(rows.every((r) => r.status === 'UNCHECKED')).toBe(true);
  });

  it('mit Report wird der gemeldete Status übernommen', () => {
    const rows = roleCoverageRows({ mixer: 'FAIL', drop: 'PASS' });
    expect(rows.find((r) => r.roleId === 'mixer')?.status).toBe('FAIL');
    expect(rows.find((r) => r.roleId === 'drop')?.status).toBe('PASS');
    expect(rows.find((r) => r.roleId === 'song')?.status).toBe('UNCHECKED');
  });

  it('die Summenzeile nennt Rollen, Prompts, Few-Shots, Tools und Eval-Fälle', () => {
    const totals = coverageTotals();
    expect(totals.rollen).toBe(ROLE_IDS.length);
    expect(totals.systemprompts).toBe(ROLE_IDS.length);
    expect(totals.fewShots).toBeGreaterThanOrEqual(ROLE_IDS.length);
    expect(totals.mcpTools).toBeGreaterThanOrEqual(EVAL_PLUGIN_IDS.length);
    expect(totals.evalCases).toBeGreaterThanOrEqual(EVAL_PLUGIN_IDS.length);
    expect(totals.mitMatrixGate).toBe(EVAL_PLUGIN_IDS.length);
    expect(totals.unchecked).toBe(ROLE_IDS.length);
  });
});

describe('Seed-Vertrag: fehlender Rollenprompt ist ein Fehler, kein Fallback', () => {
  it('erkennt fehlende Rollenprompts (Beweis, dass der Guard greift)', () => {
    expect(missingRolePrompts()).toEqual([]);
    expect(missingRolePrompts(['mixer', 'gibt-es-nicht'])).toEqual(['gibt-es-nicht']);
  });

  it('der Seed deckt alle Rollen ab und enthält den Planer-Prompt', () => {
    const seed = buildPromptEvalSeed();
    expect(seed.system_prompts).toHaveLength(ROLE_IDS.length);
    expect(seed.plugin_prompt_versions).toHaveLength(ROLE_IDS.length);
    const planner = seed.system_prompts.find((p) => p.plugin_id === PLANNER_ROLE_ID);
    expect(planner?.content).toBe(MOA_GLOBAL_SYSTEM_PROMPT);
    expect(planner?.enabled).toBe(true);
    for (const row of seed.system_prompts) {
      expect(row.content.trim().length, `content:${row.plugin_id}`).toBeGreaterThan(0);
      expect(row.content, `Fallback-Text bei ${row.plugin_id}`).not.toContain('Du bist ein audioMONASTRY-Produktions-Agent');
    }
  });
});

describe('Planer-Rolle (MOA_GLOBAL_PROMPT_KEY) erreicht den echten Plan-Aufruf', () => {
  it('eine aus dem Seed geladene Planer-Version steht im Plan-Prompt', async () => {
    const seen: LlmRequest[] = [];
    const complete = async (req: LlmRequest): Promise<LlmCompletion> => {
      seen.push(req);
      return { provider: 'ollama', text: '[]', latencyMs: 1 };
    };
    const store = new PromptStore();
    const seed = buildPromptEvalSeed();
    const plannerRow = seed.system_prompts.find((p) => p.plugin_id === MOA_GLOBAL_PROMPT_KEY);
    store.hydrate([{ pluginId: MOA_GLOBAL_PROMPT_KEY, content: String(plannerRow?.content), version: 2 }]);

    const agent = new MoaAgent(complete, undefined as never, () => 0, 1000, undefined, store);
    await agent.plan('Raeume die Session auf');

    expect(seen).toHaveLength(1);
    expect(seen[0].prompt).toContain(MOA_GLOBAL_SYSTEM_PROMPT);
    expect(seen[0].prompt).not.toContain('Du bist ein audioMONASTRY-Produktions-Agent');
  });
});
