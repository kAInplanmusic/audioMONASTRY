/**
 * audioMONASTRY · Agent-Executor über die MCP-Werkzeuge (AI-P1-006)
 * =====================================================================
 * Der aiMONK-Agent-Loop läuft zweimal:
 *
 *   - **Client** (MoaAssistant): plant Plugin-Kommandos und führt sie über die
 *     `pluginCommandRegistry` aus — dort gibt es Audio-Engine und Plugins.
 *   - **Server** (Agent-Läufe, `/api/ai/agent/runs`): kann Plugin-Kommandos
 *     NICHT ausführen (die Registry wird in `src/main.tsx` registriert, also im
 *     Browser). Bisher meldete jeder serverseitige Schritt deshalb ehrlich
 *     „Kein Plugin-Kommando" — richtig, aber nutzlos.
 *
 * Dieses Modul gibt dem Server einen **ausführbaren** Werkzeugkasten: die
 * Werkzeuge der MCP-Runtime (`session.getState`, `runtime.status`, `fleet.status`,
 * `models.list`, `sample.search`, …). Damit ist ein serverseitiger Lauf kein
 * Plan ohne Hände mehr.
 *
 * Zwei Entscheidungen, die den Aufbau tragen:
 *
 * 1. **Der Katalog ist abgeleitet, nicht gepflegt.** Werkzeugnamen der Runtime
 *    haben die Form `<kategorie>.<aktion>` — genau die Form, die der Planer
 *    ohnehin versteht (`pluginId: command`). Der Plan-Prompt bekommt also die
 *    Werkzeugliste selbst, und die Rückabbildung ist deterministisch
 *    (`pluginId` + `command` -> `pluginId.command`). Ein halluziniertes Werkzeug
 *    ist damit nicht ausführbar *und* nicht planbar — nicht nur „nicht
 *    ausführbar".
 * 2. **Nur LESE-Werkzeuge sind voreingestellt.** `EXECUTION`-Werkzeuge kosten
 *    GPU-Zeit (Audio-Jobs, Modell-Laden) und `WRITE`-Werkzeuge verändern die
 *    Session. Sie kommen nur mit ausdrücklicher Freigabe
 *    (`AI_AGENT_ALLOW_EXECUTION_TOOLS=1`) in Katalog UND Executor — ein Agent
 *    soll nicht durch eine freundliche Formulierung Geld ausgeben.
 *
 * Die Rechteprüfung selbst liegt weiterhin in der MCP-Runtime (`invoke` mit
 * `permission`): dieses Modul kann sie nicht umgehen, selbst wenn es wollte.
 */
import type { IMoaCommandExecutor } from '../src/core/ai/MoaAgent';

export interface McpToolSpecLike {
  name: string;
  description: string;
  permission?: string;
  category?: string;
}

export interface McpInvoker {
  listTools(): McpToolSpecLike[];
  invoke(name: string, payload?: Record<string, unknown>): Promise<{ ok: boolean; result?: unknown; error?: string }>;
}

export interface McpAgentExecutorOptions {
  mcp: McpInvoker;
  /** EXECUTION-/WRITE-Werkzeuge zulassen (Default: nur READ). */
  allowExecution?: boolean;
  log?: (message: string, meta?: Record<string, unknown>) => void;
}

/** Werkzeuge, die ohne ausdrueckliche Freigabe benutzt werden duerfen. */
export function isReadOnlyTool(tool: McpToolSpecLike): boolean {
  const permission = String(tool.permission ?? 'READ').toUpperCase();
  return permission === 'READ';
}

/**
 * Baut den Plan-Katalog aus der Werkzeugliste — im Format des bestehenden
 * `PLUGIN_COMMAND_CATALOG`: `kategorie: aktion(param), aktion2`.
 *
 * Parameter werden NICHT erfunden: nur Werkzeuge mit dokumentierter
 * Parameter-Konvention (siehe PARAM_HINTS) bekommen ein `(… )` im Katalog.
 */
export const PARAM_HINTS: Record<string, string> = {
  'sample.search': 'query',
  'audio.classify': 'audioBase64, model?',
  'audio.transcribe': 'audioBase64, model?',
  'audio.embed': 'audioBase64, model?',
  'audio.analyze': 'audioBase64, model?',
  'model.load': 'model',
  'model.unload': 'model',
  'fleet.wake': '',
  'plugin.command': 'pluginId, action, parameters?',
};

export function catalogFromMcpTools(
  tools: McpToolSpecLike[],
  options: { allowExecution?: boolean } = {},
): string {
  const allow = options.allowExecution === true;
  const byCategory = new Map<string, string[]>();
  for (const tool of tools) {
    if (!allow && !isReadOnlyTool(tool)) continue;
    const [category, action] = String(tool.name).split('.');
    if (!category || !action) continue;
    const hint = PARAM_HINTS[tool.name];
    const entry = hint === undefined ? action : `${action}(${hint})`;
    byCategory.set(category, [...(byCategory.get(category) ?? []), entry]);
  }
  return [...byCategory.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([category, actions]) => `${category}: ${actions.sort().join(', ')}`)
    .join('; ');
}

