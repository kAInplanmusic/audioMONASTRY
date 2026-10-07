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
import { AiAgentLoop } from '../ai/agentLoop';
import { moaAgent, type MoaRunOptions, type MoaRunResult } from '../ai/MoaAgent';

interface VoiceCommandContext {
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

/**
 * NLU-Fallback (aiMONK): freie Sprachkommandos in {action, parameters} übersetzen.
 *
 * RT-AUDIT-P1-014: läuft über `completeLlm` → im Browser `/api/ai/complete` →
 * serverseitiger `LlmRouter` (lokales Brain zuerst, DeepSeek nur per
 * Positivliste). Vorher baute dieser Pfad im Browser einen eigenen
 * ProviderRouter und forderte das Cerebras-Modell `gpt-oss-120b` an.
 */
async function localNluIntent(command: string, pluginId?: string): Promise<{ action?: string; parameters?: Record<string, string> } | null> {
  try {
    const { completeLlm } = await import('../ai/clientLlm');
    const completion = await completeLlm({
      prompt: buildNluPrompt(command, pluginId),
      complexity: 'simple',
      maxTokens: 256,
      temperature: 0.1,
    });
    return parseNluIntent(completion.text);
  } catch { return null; }
}

/** Prompt für den NLU-Fallback: nur JSON im Schema {action, parameters}. */
export function buildNluPrompt(command: string, pluginId?: string): string {
  return 'Du bist ein präziser Intent-Parser der DAW audioMONASTRY. Antworte NUR mit '
    + 'einem JSON-Objekt der Form {"action":"string","parameters":{"name":"wert"}} – '
    + 'ohne Erklärung, ohne Markdown. '
    + `Plugin: ${JSON.stringify(pluginId ?? '')}. Kommando: ${JSON.stringify(command)}`;
}

/** Robuste JSON-Extraktion aus einer LLM-Antwort (auch mit Text drumherum). */
export function parseNluIntent(text: string): { action?: string; parameters?: Record<string, string> } | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(text.slice(start, end + 1)) as { action?: unknown; parameters?: unknown };
    if (typeof obj.action !== 'string' || !obj.action) return null;
    const parameters: Record<string, string> = {};
    if (obj.parameters && typeof obj.parameters === 'object') {
      for (const [k, v] of Object.entries(obj.parameters as Record<string, unknown>)) {
        if (v !== undefined && v !== null) parameters[k] = String(v);
      }
    }
    return { action: obj.action, parameters };
  } catch { return null; }
}

export class VoiceControlService {
  private commands: VoiceCommandRegistration[] = [];
  private pluginCommands: PluginCommandRegistration[] = [];
  private parser: ISpeechToIntent;
  private agentLoop: AiAgentLoop | null;

  // Der Loop wird BEWUSST lazy erzeugt: VoiceControlService ↔ agentLoop ↔ MoaAgent
  // bilden einen Import-Zyklus. Ein `new AiAgentLoop(moaAgent)` als Default-Parameter
  // liefe beim Modul-Load (Singleton `voiceControlService`) und träfe dort auf den
  // noch nicht initialisierten Export („AiAgentLoop is not a constructor“).
  constructor(parser: ISpeechToIntent = new RuleBasedSpeechToIntent(), agentLoop: AiAgentLoop | null = null) {
    this.parser = parser;
    this.agentLoop = agentLoop;
  }

  private getAgentLoop(): AiAgentLoop {
    if (!this.agentLoop) this.agentLoop = new AiAgentLoop(moaAgent);
    return this.agentLoop;
  }

  /**
   * Mehrstufiger Agent-Loop (AI-P1-003 P5): freie Aufgabe in Plugin-Schritte
   * zerlegen, mit WRITE-Bestätigung ausführen, prüfen und korrigieren.
   * Der Executor ist dieser Service; Kontext (routing.json/Session-Zustand)
   * reicht der Aufrufer herein.
   */
  async runAgentTask(
    userId: string,
    task: string,
    opts: {
      routing?: unknown;
      sessionState?: unknown;
      confirmWrite?: MoaRunOptions['confirmWrite'];
      maxCorrections?: number;
    } = {},
  ): Promise<MoaRunResult> {
    return this.getAgentLoop().runTask(task, {
      userId,
      routing: opts.routing,
      sessionState: opts.sessionState,
      confirmWrite: opts.confirmWrite,
      maxCorrections: opts.maxCorrections,
    });
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
    // Keyword-Match mit Prioritäts-Score: längste/spezifischste Übereinstimmung
    // gewinnt (z. B. auto_drop mit 'automatisch'+'passend'+'drop' > pattern mit 'drop').
    let keyword:
      | { candidate: (typeof this.pluginCommands)[number]; score: number }
      | undefined;
    if (!exact) {
      for (const candidate of this.pluginCommands) {
        if (candidate.pluginId !== pluginId) continue;
        const matched = (candidate.keywords ?? []).filter((k) => lower.includes(k.toLowerCase()));
        if (matched.length === 0) continue;
        const score = matched.reduce((sum, k) => sum + k.length, 0) + matched.length;
        if (!keyword || score > keyword.score) keyword = { candidate, score };
      }
    }
    const match = exact ?? keyword?.candidate;
    if (!match) {
      // NLU-Fallback (aiMONK, lokales Brain): freie Sprache -> {action, parameters}
      const nlu = await localNluIntent(command, pluginId);
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
