/**
 * audioMONASTRY · MOA/MCP-Agent (DeepSeek V4 Flash als Planer)
 * ============================================================
 * Der Agent zerlegt Produktions-Aufgaben in Plugin-Schritte, schreibt die
 * Prompts für Sub-Agents, iteriert über Zwischenergebnisse und steuert die
 * Plugins über den VoiceControlService (deterministischer Fallback) bzw.
 * über die LLM-Route.
 */
import { type LlmCompletion, type LlmRequest } from './LlmRouter';
import { completeLlm } from './clientLlm';
import { voiceControlService } from '../voice/VoiceControlService';
import { moaCommandCatalog, moaSystemPromptForPlugin } from '../../utils/prompts';

export interface MoaStep {
  pluginId: string;
  command: string;
  prompt: string;
}

export interface MoaPlan {
  task: string;
  provider: string;
  steps: MoaStep[];
  raw: string;
  createdAt: number;
}

export interface MoaStepResult {
  step: MoaStep;
  handled: boolean;
  pluginId: string;
  error?: string;
}

type CompletionFn = (req: LlmRequest) => Promise<LlmCompletion>;

/** Minimale Schnittstelle für die Plugin-Steuerung (VoiceControlService erfüllt sie). */
export interface IMoaCommandExecutor {
  execute(userId: string, command: string): Promise<{ handled: boolean; pluginId: string; error?: string }>;
  executePluginCommand?(
    userId: string,
    pluginId: string,
    command: string,
  ): Promise<{ handled: boolean; pluginId: string; error?: string; action?: string }>;
}

/** Entfernt Code-Fences und parst das MOA-JSON (tolerant). */
export function parseMoaSteps(raw: string): MoaStep[] {
  let s = raw.trim();
  if (s.startsWith('```json')) s = s.slice(7);
  if (s.startsWith('```')) s = s.slice(3);
  if (s.endsWith('```')) s = s.slice(0, -3);
  s = s.trim();

  // Fallback: nur den ersten JSON-Array-Block verwenden (indexbasiert, kein
  // super-lineares Regex-Backtracking, Sonar S8786).
  const start = s.indexOf('[');
  const end = s.lastIndexOf(']');
  if (start >= 0 && end > start) s = s.slice(start, end + 1);

  try {
    const parsed = JSON.parse(s) as unknown;
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    const steps: MoaStep[] = [];
    for (const entry of arr) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as Record<string, unknown>;
      const pluginId = String(e.pluginId ?? '').trim().slice(0, 64);
      const command = String(e.command ?? '').trim().slice(0, 200);
      const prompt = String(e.prompt ?? '').trim().slice(0, 2000);
      if (!command && !prompt) continue;
      steps.push({ pluginId: pluginId || 'unknown', command, prompt });
    }
    return steps.slice(0, 16);
  } catch {
    return [];
  }
}

export class MoaAgent {
  constructor(
    private complete: CompletionFn = (req) => completeLlm(req),
    private voice: IMoaCommandExecutor = voiceControlService,
  ) {}

  /** Plant eine Aufgabe mit DeepSeek V4 Flash (automatischer Free-Fallback). */
  async plan(task: string, pluginId = ''): Promise<MoaPlan> {
    const catalog = moaCommandCatalog();
    const role = pluginId ? moaSystemPromptForPlugin(pluginId) : moaSystemPromptForPlugin('');
    const completion = await this.complete({
      prompt:
        `${role} Zerlege die Aufgabe in klare Einzelschritte. ` +
        `Du darfst NUR diese Plugin-IDs und Kommandos verwenden (Syntax command(parameter)): ${catalog}. ` +
        `Antworte NUR als JSON-Array (keine Erklärung, kein Markdown): ` +
        `[{"pluginId":"string","command":"string","prompt":"string"}] . Aufgabe: ` + task,
      complexity: 'moderate',
      maxTokens: 1024,
      temperature: 0.3,
      reasoningEffort: 'low',
    });
    return {
      task,
      provider: completion.provider,
      steps: parseMoaSteps(completion.text),
      raw: completion.text,
      createdAt: Date.now(),
    };
  }

  /** Führt einen Plan aus: plugin-bewusstes Kommando (Registry), sonst Intent-Fallback. */
  async executePlan(plan: MoaPlan, userId = 'localUser'): Promise<MoaStepResult[]> {
    const results: MoaStepResult[] = [];
    for (const step of plan.steps) {
      if (!step.command) {
        results.push({ step, handled: false, pluginId: step.pluginId, error: 'Kein Kommando' });
        continue;
      }
      let res: { handled: boolean; pluginId: string; error?: string };
      if (this.voice.executePluginCommand && step.pluginId && step.pluginId !== 'unknown') {
        res = await this.voice.executePluginCommand(userId, step.pluginId, step.command);
      } else {
        res = await this.voice.execute(userId, step.command);
      }
      results.push({
        step,
        handled: res.handled,
        pluginId: res.pluginId || step.pluginId,
        error: res.error,
      });
    }
    return results;
  }
}

export const moaAgent = new MoaAgent();