/** Zerlegt `search(bass drum, 4)` in Aktion + Argumente. */
export function parsePlannedCommand(command: string): { action: string; args: string[] } {
  const raw = String(command ?? '').trim();
  const open = raw.indexOf('(');
  if (open === -1 || !raw.endsWith(')')) return { action: raw.toLowerCase(), args: [] };
  const action = raw.slice(0, open).trim().toLowerCase();
  const inner = raw.slice(open + 1, -1).trim();
  const args = inner.length === 0 ? [] : inner.split(',').map((a) => a.trim().replace(/^['"]|['"]$/g, ''));
  return { action, args };
}

/** Baut die Werkzeug-Parameter aus dem geplanten Kommando (dokumentierte Konvention). */
export function buildToolParams(toolName: string, args: string[]): Record<string, unknown> {
  const hint = PARAM_HINTS[toolName];
  if (!hint || hint === '' || args.length === 0) return {};
  const names = hint.split(',').map((n) => n.trim().replace(/\?$/, ''));
  const params: Record<string, unknown> = {};
  names.forEach((name, index) => {
    if (args[index] !== undefined && args[index] !== '') params[name] = args[index];
  });
  return params;
}

/**
 * `IMoaCommandExecutor` auf Basis der MCP-Runtime.
 *
 * `executePluginCommand(pluginId, command)` bildet auf `<pluginId>.<aktion>` ab;
 * `execute(command)` sucht die Aktion über alle Kategorien (eindeutig oder
 * nicht — bei Mehrdeutigkeit wird ehrlich abgelehnt statt geraten).
 */
export function createMcpAgentExecutor(options: McpAgentExecutorOptions): IMoaCommandExecutor {
  const allowExecution = options.allowExecution === true;
  const log = options.log ?? ((message, meta) => console.warn(message, meta ?? {}));

  const allowed = (tool: McpToolSpecLike): boolean => allowExecution || isReadOnlyTool(tool);

  /** Werkzeug case-insensitiv finden (der Planer schreibt 'getState' oder 'getstate'). */
  const findTool = (toolName: string): McpToolSpecLike | undefined => {
    const wanted = toolName.toLowerCase();
    return options.mcp.listTools().find((t) => t.name.toLowerCase() === wanted);
  };

  const invokeTool = async (
    toolName: string,
    pluginId: string,
    args: string[],
  ): Promise<{ handled: boolean; pluginId: string; error?: string; action?: string }> => {
    const tool = findTool(toolName);
    if (!tool) {
      return { handled: false, pluginId, action: toolName, error: `kein serverseitiges Werkzeug: ${toolName}` };
    }
    if (!allowed(tool)) {
      return {
        handled: false,
        pluginId,
        action: toolName,
        error: `${toolName} ist ${tool.permission} — serverseitig nur mit Freigabe (AI_AGENT_ALLOW_EXECUTION_TOOLS=1)`,
      };
    }
    const canonical = tool.name;
    const result = await options.mcp.invoke(canonical, buildToolParams(canonical, args));
    if (!result.ok) {
      return { handled: false, pluginId, action: canonical, error: result.error ?? 'Werkzeug fehlgeschlagen' };
    }
    log(`[agent] Werkzeug ausgefuehrt: ${canonical}`, { args });
    return { handled: true, pluginId, action: canonical };
  };

  return {
    /**
     * Nur-Lese-Auskunft fuer das WRITE-Gate: ein bekanntes Werkzeug mit
     * `permission: READ` braucht keine Schreib-Bestätigung. Unbekanntes bleibt
     * fail-safe WRITE (kein Eintrag -> false).
     */
    isReadOnly(pluginId: string, command: string): boolean {
      const { action } = parsePlannedCommand(command);
      const tool = findTool(`${String(pluginId).toLowerCase()}.${action}`);
      return tool ? allowed(tool) && isReadOnlyTool(tool) : false;
    },

    async execute(userId: string, command: string) {
      const { action, args } = parsePlannedCommand(command);
      const matches = options.mcp.listTools().filter(
        (t) => allowed(t) && t.name.toLowerCase().endsWith(`.${action}`),
      );
      if (matches.length === 1) {
        return invokeTool(matches[0].name, matches[0].name.split('.')[0], args);
      }
      if (matches.length > 1) {
        return {
          handled: false,
          pluginId: '',
          error: `Aktion '${action}' ist mehrdeutig (${matches.map((m) => m.name).join(', ')}) — Kategorie angeben`,
        };
      }
      // Kein serverseitiges Werkzeug: der Aufrufer (Client-Pfad) bleibt zustaendig.
      return { handled: false, pluginId: '', action, error: `kein serverseitiges Werkzeug fuer '${command}'` };
    },

    async executePluginCommand(userId: string, pluginId: string, command: string) {
      const { action, args } = parsePlannedCommand(command);
      const toolName = `${String(pluginId).toLowerCase()}.${action}`;
      return invokeTool(toolName, pluginId, args);
    },
  };
}
