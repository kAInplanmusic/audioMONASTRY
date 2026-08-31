// ============================================================================
// promptStore – Systemprompt-Versionierung je Plugin (P3-1 / GAP-5)
// ----------------------------------------------------------------------------
// In-Memory-Referenzimplementierung. Im Betrieb wird der Store über die
// Supabase-Tabellen `system_prompts` / `plugin_prompt_versions` persistiert
// (database/ai_migration_002.sql). CRUD ist identisch – nur das Backend tauscht.
// ============================================================================

export interface SystemPrompt {
  id: string;
  pluginId: string;
  role: string;
  version: number;
  content: string;
  enabled: boolean;
  meta: Record<string, unknown>;
  createdAt: number;
}

export interface PromptVersionEntry {
  pluginId: string;
  version: number;
  promptId: string;
  changelog: string;
  createdAt: number;
}

function makeId(): string {
  return `prompt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export class PromptStore {
  private prompts = new Map<string, SystemPrompt>(); // id -> prompt
  private active = new Map<string, string>();        // pluginId -> promptId (aktivste Version)

  /** Legt eine neue Prompt-Version an (oder aktualisiert die vorhandene). */
  upsert(pluginId: string, content: string, options: { role?: string; version?: number; enabled?: boolean; meta?: Record<string, unknown>; changelog?: string } = {}): SystemPrompt {
    const version = options.version ?? ((this.highestVersion(pluginId) ?? 0) + 1);
    const id = makeId();
    const prompt: SystemPrompt = {
      id,
      pluginId,
      role: options.role ?? 'system',
      version,
      content,
      enabled: options.enabled ?? true,
      meta: options.meta ?? {},
      createdAt: Date.now(),
    };
    this.prompts.set(id, prompt);
    if (prompt.enabled) this.active.set(pluginId, id);
    return prompt;
  }

  /** Aktivste Prompt-Version eines Plugins. */
  getActive(pluginId: string): SystemPrompt | null {
    const id = this.active.get(pluginId);
    return id ? (this.prompts.get(id) ?? null) : null;
  }

  /** Alle Versionen eines Plugins (neueste zuerst). */
  listVersions(pluginId: string): SystemPrompt[] {
    return [...this.prompts.values()]
      .filter((p) => p.pluginId === pluginId)
      .sort((a, b) => b.version - a.version);
  }

  highestVersion(pluginId: string): number | null {
    const versions = this.listVersions(pluginId);
    return versions.length > 0 ? versions[0].version : null;
  }

  /** Deaktiviert eine Version; aktive Version wird nur gewechselt, wenn betroffen. */
  disable(pluginId: string, version: number): void {
    for (const p of this.prompts.values()) {
      if (p.pluginId === pluginId && p.version === version) {
        p.enabled = false;
        if (this.active.get(pluginId) === p.id) {
          const next = this.listVersions(pluginId).find((x) => x.enabled);
          if (next) this.active.set(pluginId, next.id);
          else this.active.delete(pluginId);
        }
      }
    }
  }

  /** Export für DB-/File-Persistenz (versioniert, reversibel). */
  exportJson(): { prompts: SystemPrompt[] } {
    return { prompts: [...this.prompts.values()] };
  }
}

export const promptStore = new PromptStore();
