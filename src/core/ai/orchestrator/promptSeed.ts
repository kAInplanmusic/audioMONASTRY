/**
 * audioMONASTRY · GAP-5: Prompt-/Eval-Matrix-Seed (DB-ready)
 * ==========================================================
 * Baut aus dem bestehenden Prompt-/Kommando-Katalog deterministische,
 * DB-ready Datensätze für Supabase (`database/ai_migration_002.sql`):
 *   * `system_prompts`          – je Plugin eine aktive Prompt-Version
 *   * `plugin_prompt_versions`  – Version 1 mit Prompt + Kommando-Katalog
 *
 * Die eigentliche Persistenz übernimmt `aiPersistence` (No-Op ohne Supabase);
 * `scripts/seed-prompt-evals.ts` schreibt die Datensätze als JSON nach
 * `test-results/` – analog zu `eval-ai.ts`.
 */
import { PLUGIN_COMMAND_CATALOG, PLUGIN_MOA_SYSTEM_PROMPTS } from '../../../utils/prompts';

/** Verbindliche 21 Plugin-IDs (Reihenfolge aus src/plugins/registry.ts). */
export const PLUGIN_IDS_21 = [
  'masterplayer', 'instrument', 'synthesizer', 'drum', 'sampler', 'mcp', 'voice', 'sound',
  'mixer', 'controller', 'effect', 'drop', 'library', 'eq', 'dsp', 'mastering', 'stem',
  'spatial', 'recording', 'performance', 'ai',
] as const;

export interface SystemPromptSeed {
  plugin_id: string;
  role: 'system';
  version: number;
  content: string;
  enabled: boolean;
}

export interface PluginPromptVersionSeed {
  plugin_id: string;
  version: number;
  prompt: string;
  commands: string;
}

export interface PromptEvalSeed {
  system_prompts: SystemPromptSeed[];
  plugin_prompt_versions: PluginPromptVersionSeed[];
}

/** Liefert für alle 21 Plugins je eine Prompt-Version (Version 1, aktiv). */
export function buildPromptEvalSeed(): PromptEvalSeed {
  const system_prompts: SystemPromptSeed[] = PLUGIN_IDS_21.map((pluginId) => ({
    plugin_id: pluginId,
    role: 'system',
    version: 1,
    content: PLUGIN_MOA_SYSTEM_PROMPTS[pluginId]
      ?? 'Du bist ein audioMONASTRY-Produktions-Agent. Wähle passende Kommandos aus dem Katalog.',
    enabled: true,
  }));

  const plugin_prompt_versions: PluginPromptVersionSeed[] = PLUGIN_IDS_21.map((pluginId) => ({
    plugin_id: pluginId,
    version: 1,
    prompt: system_prompts.find((p) => p.plugin_id === pluginId)?.content ?? '',
    commands: PLUGIN_COMMAND_CATALOG[pluginId] ?? 'status',
  }));

  return { system_prompts, plugin_prompt_versions };
}
