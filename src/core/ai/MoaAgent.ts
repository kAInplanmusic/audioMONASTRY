/**
 * audioMONASTRY · MOA/MCP-Agent – Planung (client-/appseitig)
 * ==========================================================
 * INFRA-AI-006: Es gibt ZWEI benannte MoA-Zustaendigkeiten, nicht zwei
 * konkurrierende Implementierungen:
 *
 *   * HIER – **MoA-Planung**: ein LLM-Call (DeepSeek V4 Flash) zerlegt eine
 *     Aufgabe in Plugin-Schritte `[{pluginId, command, prompt}]`; ausgefuehrt
 *     werden sie von der Client-Plugin-Registry bzw. dem VoiceControlService.
 *     Schnell, UI-nah, ohne GPU-Flotte.
 *   * SERVERSEITIG – **MoA-Ausfuehrung**: `services/audiomonastry-ai-runtime/
 *     moa_orchestrator.py` (Rolle `orchestrator`, Classifier → Planner A/B →
 *     Aggregator → MCP-Tools, Schema `{steps:[{tool,args,why}]}`). Erreichbar
 *     ausschliesslich ueber das MCP-Tool `agent.orchestrate`
 *     (`POST /api/ai/mcp/tools/agent.orchestrate`) – das ist die EINZIGE Kante
 *     zwischen beiden Wegen. Wer den einen Weg aendert, laesst den anderen
 *     unberuehrt; der Waechter tests/moaBoundary.test.ts haelt die Rollen fest.
 *
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
import { MOA_GLOBAL_PROMPT_KEY, promptStore, type PromptStore } from './orchestrator/promptStore';

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
   * AI-P1-006: Abbruch. Wird vor jedem Schritt und vor jeder Korrekturrunde
   * geprueft - der Lauf endet dann sauber mit `cancelled:true` und dem bisherigen
   * Protokoll, statt mitten in einer Ausfuehrung abzureissen.
   */
  signal?: AbortSignal;
  /**
   * AI-P1-006: Wiederaufnahme. Schritte vor `startIndex` gelten als erledigt und
   * werden NICHT erneut ausgefuehrt; ihre Ergebnisse kommen aus `priorResults`.
   */
  startIndex?: number;
  priorResults?: MoaStepResult[];
  /**
   * AI-P1-006: Rueckmeldung nach jedem ausgeführten Schritt (fuer die
   * persistente Fortsetzung: der Aufrufer schreibt den Stand weg).
   */
  onStep?: (info: { index: number; result: MoaStepResult; executedCount: number }) => void | Promise<void>;
  /**
   * WRITE-Bestätigungspflicht: wird vor jedem Schreib-Schritt gefragt.
   * Fehlt die Funktion oder liefert sie `false`, wird der Schritt NICHT
   * ausgeführt und als Fehler `WRITE nicht bestätigt` protokolliert.
   */
  confirmWrite?: (step: MoaStep) => boolean | Promise<boolean>;
  /** Max. Korrekturrunden (Default 1). */
  maxCorrections?: number;
}

/**
 * AI-P1-006: Kosten eines Laufs. Sie entstehen in der PLANUNG und in den
 * KORREKTURRUNDEN (LLM-Aufrufe) - die Ausfuehrung selbst sind lokale
 * Plugin-Kommandos und kosten nichts. Deshalb getrennt ausgewiesen, statt eine
 * Zahl zu zeigen, die niemand zuordnen kann.
 */
export interface MoaRunCost {
  totalUsd: number;
  planningUsd: number;
  correctionsUsd: number;
  /** Wahr, wenn Teile geschaetzt und nicht vom Anbieter gemeldet sind. */
  estimated: boolean;
}

export interface MoaRunResult {
  plan: MoaPlan;
  steps: MoaStepResult[];
  corrections: number;
  succeeded: boolean;
  /** AI-P1-006: Gesamtkosten des Laufs (siehe MoaRunCost). */
  costUsd: number;
  cost: MoaRunCost;
  /** AI-P1-006: Lauf wurde abgebrochen (nicht alle Schritte ausgefuehrt). */
  cancelled: boolean;
}

type CompletionFn = (req: LlmRequest) => Promise<LlmCompletion>;

