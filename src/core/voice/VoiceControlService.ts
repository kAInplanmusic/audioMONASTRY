/**
 * audioMONASTRY · Voice-Control-Service (Sprachbefehl-Automation)
 * ================================================================
 * GETRENNTER Service – KEIN Plugin. Deckt alle 4 User ab und führt
 * Sprachbefehle in allen angeschlossenen Plugins aus.
 *
 * Abgrenzung: Das ist NICHT VoiceMONK (TTS/Gesang), sondern die
 * Kommando-Steuerung ("Tempo 128", "Plugin X User2 zuweisen", ...).
 */
import { RuleBasedSpeechToIntent, type VoiceIntent, type ISpeechToIntent } from './SpeechToIntent';

export interface VoiceCommandContext {
  userId: string;
  pluginId: string;
  intent: VoiceIntent;
}

export type VoiceCommandHandler = (ctx: VoiceCommandContext) => Promise<void> | void;

export interface VoiceCommandRegistration {
  pluginId: string;
  intent: VoiceIntent['action'];
  handler: VoiceCommandHandler;
}

export interface VoiceCommandResult {
  userId: string;
  command: string;
  intent: VoiceIntent;
  pluginId: string;
  handled: boolean;
  error?: string;
}

export interface PluginCommandRegistration {
  pluginId: string;
  action: string;
  /** Optionale Freitext-Keywords (case-insensitive) für MOA-Kommandos. */
  keywords?: string[];
  handler: VoiceCommandHandler;
}

export interface PluginCommandResult {
  userId: string;
  pluginId: string;
  action: string;
  command: string;
  handled: boolean;
  error?: string;
}

/** Cerebras-NLU-Fallback: freie Sprachkommandos in {action, parameters} übersetzen. */
async function cerebrasNluIntent(command: string, pluginId?: string): Promise<{ action?: string; parameters?: Record<string, string> } | null> {
  try {
    const { ProviderRouter } = await import('../ai/orchestrator/providerRouter');
    const res = await new ProviderRouter().run('nlu', 'gpt-oss-120b', {
      prompt: JSON.stringify({ command, pluginId }),
      json: true,
      complexity: 'complex',
    });
    const obj = (res?.result ?? {}) as { action?: string; parameters?: Record<string, string> };
    return (typeof obj.action === 'string' && obj.action) ? obj : null;
  } catch { return null; }
}

export class VoiceControlService {
  private commands: VoiceCommandRegistration[] = [];
  private pluginCommands: PluginCommandRegistration[] = [];
  private parser: ISpeechToIntent;

  constructor(parser: ISpeechToIntent = new RuleBasedSpeechToIntent()) {
    this.parser = parser;
  }

  /** Registriert einen Befehl für ein Plugin (z.B. 'fx', 'mcp', 'mixer'). */
  registerCommand(pluginId: string, intent: VoiceIntent['action'], handler: VoiceCommandHandler): void {
    this.commands.push({ pluginId, intent, handler });
  }

  /** Registriert ein plugin-spezifisches Kommando (für MoaAgent/Registry). */
  registerPluginCommand(
    pluginId: string,
    action: string,
    handler: VoiceCommandHandler,
    keywords?: string[],
  ): void {
    this.pluginCommands.push({ pluginId, action, keywords, handler });
  }

  listPlugins(): string[] {
    return [...new Set([...this.commands.map((c) => c.pluginId), ...this.pluginCommands.map((c) => c.pluginId)])];
  }

  listPluginCommands(): PluginCommandRegistration[] {
    return [...this.pluginCommands];
  }

  /** Führt einen Sprachbefehl für einen bestimmten User aus (alle 4 User erlaubt). */
  async execute(userId: string, command: string): Promise<VoiceCommandResult> {
    const intent = await this.parser.parse(command);
    const match = this.commands.find((c) => c.intent === intent.action);

    if (!match) {
      return { userId, command, intent, pluginId: '', handled: false, error: 'Kein Handler für Intent' };
    }

    try {
      await match.handler({ userId, pluginId: match.pluginId, intent });
      return { userId, command, intent, pluginId: match.pluginId, handled: true };
    } catch (error) {
      return {
        userId,
        command,
        intent,
        pluginId: match.pluginId,
        handled: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Führt ein plugin-spezifisches Kommando aus (MOA/MCP-Pfad):
   * exakter Action-Match zuerst, danach Keyword-Match im Kommando-Text.
   */
  async executePluginCommand(
    userId: string,
    pluginId: string,
    command: string,
    parameters: Record<string, number | string> = {},
  ): Promise<PluginCommandResult> {
    const normalized = command.trim();
    const lower = normalized.toLowerCase();

    const exact = this.pluginCommands.find((c) => c.pluginId === pluginId && c.action === lower);
    const keyword = exact
      ? undefined
      : this.pluginCommands.find(
          (c) =>
            c.pluginId === pluginId &&
            (c.keywords ?? []).some((k) => lower.includes(k.toLowerCase())),
        );
    const match = exact ?? keyword;
    if (!match) {
      // Cerebras-NLU-Fallback (aiMONK): freie Sprache -> {action, parameters}
      const nlu = await cerebrasNluIntent(command, pluginId);
      if (nlu?.action) {
        const nluMatch = this.pluginCommands.find((c) => c.pluginId === pluginId && c.action === nlu.action);
        if (nluMatch) {
          const nluIntent: VoiceIntent = {
            action: nluMatch.action as VoiceIntent['action'],
            targets: [pluginId],
            parameters: { ...parameters, ...(nlu.parameters ?? {}) },
            confidence: 0.92,
            raw: command,
          };
          try {
            await nluMatch.handler({ userId, pluginId: nluMatch.pluginId, intent: nluIntent });
            return { userId, pluginId: nluMatch.pluginId, action: nluMatch.action, command: normalized, handled: true };
          } catch (error) {
            return { userId, pluginId, action: nluMatch.action, command: normalized, handled: false,
              error: error instanceof Error ? error.message : String(error) };
          }
        }
      }
      return { userId, pluginId, action: '', command: normalized, handled: false, error: 'Kein Plugin-Kommando' };
    }

    const intent: VoiceIntent = {
      action: 'unknown',
      targets: [pluginId],
      parameters,
      confidence: 0.5,
      raw: command,
    };

    try {
      await match.handler({ userId, pluginId: match.pluginId, intent });
      return { userId, pluginId: match.pluginId, action: match.action, command: normalized, handled: true };
    } catch (error) {
      return {
        userId,
        pluginId: match.pluginId,
        action: match.action,
        command: normalized,
        handled: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

export const voiceControlService = new VoiceControlService();
