/**
 * audioMONASTRY · GAP-5: Prompt-/Eval-Matrix-Seed (DB-ready)
 * ==========================================================
 * Baut aus dem Rollen-Prompt-Katalog (`promptRoles.ts`) deterministische,
 * DB-ready Datensätze für Supabase (`database/ai_migration_002.sql`):
 *   * `system_prompts`          – je Rolle eine aktive Prompt-Version
 *   * `plugin_prompt_versions`  – Version 1 mit Prompt + Kommando-Katalog
 *
 * INFRA-AI-003/GAP-5-Nachzug: Der Seed schrieb bisher nur den nackten
 * Rollensatz; Kommandoliste, Fehlerregel, Antwortformat und Few-Shots fehlten
 * dort, wo der Prompt tatsächlich ans Modell geht. Jetzt kommt der Inhalt aus
 * `composeRoleSystemPrompt()` (Version `ROLE_PROMPT_VERSION`) und der globale
 * Planer-Prompt ist als eigene Zeile (`plugin_id = 'moa'`) dabei – vorher
 * existierte er ausschließlich als Text in `docs/AI_PROMPTS.md`.
 *
 * Verbindliche Rollenliste: `EVAL_PLUGIN_IDS` (evalMatrix.ts). Ein fehlender
 * Eintrag ist KEIN Fallback mehr, sondern ein Fehler (`MissingRolePromptError`).
 */
import { EVAL_PLUGIN_IDS } from './evalMatrix';
import { PLUGIN_COMMAND_CATALOG } from '../../../utils/prompts';
import {
  MOA_GLOBAL_SYSTEM_PROMPT,
  PLANNER_ROLE_ID,
  ROLE_IDS,
  ROLE_PROMPT_SPECS,
  ROLE_PROMPT_VERSION,
  commandsFor,
} from './promptRoles';

/**
 * Verbindliche Plugin-IDs (16 MONKs + System-Module ai/perfor).
 * Re-Export von `EVAL_PLUGIN_IDS` – genau EINE Quelle für die Rollenliste.
 */
export const PLUGIN_IDS = EVAL_PLUGIN_IDS;

/** Alle Rollen des Prompt-Katalogs (Plugins + Planer + Bild/Video-GPU-Rollen). */
export const PROMPT_ROLE_IDS = ROLE_IDS;

/** Wird geworfen, wenn eine verbindliche Rolle keinen Systemprompt hat. */
export class MissingRolePromptError extends Error {
  constructor(readonly roleIds: readonly string[]) {
    super(`Systemprompt fehlt für verbindliche Rolle(n): ${roleIds.join(', ')}`);
    this.name = 'MissingRolePromptError';
  }
}

interface SystemPromptSeed {
  plugin_id: string;
  role: 'system';
  version: number;
  content: string;
  enabled: boolean;
}

interface PluginPromptVersionSeed {
  plugin_id: string;
  version: number;
  prompt: string;
  commands: string;
}

export interface PromptEvalSeed {
  system_prompts: SystemPromptSeed[];
  plugin_prompt_versions: PluginPromptVersionSeed[];
}

/**
 * Rollen ohne Systemprompt. Getrennt exportiert, damit ein Test den Fehlerfall
 * (fehlender Eintrag ⇒ rot) zeigen kann, ohne den echten Katalog zu leeren.
 */
export function missingRolePrompts(roleIds: readonly string[] = ROLE_IDS): string[] {
  return roleIds.filter((roleId) => (ROLE_PROMPT_SPECS[roleId]?.systemPrompt ?? '').trim().length === 0);
}

/** Liefert für jede verbindliche Rolle eine Prompt-Version (aktiv). */
export function buildPromptEvalSeed(): PromptEvalSeed {
  const missing = missingRolePrompts();
  if (missing.length > 0) throw new MissingRolePromptError(missing);

  const system_prompts: SystemPromptSeed[] = ROLE_IDS.map((roleId) => ({
    plugin_id: roleId,
    role: 'system',
    version: ROLE_PROMPT_SPECS[roleId].version,
    content: ROLE_PROMPT_SPECS[roleId].systemPrompt,
    enabled: true,
  }));

  const plugin_prompt_versions: PluginPromptVersionSeed[] = ROLE_IDS.map((roleId) => {
    const spec = ROLE_PROMPT_SPECS[roleId];
    return {
      plugin_id: roleId,
      version: spec.version,
      prompt: spec.systemPrompt,
      // Der Planer plant über ALLE Rollen – für ihn ist der Gesamtkatalog hinterlegt.
      // Bild-/Video-Rollen haben keine Plugin-Kommandos, sondern MCP-Tools.
      commands: roleId === PLANNER_ROLE_ID
        ? Object.entries(PLUGIN_COMMAND_CATALOG).map(([id, cmds]) => `${id}: ${cmds}`).join('; ')
        : (spec.commands.join(', ') || spec.mcpTools.join(', ')),
    };
  });

  return { system_prompts, plugin_prompt_versions };
}

/** Rollen-Kurzbericht des Seeds (Zahlen für Bericht/Doku). */
export function promptSeedSummary(): {
  rollen: number;
  pluginRollen: number;
  planerPrompt: boolean;
  version: number;
  kommandos: number;
} {
  return {
    rollen: ROLE_IDS.length,
    pluginRollen: EVAL_PLUGIN_IDS.length,
    planerPrompt: MOA_GLOBAL_SYSTEM_PROMPT.trim().length > 0,
    version: ROLE_PROMPT_VERSION,
    kommandos: ROLE_IDS.reduce((sum, roleId) => sum + commandsFor(roleId).length, 0),
  };
}