/** Minimale Schnittstelle für die Plugin-Steuerung (VoiceControlService erfüllt sie). */
export interface IMoaCommandExecutor {
  execute(userId: string, command: string): Promise<{ handled: boolean; pluginId: string; error?: string }>;
  /**
   * AI-P1-006: Meldet, dass dieses Kommando NUR LIEST.
   *
   * Das WRITE-Gate ist fail-safe: es behandelt jedes unbekannte Kommando als
   * schreibend, weil der Server nicht wissen kann, was ein Plugin damit tut.
   * Ein Executor WEISS es (z. B. MCP-Werkzeuge tragen `permission: READ`) -
   * deshalb kann er es hier belegen. Fehlt die Methode, bleibt es beim
   * fail-safe Verhalten (Schritt gilt als WRITE).
   */
  isReadOnly?(pluginId: string, command: string): boolean;
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

/** Zeitlimit um eine Zusage; laeuft die Zeit ab, gibt es eine klare Meldung. */
export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Zeitlimit ueberschritten (${timeoutMs} ms)`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * AI-P1-006: Kostenschaetzung eines LLM-Aufrufs. Der LlmRouter liefert keinen
 * Preis, deshalb Naeherung ueber die Zeichenzahl (4 Zeichen ~ 1 Token) mit
 * konfigurierbarem Preis. Das Ergebnis ist ausdruecklich als Schaetzung markiert
 * (`estimated: true`) - so wird es auch angezeigt.
 */
export function estimateLlmCostUsd(req: LlmRequest, res: LlmCompletion): number {
  const perThousand = envNumber('AI_AGENT_COST_PER_1K_USD', 0.0002);
  const chars = String(req.prompt ?? '').length + String(res?.text ?? '').length;
  return Number(((chars / 4 / 1000) * perThousand).toFixed(6));
}

/**
 * AI-P1-006: Zeitlimit fuer einen Planungs-/Korrekturaufruf. Live belegt
 * (2026-09-18): ein haengender LLM-Aufruf liess den Agent-Lauf endlos in
 * 'running' stehen - ohne Limit gibt es weder Ergebnis noch Abbruchgrund.
 */
export const DEFAULT_PLAN_TIMEOUT_MS = 45_000;

/**
 * Env-Wert lesen, OHNE im Browser zu crashen: `process` gibt es dort nicht, und
 * schon ein Zugriff auf Modulebene laesst das Bundle beim Laden scheitern.
 *
 * Genau dieser Fehler ist passiert (E2E: "Uncaught ReferenceError: process is not
 * defined", Quelle src/core/ai/MoaAgent.ts) - die Node-Tests konnten ihn nicht
 * sehen, weil sie ein `process` haben.
 */
function envNumber(name: string, fallback: number): number {
  try {
    if (typeof process === 'undefined' || !process?.env) return fallback;
    const parsed = Number(process.env[name]);
    return Number.isFinite(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export class MoaAgent {
  constructor(
    private complete: CompletionFn = (req) => completeLlm(req),
    private voice: IMoaCommandExecutor = voiceControlService,
    /** AI-P1-006: Kostenschaetzung (injizierbar fuer Tests). */
    private estimateCost: (req: LlmRequest, res: LlmCompletion) => number = estimateLlmCostUsd,
    /**
     * AI-P1-006: Zeitlimit je Planungs-/Korrekturaufruf.
     * `0` (Default) heisst: `AI_AGENT_PLAN_TIMEOUT_MS` lesen, sonst
     * `DEFAULT_PLAN_TIMEOUT_MS`. Ein fester Default hier machte die Env
     * wirkungslos - live belegt: mit `AI_AGENT_PLAN_TIMEOUT_MS=240000` brach ein
     * Kaltstart des Brain-Endpoints trotzdem nach 45 s ab.
     */
    private planTimeoutMs: number = 0,
    /**
     * AI-P1-006: Katalog fuer den Plan-Prompt. Ohne Angabe der Plugin-Katalog
     * (Client-Pfad). Serverseitige Laeufe setzen hier die MCP-Werkzeuge ein -
     * dann plant das Modell nur Dinge, die der Server auch ausfuehren kann.
     */
    private planCatalog?: string,
    /**
     * INFRA-AI-003: Prompt-Versionierung. Die im Store AKTIVE Version eines
     * Plugins gewinnt gegen die Konstante `PLUGIN_MOA_SYSTEM_PROMPTS`; ohne
     * Store-Eintrag bleibt es beim Konstante-Text. Injizierbar fuer Tests.
     */
    private prompts: PromptStore = promptStore,
  ) {}

  /**
   * INFRA-AI-003: Systemprompt fuer den Plan-Aufruf. Reihenfolge:
   * aktive Store-Version (Plugin-Schluessel, sonst `MOA_GLOBAL_PROMPT_KEY`) →
   * Konstante aus `PLUGIN_MOA_SYSTEM_PROMPTS`.
   */
  private systemPromptFor(pluginId: string): string {
    const stored = this.prompts?.getActive(pluginId || MOA_GLOBAL_PROMPT_KEY)
      ?? (pluginId ? this.prompts?.getActive(MOA_GLOBAL_PROMPT_KEY) : null);
    if (stored && stored.content.trim().length > 0) return stored.content;
    return moaSystemPromptForPlugin(pluginId);
  }

  /** Plant eine Aufgabe mit DeepSeek V4 Flash (automatischer Free-Fallback). */
  async plan(task: string, pluginId = '', context = '', onCost?: (usd: number) => void): Promise<MoaPlan> {
    const catalog = this.planCatalog && this.planCatalog.trim().length > 0
      ? this.planCatalog
      : moaCommandCatalog();
    const role = this.systemPromptFor(pluginId);
    const timeoutMs = Number.isFinite(this.planTimeoutMs) && this.planTimeoutMs > 0
      ? this.planTimeoutMs
      : envNumber('AI_AGENT_PLAN_TIMEOUT_MS', DEFAULT_PLAN_TIMEOUT_MS);
    const completion = await withTimeout(this.complete({
      prompt:
        `${role} Zerlege die Aufgabe in klare Einzelschritte. ` +
        `Du darfst NUR diese Plugin-IDs und Kommandos verwenden (Syntax command(parameter)): ${catalog}. ` +
        `Antworte NUR als JSON-Array (keine Erklärung, kein Markdown): ` +
        `[{"pluginId":"string","command":"string","prompt":"string"}] . ` +
        (context ? `Kontext (Session-/Projektzustand): ${context.slice(0, 2000)}. ` : '') +
        `Aufgabe: ` + task,
      complexity: 'moderate',
      // 1536 statt 1024: ein Reasoning-Modell verbraucht Tokens fuers Denken,
      // bevor die JSON-Antwort kommt. Live belegt (2026-09-18): bei 1024 kam
      // NUR der Denktext an, kein JSON-Array - der Plan war leer.
      maxTokens: 1536,
      temperature: 0.3,
      reasoningEffort: 'low',
    }), timeoutMs);
    // AI-P1-006: Kosten dieses Planungsaufrufs melden (Schaetzung, siehe
    // estimateLlmCostUsd) - der Aufrufer summiert sie.
    onCost?.(this.estimateCost(
      { prompt: task, complexity: 'moderate' },
      completion,
    ));
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

  /**
   * Führt einen Plan mit WRITE-Gate aus (ohne Korrektur).
   *
   * AI-P1-006: `startIndex`/`priorResults` erlauben die Wiederaufnahme (bereits
   * erledigte Schritte werden uebernommen statt erneut ausgefuehrt), `signal`
   * bricht kooperativ vor dem naechsten Schritt ab und `onStep` meldet jeden
   * ausgeführten Schritt (fuer die persistente Fortsetzung).
   */
  async executePlanGated(
    plan: MoaPlan,
    userId: string,
    confirmWrite?: MoaRunOptions['confirmWrite'],
    options: {
      signal?: AbortSignal;
      startIndex?: number;
      priorResults?: MoaStepResult[];
      onStep?: MoaRunOptions['onStep'];
    } = {},
  ): Promise<{ results: MoaStepResult[]; cancelled: boolean }> {
    const startIndex = Math.max(0, Math.floor(options.startIndex ?? 0));
    const results: MoaStepResult[] = [...(options.priorResults ?? [])];
    let cancelled = false;
    for (let index = 0; index < plan.steps.length; index += 1) {
      const step = plan.steps[index];
      // Bereits erledigt (Wiederaufnahme): Ergebnis uebernehmen, nichts tun.
      if (index < startIndex) continue;
      // Abbruch VOR dem Schritt: der Lauf endet hier, nichts halb Ausgefuehrtes.
      if (options.signal?.aborted) { cancelled = true; break; }
      if (!step.command) {
        results.push({ step, handled: false, pluginId: step.pluginId, error: 'Kein Kommando' });
        await options.onStep?.({ index, result: results[results.length - 1], executedCount: results.length });
        continue;
      }
      // AI-P1-003 P5: Bestätigungspflicht ab WRITE. Ohne Bestätigung wird der
      // Schritt nicht ausgeführt – fail-safe: unbekannte Kommandos sind WRITE.
      // AI-P1-006: Weiss der Executor, dass das Kommando nur liest (MCP-Werkzeug
      // mit permission READ), braucht es keine Schreib-Bestätigung.
      const readOnlyByExecutor = this.voice.isReadOnly?.(step.pluginId, step.command) === true;
      if (!readOnlyByExecutor && isWriteCommand(step.command) && !(await confirmWrite?.(step))) {
        results.push({ step, handled: false, pluginId: step.pluginId, error: 'WRITE nicht bestätigt' });
        continue;
      }
      let res: { handled: boolean; pluginId: string; error?: string };
      if (this.voice.executePluginCommand && step.pluginId && step.pluginId !== 'unknown') {
        res = await this.voice.executePluginCommand(userId, step.pluginId, step.command);
      } else {
        res = await this.voice.execute(userId, step.command);
      }
      const result: MoaStepResult = {
        step,
        handled: res.handled,
        pluginId: res.pluginId || step.pluginId,
        error: res.error,
      };
      results.push(result);
      await options.onStep?.({ index, result, executedCount: results.length });
    }
    return { results, cancelled };
  }

  /**
   * Agent-Loop (AI-P1-003 P5): planen → (WRITE-gate) ausführen → prüfen →
   * korrigieren. `maxCorrections` begrenzt die Korrekturrunden.
   *
   * AI-P1-006: zusaetzlich abbrechbar (`signal`), wiederaufnehmbar
   * (`startIndex`/`priorResults`) und mit Kostenausweis (`cost`).
   */
  async run(task: string, opts: MoaRunOptions = {}): Promise<MoaRunResult> {
    const userId = opts.userId ?? 'localUser';
    const cost: MoaRunCost = { totalUsd: 0, planningUsd: 0, correctionsUsd: 0, estimated: true };
    const plan = await this.plan(task, '', opts.context, (usd) => { cost.planningUsd += usd; });
    return this.runPlan(plan, opts, userId, cost);
  }

  /** Wie `run`, aber mit bereits erzeugtem Plan. */
  async runPlan(
    plan: MoaPlan,
    opts: MoaRunOptions = {},
    userId = 'localUser',
    cost: MoaRunCost = { totalUsd: 0, planningUsd: 0, correctionsUsd: 0, estimated: true },
  ): Promise<MoaRunResult> {
    const maxCorrections = Math.max(0, opts.maxCorrections ?? 1);
    const first = await this.executePlanGated(plan, userId, opts.confirmWrite, {
      signal: opts.signal,
      startIndex: opts.startIndex,
      priorResults: opts.priorResults,
      onStep: opts.onStep,
    });
    let results = first.results;
    let cancelled = first.cancelled;
    let corrections = 0;
    // Ein LEERER Plan ist kein Erfolg: der Planer hat dann nichts Ausfuehrbares
    // geliefert (typisch: das Modell antwortet nur mit Denktext statt JSON).
    // Live belegt (2026-09-18): der Lauf meldete "succeeded" bei null Schritten -
    // ein stiller Leer-Erfolg. Deshalb zaehlt ein leerer Plan wie ein Fehlschlag
    // und loest die Korrekturrunde aus.
    const planIsEmpty = (): boolean => plan.steps.length === 0;
    while (!cancelled && (this.hasFailures(results) || planIsEmpty()) && corrections < maxCorrections) {
      if (opts.signal?.aborted) { cancelled = true; break; }
      corrections += 1;
      const correctionPrompt = planIsEmpty()
        ? 'Die vorige Antwort enthielt KEIN JSON-Array. Antworte JETZT ausschliesslich mit dem JSON-Array '
          + '[{"pluginId":"...","command":"...","prompt":"..."}] ohne jeden weiteren Text. Aufgabe: '
        : correctionPromptFor(results);
      const correctionPlan = await this.plan(
        correctionPrompt,
        '',
        '',
        (usd) => { cost.correctionsUsd += usd; },
      );
      if (correctionPlan.steps.length > 0 && planIsEmpty()) {
        // Ersatzplan uebernehmen: der leere Plan war unbrauchbar.
        plan.steps = correctionPlan.steps;
      }
      const retry = await this.executePlanGated(correctionPlan, userId, opts.confirmWrite, {
        signal: opts.signal,
        onStep: opts.onStep,
      });
      results = this.mergeResults(results, retry.results);
      if (retry.cancelled) { cancelled = true; break; }
    }
    cost.totalUsd = Number((cost.planningUsd + cost.correctionsUsd).toFixed(6));
    return {
      plan,
      steps: results,
      corrections,
      // Ein abgebrochener Lauf ist nicht "erfolgreich", auch wenn die bisherigen
      // Schritte griffen - sonst wuerde ein Abbruch als Erfolg angezeigt. Und ein
      // Lauf ohne ausgefuehrten Schritt ist ebenfalls kein Erfolg.
      succeeded: !cancelled && !this.hasFailures(results) && results.length > 0,
      costUsd: cost.totalUsd,
      cost,
      cancelled,
    };
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
