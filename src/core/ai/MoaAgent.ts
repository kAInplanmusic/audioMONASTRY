/**
 * audioMONASTRY · MOA/MCP-Agent (DeepSeek V4 Flash als Planer)
 * ============================================================
 * Der Agent zerlegt Produktions-Aufgaben in Plugin-Schritte, schreibt die
 * Prompts für Sub-Agents, iteriert über Zwischenergebnisse und steuert die
 * Plugins über den VoiceControlService (deterministischer Fallback) bzw.
 * über die LLM-Route.
 *
 * AI-P1-003 P5 (Agent-Loop): `run()` ergänzt den reinen Plan/Execute-Pfad um
 *   - WRITE-Bestätigungspflicht (`confirmWrite`; ohne Bestätigung wird ein
 *     Schreib-Schritt NICHT ausgeführt),
 *   - Verify (fehlgeschlagene Schritte erkennen) und
 *   - eine Korrekturschleife (fehlgeschlagene Schritte werden neu geplant und
 *     erneut ausgeführt, max. `maxCorrections` Runden).
 * `executePlan()` bleibt bewusst unverändert (Rückwärtskompatibilität).
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

export interface MoaRunOptions {
  userId?: string;
  /** Zusätzlicher Kontext (Session-/Projektzustand) für den Planer. */
  context?: string;
  /**
   * WRITE-Bestätigungspflicht: wird vor jedem Schreib-Schritt gefragt.
   * Fehlt die Funktion oder liefert sie `false`, wird der Schritt NICHT
   * ausgeführt und als Fehler `WRITE nicht bestätigt` protokolliert.
   */
  confirmWrite?: (step: MoaStep) => boolean | Promise<boolean>;
  /** Max. Korrekturrunden (Default 1). */
  maxCorrections?: number;
}

export interface MoaRunResult {
  plan: MoaPlan;
  steps: MoaStepResult[];
  corrections: number;
  succeeded: boolean;
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

// ---------------------------------------------------------------------------
// WRITE-Klassifikation
// ---------------------------------------------------------------------------
/** Kommandos, die ausdrücklich nur LESEN (keine Bestätigung nötig). */
const READ_COMMANDS = new Set(['status', 'search', 'get', 'list']);

/**
 * Klassifiziert ein MOA-Kommando als Schreib-Operation.
 * Regel (fail-safe): alles, was nicht ausdrücklich in der Lese-Liste steht,
 * gilt als WRITE – ein unbekanntes Kommando verlangt damit immer Bestätigung.
 */
export function isWriteCommand(command: string): boolean {
  const name = command.split('(')[0].trim().toLowerCase();
  if (!name) return false;
  return !READ_COMMANDS.has(name);
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

/** Liefert einen Plan-String für die Korrekturschleife. */
export function correctionPromptFor(failures: MoaStepResult[]): string {
  const failed = failures
    .filter((r) => !r.handled || r.error)
    .map((r) => ({ pluginId: r.pluginId || r.step.pluginId, command: r.step.command, error: r.error ?? 'nicht ausgeführt' }));
  return `Korrigiere NUR diese fehlgeschlagenen Schritte und antworte wieder als JSON-Array: ${JSON.stringify(failed)}`;
}

export class MoaAgent {
  constructor(
    private complete: CompletionFn = (req) => completeLlm(req),
    private voice: IMoaCommandExecutor = voiceControlService,
  ) {}

  /** Plant eine Aufgabe mit DeepSeek V4 Flash (automatischer Free-Fallback). */
  async plan(task: string, pluginId = '', context = ''): Promise<MoaPlan> {
    const catalog = moaCommandCatalog();
    const role = pluginId ? moaSystemPromptForPlugin(pluginId) : moaSystemPromptForPlugin('');
    const completion = await this.complete({
      prompt:
        `${role} Zerlege die Aufgabe in klare Einzelschritte. ` +
        `Du darfst NUR diese Plugin-IDs und Kommandos verwenden (Syntax command(parameter)): ${catalog}. ` +
        `Antworte NUR als JSON-Array (keine Erklärung, kein Markdown): ` +
        `[{"pluginId":"string","command":"string","prompt":"string"}] . ` +
        (context ? `Kontext (Session-/Projektzustand): ${context.slice(0, 2000)}. ` : '') +
        `Aufgabe: ` + task,
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

  /** Führt einen Plan mit WRITE-Gate aus (ohne Korrektur). */
  async executePlanGated(plan: MoaPlan, userId: string, confirmWrite?: MoaRunOptions['confirmWrite']): Promise<MoaStepResult[]> {
    const results: MoaStepResult[] = [];
    for (const step of plan.steps) {
      if (!step.command) {
        results.push({ step, handled: false, pluginId: step.pluginId, error: 'Kein Kommando' });
        continue;
      }
      // AI-P1-003 P5: Bestätigungspflicht ab WRITE. Ohne Bestätigung wird der
      // Schritt nicht ausgeführt – fail-safe: unbekannte Kommandos sind WRITE.
      if (isWriteCommand(step.command) && !(await confirmWrite?.(step))) {
        results.push({ step, handled: false, pluginId: step.pluginId, error: 'WRITE nicht bestätigt' });
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

  /**
   * Agent-Loop (AI-P1-003 P5): planen → (WRITE-gate) ausführen → prüfen →
   * korrigieren. `maxCorrections` begrenzt die Korrekturrunden.
   */
  async run(task: string, opts: MoaRunOptions = {}): Promise<MoaRunResult> {
    const userId = opts.userId ?? 'localUser';
    const plan = await this.plan(task, '', opts.context);
    return this.runPlan(plan, opts, userId);
  }

  /** Wie `run`, aber mit bereits erzeugtem Plan. */
  async runPlan(plan: MoaPlan, opts: MoaRunOptions = {}, userId = 'localUser'): Promise<MoaRunResult> {
    const maxCorrections = Math.max(0, opts.maxCorrections ?? 1);
    let results = await this.executePlanGated(plan, userId, opts.confirmWrite);
    let corrections = 0;
    while (this.hasFailures(results) && corrections < maxCorrections) {
      corrections += 1;
      const correctionPlan = await this.plan(correctionPromptFor(results));
      const retryResults = await this.executePlanGated(correctionPlan, userId, opts.confirmWrite);
      results = this.mergeResults(results, retryResults);
    }
    return { plan, steps: results, corrections, succeeded: !this.hasFailures(results) };
  }

  private hasFailures(results: MoaStepResult[]): boolean {
    return results.some((r) => !r.handled || Boolean(r.error));
  }

  /** Ersetzt fehlgeschlagene Schritte der Reihe nach durch die Korrektur-Ergebnisse. */
  private mergeResults(original: MoaStepResult[], corrections: MoaStepResult[]): MoaStepResult[] {
    const out: MoaStepResult[] = [];
    let c = 0;
    for (const r of original) {
      if (!r.handled || r.error) {
        out.push(corrections[c] ?? r);
        c += 1;
      } else {
        out.push(r);
      }
    }
    // Überzählige Korrekturergebnisse (Planer hat mehr Schritte geliefert) anhängen.
    while (c < corrections.length) {
      out.push(corrections[c]);
      c += 1;
    }
    return out;
  }
}

export const moaAgent = new MoaAgent();
