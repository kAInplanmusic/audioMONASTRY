/**
 * audioMONASTRY · App-weiter AI Control Layer (LLM-Router)
 * ========================================================
 * Kosten-/Qualitäts-Priorität (Stand 2026-08, angepasst):
 *   1. SCHNELL:    Cerebras (OpenAI-kompatibel, CB_API_KEY; sehr schnelle
 *                  Inference, z.B. llama-3.3-70b – Primär für Standard-Aufgaben)
 *   2. GÜNSTIG:    DeepSeek V4 Flash (MOA/MCP-Planer, reasoning-fähig,
 *                  $0.22–0.44/M in, $0.66–1.32/M out, Peak/Off-Peak)
 *   3. KOSTENLOS:  Hugging Face Inference (HF_API_KEY)
 *   4. GÜNSTIG:    Mistral (mistral-small-latest, EU, starkes Function-
 *                  Calling & Deutsch – MISTRAL_API_KEY)
 *   5. FALLBACK:   OpenRouter (OpenAI-kompatibel, OR_API_KEY)
 *   6. LOKAL:      Ollama (MOA/Sprachbefehle/TTS-Fallback auf der eigenen
 *                  CPU-Instanz – OLLAMA_URL/OLLAMA_MODEL)
 *   7. KOMPLEX:    DeepSeek V4 Pro
 *   8. NOTFALL:    Gemini / OpenAI (bezahlt; nur bei explizitem Enable,
 *                  z.B. AI_EMERGENCY_PROVIDERS=true – nicht im Default)
 *   (Groq ist bewusst entfernt – Pay-as-you-go/Freemium-Umstellung offen.)
 *
 * Hinweis: `deepseek-chat`/`deepseek-reasoner` sind seit 2026-07-24 deprecated;
 * wir nutzen `deepseek-v4-flash`/`deepseek-v4-pro` mit `reasoning_effort`.
 *
 * Priorität seit „AI nur lokal“ (2026-09-10): `runpod-local` (Brain der
 * GPU-Flotte) → `ollama` → externe Provider (nur mit `AI_ALLOW_EXTERNAL_LLM=true`).
 * Details: docs/RUNPOD_AI_V1_SPEC.md.
 */
import { RunPodProvider } from './orchestrator/runpodProvider';
import { aiQualityTier, isRoleAllowed } from './aiGate';
import { aiLogger } from './orchestrator/aiLogger';
import { CircuitBreaker, type BreakerState } from './orchestrator/circuitBreaker';
import { CostTracker } from './orchestrator/costTracker';

export type LlmComplexity = 'simple' | 'moderate' | 'complex';

export type LlmProviderId =
  | 'runpod-local'
  | 'mistral'
  | 'ollama'
  | 'deepseek-flash'
  | 'deepseek-pro'
  | 'publicai'
  | 'cerebras'
  | 'openrouter'
  | 'gemini'
  | 'openai';

export interface LlmCompletion {
  provider: LlmProviderId;
  text: string;
  latencyMs: number;
  /**
   * INFRA-AI-004: der TATSAECHLICH angefragte Modellname (nicht der Provider).
   * Vorher landete im Kostenbuch/Eval-Record nur die Provider-ID.
   */
  model?: string;
}

export interface LlmRequest {
  prompt: string;
  complexity: LlmComplexity;
  maxTokens?: number;
  temperature?: number;
  /** DeepSeek-V4: 'low' | 'high' | 'max' (Default: low, spart Tokens). */
  reasoningEffort?: 'low' | 'high' | 'max';
  /**
   * INFRA-AI-004: Zeitlimit mit ECHTEM Abbruch. Ohne Angabe gilt
   * `LLM_TIMEOUT_MS` (Default 60 000). Ein hängender Provider blockiert die
   * Fallback-Kette damit nicht mehr endlos.
   */
  timeoutMs?: number;
  /** Zusätzliches Abbruchsignal des Aufrufers (z. B. Job-Abbruch im UI). */
  signal?: AbortSignal;
}

/** Wirksames Zeitlimit eines LLM-Aufrufs (env `LLM_TIMEOUT_MS`, Default 60 000). */
export function llmTimeoutMs(): number {
  const raw = Number(envKey('LLM_TIMEOUT_MS') ?? 60_000);
  return Number.isFinite(raw) && raw > 0 ? raw : 60_000;
}

/** Fehler eines abgebrochenen LLM-Aufrufs (Timeout oder Aufrufer-Abbruch). */
export class LlmTimeoutError extends Error {
  readonly code = 'LLM_TIMEOUT';
  constructor(ms: number) {
    super(`LLM-Aufruf nach ${ms} ms abgebrochen (LLM_TIMEOUT_MS)`);
    this.name = 'LlmTimeoutError';
  }
}

/**
 * Verbindet Aufrufer-Signal und Zeitlimit zu einem Signal. `AbortSignal.any`
 * ist Node 20+/moderne Browser; fehlt es, gewinnt das Zeitlimit.
 */
function combineSignals(timeoutMs: number, signal?: AbortSignal): { signal: AbortSignal; dispose: () => void } {
  const timeoutSignal = AbortSignal.timeout(Math.max(1, Math.floor(timeoutMs)));
  if (!signal) return { signal: timeoutSignal, dispose: () => {} };
  const anyFn = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyFn === 'function') return { signal: anyFn([timeoutSignal, signal]), dispose: () => {} };
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  timeoutSignal.addEventListener('abort', abort, { once: true });
  return {
    signal: controller.signal,
    dispose: () => signal.removeEventListener('abort', abort),
  };
}

export interface ILlmProvider {
  readonly id: LlmProviderId;
  readonly available: boolean;
  complete(req: LlmRequest): Promise<LlmCompletion>;
}

/**
 * AI-P1-008: Der OpenAI-kompatible Brain-Endpoint (worker-vllm) adressiert sein
 * Modell ueber den HUGGINGFACE-Namen, den der Endpoint tatsaechlich serviert -
 * NICHT ueber den internen Kurznamen.
 *
 * Live belegt (2026-09-18) im Worker-Log des Endpoints ppxo7wrn599p0q:
 *   `The model `qwen3-14b` does not exist.` (NotFoundError, HTTP 404)
 * Der Endpoint bietet `Qwen/Qwen3-14B-AWQ` an (`GET /openai/v1/models`). Folge:
 * jeder LLM-Aufruf scheiterte, und aufrufende Features fielen STILL auf lokale
 * Ersatzpfade zurueck (z.B. der Drop-Generator auf seinen lokalen Generator).
 */
export const OPENAI_COMPAT_BRAIN_MODEL_DEFAULT = 'Qwen/Qwen3-14B-AWQ';

/** Modellname fuer den OpenAI-kompatiblen Weg (per Env ueberschreibbar). */
export function openAiCompatBrainModel(): string {
  return envKey('RUNPOD_BRAIN_OPENAI_MODEL') || envKey('RP_BRAIN_OPENAI_MODEL') || OPENAI_COMPAT_BRAIN_MODEL_DEFAULT;
}

/**
 * INFRA-RUNPOD-003: Die Brain-Modell-Identifier, auf die der Router ohne
 * gesetzte Overrides zurückfällt.
 *
 * Diese Werte sind die Kante zum Rollen-Manifest: wer hier einen Namen ändert,
 * muss ihn dort anlegen (repository + gepinnte Revision), sonst scheitert der
 * native Pfad mit `ModelUnavailableError: unknown model`. `tests/aiModelIdentity.test.ts`
 * prüft das gegen `services/audiomonastry-ai-runtime/model_manifest.json`.
 */
export function brainModelDefaults(): { executor: string; standard: string; openAiCompat: string } {
  return {
    executor: envKey('RUNPOD_EXECUTOR_MODEL') || 'qwen3-4b',
    standard: envKey('RUNPOD_BRAIN_MODEL') || DEFAULT_MODELS['runpod-local'],
    openAiCompat: openAiCompatBrainModel(),
  };
}

const DEFAULT_MODELS: Record<LlmProviderId, string> = {
  // Gepinntes, heute lauffähiges Brain-Modell fuer den NATIVEN Worker-Weg
  // (task 'llm'): dort gelten die internen Kurznamen. Upgrade auf qwen3-32b /
  // glm-4.5-air per RUNPOD_BRAIN_MODEL, sobald die Revision gepinnt ist.
  'runpod-local': 'qwen3-14b',
  mistral: 'mistral-small-latest',
  ollama: 'qwen2.5:7b',
  'deepseek-flash': 'deepseek-v4-flash',
  'deepseek-pro': 'deepseek-v4-pro',
  publicai: 'swiss-ai/apertus-v1.5-70b-thinking',
  cerebras: 'qwen-3.8-27b',
  openrouter: 'meta-llama/llama-3.3-70b-instruct',
  gemini: 'gemini-2.0-flash',
  openai: 'gpt-4o-mini',
};

/**
 * Provider, die ohne externen Netzzugriff auskommen (lokal gehostet).
 * Seit „AI nur lokal“ sind das die einzigen, die per Default erlaubt sind.
 */
const LOCAL_LLM_PROVIDERS: ReadonlySet<LlmProviderId> = new Set<LlmProviderId>(['runpod-local', 'ollama']);

/**
 * INFRA-AI-004: Kostenbuch aller `LlmRouter`-Aufrufe.
 *
 * Der Orchestrator führt sein eigenes Buch für Jobs; LLM-Aufrufe direkt über den
 * Router (Sprachbefehle, Eval, Drop-Generator) liefen bisher an JEDER Erfassung
 * vorbei. Eigene Instanz, damit sich beide Bücher nicht gegenseitig verkürzen
 * (CostTracker prunt nach 30 Tagen), und exportiert für Status/Diagnose.
 */
export const llmCostTracker = new CostTracker();

/**
 * INFRA-AI-005: Qualitätsstufe der Einstellung in der Provider-Kette.
 *
 * Bei `high` (aiMONK = PRO) wandert das stärkere Modell nach vorn – vor den
 * schnellen Weg. Die Reihenfolge ändert sich nur, wenn der Provider überhaupt
 * registriert/zugelassen ist (`AI_ALLOW_EXTERNAL_LLM`), sonst bleibt die Kette
 * unverändert.
 */
function promoteQuality(order: LlmProviderId[]): LlmProviderId[] {
  if (!order.includes('deepseek-pro')) return order;
  const rest = order.filter((id) => id !== 'deepseek-pro');
  // Lokale Provider bleiben vorn (`runpod-local`, `ollama`); das stärkere Modell
  // schiebt sich direkt DAHINTER, vor die schnellen Cloud-Wege.
  const anchor = rest.indexOf('ollama');
  const at = anchor >= 0 ? anchor + 1 : 0;
  return [...rest.slice(0, at), 'deepseek-pro', ...rest.slice(at)];
}

function envKey(name: string): string | undefined {
  const v = (typeof process !== 'undefined' && process.env ? process.env[name] : undefined)?.trim();
  return v && v.length > 0 ? v : undefined;
}

function postJson(url: string, headers: Record<string, string>, body: unknown, signal?: AbortSignal): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
}

async function extractText(resp: Response): Promise<string> {
  if (!resp.ok) {
    // AI-P1-008: Den Fehlerkoerper mitnehmen. Ohne ihn blieb nur "HTTP 500"
    // uebrig, obwohl der Endpoint den Grund nennt ("The model `x` does not exist.")
    // - genau daran hing die Diagnose eines kaputten LLM-Wegs.
    const detail = await resp.text().catch(() => '');
    throw new Error(`HTTP ${resp.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`);
  }
  const data = await resp.json();
  const anyData = data as Record<string, unknown>;
  if (typeof anyData?.text === 'string') return anyData.text;
  if (Array.isArray(anyData?.choices) && anyData.choices.length > 0) {
    const first = anyData.choices[0] as Record<string, unknown>;
    const message = first?.message as Record<string, unknown> | undefined;
    if (typeof message?.content === 'string' && message.content.length > 0) return message.content;
    // DeepSeek-Reasoning: content kann leer sein, wenn das Reasoning-Budget
    // die Tokens verbraucht hat -> dann reasoning_content verwenden.
    if (typeof message?.reasoning_content === 'string' && message.reasoning_content.length > 0) {
      return message.reasoning_content;
    }
  }
  if (Array.isArray(anyData?.candidates) && anyData.candidates.length > 0) {
    const first = anyData.candidates[0] as Record<string, unknown>;
    const content = first?.content as { parts?: { text?: string }[] } | undefined;
    const text = content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    if (text) return text;
  }
  // Ollama /api/chat liefert { message: { content } }.
  const ollamaMessage = anyData?.message as Record<string, unknown> | undefined;
  if (typeof ollamaMessage?.content === 'string') return ollamaMessage.content;
  if (typeof anyData?.response === 'string') return anyData.response;
  return JSON.stringify(data);
}

/** OpenAI-kompatibler Chat-Provider (Mistral, DeepSeek). */
class OpenAiCompatibleProvider implements ILlmProvider {
  constructor(
    public readonly id: LlmProviderId,
    private baseUrl: string,
    private envName: string,
    private model?: string,
    private modelEnvName?: string,
  ) {}

  get available(): boolean {
    return Boolean(envKey(this.envName));
  }

  async complete(req: LlmRequest): Promise<LlmCompletion> {
    const started = Date.now();
    const model = this.model?.trim() || envKey(this.modelEnvName ?? `${this.envName}_MODEL`) || DEFAULT_MODELS[this.id];
    const body: Record<string, unknown> = {
      model,
      messages: [{ role: 'user', content: req.prompt }],
      max_tokens: req.maxTokens ?? (this.id.startsWith('deepseek') ? 1024 : 512),
      temperature: req.temperature ?? 0.7,
    };
    if (this.id === 'deepseek-flash' || this.id === 'deepseek-pro') {
      body.reasoning_effort = req.reasoningEffort ?? 'low';
    }
    const resp = await postJson(this.baseUrl, { Authorization: `Bearer ${envKey(this.envName)}` }, body, req.signal);
    return { provider: this.id, text: await extractText(resp), latencyMs: Date.now() - started, model };
  }
}

/** Lokaler Ollama-Provider (MOA/Sprachbefehle/TTS-Fallback auf der eigenen Instanz). */
class OllamaProvider implements ILlmProvider {
  readonly id = 'ollama' as const;
  get available(): boolean {
    return Boolean(envKey('OLLAMA_URL') || envKey('OLLAMA_MODEL'));
  }

  async complete(req: LlmRequest): Promise<LlmCompletion> {
    const started = Date.now();
    const base = (envKey('OLLAMA_URL') || 'http://localhost:11434').replace(/\/$/, '');
    const model = envKey('OLLAMA_MODEL') || DEFAULT_MODELS.ollama;
    const resp = await postJson(`${base}/api/chat`, {}, {
      model,
      messages: [{ role: 'user', content: req.prompt }],
      stream: false,
      options: {
        temperature: req.temperature ?? 0.7,
        num_predict: req.maxTokens ?? 512,
      },
    }, req.signal);
    return { provider: this.id, text: await extractText(resp), latencyMs: Date.now() - started, model };
  }
}

/** NOTFALL: bezahlt. Wird im Default NICHT registriert. */
class GeminiProvider implements ILlmProvider {
  readonly id = 'gemini' as const;
  get available(): boolean { return Boolean(envKey('GEMINI_API_KEY')); }

  async complete(req: LlmRequest): Promise<LlmCompletion> {
    const started = Date.now();
    const model = envKey('GEMINI_MODEL') || DEFAULT_MODELS.gemini;
    const resp = await postJson(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${envKey('GEMINI_API_KEY')}`,
      {},
      { contents: [{ parts: [{ text: req.prompt }] }] },
      req.signal,
    );
    return { provider: this.id, text: await extractText(resp), latencyMs: Date.now() - started, model };
  }
}

/** NOTFALL: bezahlt. Wird im Default NICHT registriert (keine kostenlose OpenAI-API mehr, GitHub Models ist seit 2026-07-30 eingestellt). */
class OpenAIProvider implements ILlmProvider {
  readonly id = 'openai' as const;
  get available(): boolean { return Boolean(envKey('OPENAI_API_KEY')); }

  async complete(req: LlmRequest): Promise<LlmCompletion> {
    const started = Date.now();
    const model = envKey('OPENAI_MODEL') || DEFAULT_MODELS.openai;
    const resp = await postJson(
      'https://api.openai.com/v1/chat/completions',
      { Authorization: `Bearer ${envKey('OPENAI_API_KEY')}` },
      { model, messages: [{ role: 'user', content: req.prompt }], max_tokens: req.maxTokens ?? 512 },
      req.signal,
    );
    return { provider: this.id, text: await extractText(resp), latencyMs: Date.now() - started, model };
  }
}

/**
 * Lokales Brain der GPU-Flotte (Rolle `brain`).
 *
 * Zwei Betriebsarten:
 *
 * 1. **Nativ (Default):** Der Aufruf geht über `RunPodProvider('brain')` an den
 *    Rollen-Endpoint – `POST /run` + Status-Polling mit `task: "llm"`. Der Worker
 *    führt darin den `qwen3_llm`-Handler (transformers) aus. Das ist der Pfad,
 *    den unsere Serverless-Worker tatsächlich bedienen.
 * 2. **OpenAI-kompatibel (optional):** Ist `RUNPOD_BRAIN_OPENAI_URL` gesetzt,
 *    wird stattdessen `<url>/chat/completions` aufgerufen. Das ist schneller,
 *    braucht aber ein Image mit `AI_INSTALL_VLLM=1` (vLLM im Worker).
 *
 * Grund für den Default: RunPod stellt `/openai/v1` **nicht** für beliebige
 * custom Serverless-Worker bereit – nur für vLLM-Integrationen. Der native Weg
 * funktioniert mit dem vorhandenen Image.
 *
 * Seit dem Umstieg auf „AI nur lokal“ ist das der PRIMÄRE LLM-Provider – externe
 * APIs sind per Default aus (`AI_ALLOW_EXTERNAL_LLM=true` schaltet sie zu).
 */
class RunPodLocalProvider implements ILlmProvider {
  readonly id = 'runpod-local' as const;

  /**
   * WICHTIG: `RunPodProvider` wird LAZY erzeugt, nicht als Klassenfeld.
   *
   * `LlmRouter` exportiert einen Modul-Singleton (`export const llmRouter = …`),
   * und dieses Modul landet ueber Client-Imports im Browser-Bundle. Ein Feld
   * `new RunPodProvider('brain')` lief daher schon beim Laden, griff in
   * `resolveGpuRoles()` auf `process.env` zu und liess die App mit
   * `ReferenceError: process is not defined` komplett leer rendern –
   * unbemerkt von den Node-Tests, die ein `process` haben.
   */
  private brainProvider(): RunPodProvider {
    return new RunPodProvider('brain');
  }

  /**
   * AI-P1-008: Der OpenAI-kompatible Brain-Endpoint. EINE Stelle fuer den Zugriff -
   * vorher pruefte `available` beide Schreibweisen (`RP_` und `RUNPOD_`), `complete`
   * aber nur `RUNPOD_`. Mit dem in `.env` gesetzten `RP_BRAIN_OPENAI_URL` galt der
   * Provider damit als verfuegbar, der Aufruf lief aber in den NATIVEN Worker-Pfad
   * (task 'llm' mit `{prompt,maxTokens,...}`) - und worker-vllm lehnt das ab:
   * `Job input must contain one of: openai_input (+openai_route), route (+body),
   * or prompt/messages.` Live belegt 2026-09-18.
   */
  private openAiUrl(): string | undefined {
    return envKey('RP_BRAIN_OPENAI_URL') || envKey('RUNPOD_BRAIN_OPENAI_URL') || undefined;
  }

  get available(): boolean {
    // INFRA-FEAT-001: Bei „AI aus“ ist das Brain nicht verfügbar – `rankProviders`
    // lässt den GPU-Provider dann aus und es geht nichts Richtung RunPod
    // (lokale Pfade: Ollama/deterministisch).
    if (!isRoleAllowed('brain')) return false;
    if (this.openAiUrl()) return Boolean(envKey('RP_AGENT_KEY') || envKey('RP_API_KEY') || envKey('RUNPOD_API_KEY'));
    return this.brainProvider().available;
  }

  private apiKey(): string | undefined {
    return envKey('RP_AGENT_KEY') || envKey('RP_API_KEY') || envKey('RUNPOD_API_KEY');
  }

  /**
   * Modellwahl.
   *
   * - **vLLM-Brain** (`RUNPOD_BRAIN_OPENAI_URL` gesetzt): der vorgefertigte
   *   RunPod-Worker serviert GENAU EIN Modell → beide Stufen nutzen es.
   * - **Eigener Worker** (nativer `task: "llm"`-Weg): zwei Stufen derselben
   *   Familie — `qwen3-4b` (Ausführer, `simple`) + `qwen3-14b` (`moderate`/`complex`).
   */
  private modelFor(complexity: LlmComplexity): string {
    if (this.openAiUrl()) {
      // OpenAI-kompatibler Endpoint: HF-Modellname (siehe openAiCompatBrainModel).
      // `RUNPOD_BRAIN_OPENAI_MODEL` gewinnt, dann ein gesetztes RUNPOD_BRAIN_MODEL,
      // sonst der Default des Endpoint-Images.
      return envKey('RUNPOD_BRAIN_OPENAI_MODEL') || envKey('RP_BRAIN_OPENAI_MODEL')
        || envKey('RUNPOD_BRAIN_MODEL') || OPENAI_COMPAT_BRAIN_MODEL_DEFAULT;
    }
    // INFRA-AI-005: Im Modus PRO (`on-with-visuals`, Qualitätsstufe `high`) wählt
    // der Router auch für `simple` das große Brain-Modell – die Einstellung hat
    // damit eine nachweisbare Kante bis in die Modellwahl. Standard bleibt beim
    // schnellen Ausführer (qwen3-4b), weil dort Latenz und Kosten zählen.
    if (complexity === 'simple' && aiQualityTier() === 'standard') {
      return envKey('RUNPOD_EXECUTOR_MODEL') || 'qwen3-4b';
    }
    return envKey('RUNPOD_BRAIN_MODEL') || DEFAULT_MODELS['runpod-local'];
  }

  async complete(req: LlmRequest): Promise<LlmCompletion> {
    const started = Date.now();
    const model = this.modelFor(req.complexity);
    const openAiUrl = this.openAiUrl();
    // Qwen3 gibt sonst zuerst einen <think>-Block aus, der das Token-Budget
    // frisst. Für Tool-Calling/Interaktion ist Thinking aus; nur bei explizit
    // hohem Reasoning-Budget bleibt es an.
    const enableThinking = req.reasoningEffort === 'high' || req.reasoningEffort === 'max';

    if (openAiUrl) {
      const url = `${openAiUrl.replace(/\/+$/, '')}/chat/completions`;
      let text: string;
      try {
        const resp = await postJson(
          url,
          { Authorization: `Bearer ${this.apiKey()}` },
          {
            model,
            messages: [{ role: 'user', content: req.prompt }],
            max_tokens: req.maxTokens ?? 1024,
            temperature: req.temperature ?? 0.7,
            // vLLM reicht das an das Qwen3-Chat-Template durch (kein <think>-Block).
            chat_template_kwargs: { enable_thinking: enableThinking },
          },
          req.signal,
        );
        // `extractText` wirft bei HTTP != 2xx ("HTTP 500") - das muss in denselben
        // catch, sonst bleibt ein abgelehnter Modellname unerklaerlich.
        text = await extractText(resp);
      } catch (error) {
        // AI-P1-008: Der haeufigste Fehler war ein falscher Modellname. Der
        // Endpoint antwortet dann mit 404/`worker_error` - ohne Hinweis bleibt nur
        // ein stiller Fallback auf lokale Ersatzpfade. Deshalb hier eine klare
        // Meldung mit dem probierten Modell und der Stellschraube.
        // Fehler koennen als Error (mit .message) oder als Objekt kommen - beides
        // beruecksichtigen, `JSON.stringify(new Error(...))` liefert nur "{}".
        const errorMessage = error instanceof Error ? error.message : '';
        const detail = `${errorMessage} ${JSON.stringify(error)}`.trim();
        if (/does not exist|NotFoundError|worker_error/i.test(detail)) {
          throw new Error(
            `Brain-Endpoint lehnt Modell '${model}' ab (${detail.slice(0, 200)}). `
            + 'Pruefen: serviert der Endpoint dieses Modell? Stellschraube: RUNPOD_BRAIN_OPENAI_MODEL '
            + `(Endpoint-Modelle: GET ${openAiUrl.replace(/\/+$/, '')}/models).`,
          );
        }
        throw error;
      }
      return { provider: this.id, text: text!, latencyMs: Date.now() - started, model };
    }

    const result = await this.brainProvider().run('llm', model, {
      prompt: req.prompt,
      maxTokens: req.maxTokens ?? 1024,
      temperature: req.temperature ?? 0.7,
      enableThinking,
    }, req.signal);
    return { provider: this.id, text: extractWorkerText(result), latencyMs: Date.now() - started, model };
  }
}

/**
 * Zieht den generierten Text aus der Worker-Antwort.
 * Der Worker liefert `{ status, task, model, result: { text } }`.
 */
export function extractWorkerText(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object') {
    const record = result as Record<string, unknown>;
    if (typeof record.text === 'string') return record.text;
    const nested = record.result as Record<string, unknown> | undefined;
    if (nested && typeof nested.text === 'string') return nested.text;
  }
  return '';
}

export class LlmRouter {
  private providers = new Map<LlmProviderId, ILlmProvider>();
  /** INFRA-AI-004: ein Breaker je Provider – ein Ausfall zählt jetzt sichtbar. */
  private breakers = new Map<LlmProviderId, CircuitBreaker>();
  private costCounter = 0;

  constructor() {
    // Lokales Brain zuerst registrieren – es ist der primäre Provider.
    this.register(new RunPodLocalProvider());
    this.register(new OpenAiCompatibleProvider('mistral', 'https://api.mistral.ai/v1/chat/completions', 'MISTRAL_API_KEY'));
    this.register(new OllamaProvider());
    this.register(new OpenAiCompatibleProvider('deepseek-flash', 'https://api.deepseek.com/chat/completions', 'DEEPSEEK_API_KEY'));
    this.register(new OpenAiCompatibleProvider('deepseek-pro', 'https://api.deepseek.com/chat/completions', 'DEEPSEEK_API_KEY'));
    // PublicAI: OpenAI-kompatibel, Modell aus PUBLICAI_MODEL.
    const publicaiBase = (envKey('PUBLICAI_BASE_URL') || 'https://api.publicai.co/v1').replace(/\/+$/, '');
    this.register(new OpenAiCompatibleProvider('publicai', `${publicaiBase}/chat/completions`, 'PUBLICAI_KEY', undefined, 'PUBLICAI_MODEL'));

    // Cerebras: sehr schnelle Inference, OpenAI-kompatibel (Primär für Standard-Aufgaben).
    this.register(new OpenAiCompatibleProvider('cerebras', 'https://api.cerebras.ai/v1/chat/completions', 'CB_API_KEY', undefined, 'CEREBRAS_MODEL'));
    // OpenRouter: bezahlter Multi-Model-Fallback, OpenAI-kompatibel.
    this.register(new OpenAiCompatibleProvider('openrouter', 'https://openrouter.ai/api/v1/chat/completions', 'OR_API_KEY', undefined, 'OPENROUTER_MODEL'));

    // Notfall-Provider (bezahlt) nur bei explizitem Enable registrieren.
    if (envKey('AI_EMERGENCY_PROVIDERS') === 'true') {
      this.register(new GeminiProvider());
      this.register(new OpenAIProvider());
    }
  }

  register(provider: ILlmProvider): void {
    this.providers.set(provider.id, provider);
  }

  /** Liefert alle registrierten Provider-IDs (für Admin-/Debug-Endpunkte). */
  providerIds(): LlmProviderId[] {
    return [...this.providers.keys()];
  }

  /**
   * Liefert die Provider in der gültigen Reihenfolge.
   *
   * Das lokale Brain (`runpod-local`) steht immer vorn; `ollama` ist der
   * wirklich lokale Notfall-Fallback. Externe/bezahlte Provider bleiben
   * registriert, werden aber nur mit `AI_ALLOW_EXTERNAL_LLM=true` zugelassen.
   *
   * INFRA-AI-005: Die Qualitätsstufe der Einstellung verschiebt die Reihenfolge –
   * bei `high` (aiMONK = PRO) steht das stärkere Modell (`deepseek-pro`) vor dem
   * schnellen `deepseek-flash`, bei `standard` bleibt es beim günstigen Weg.
   */
  rankProviders(complexity: LlmComplexity): ILlmProvider[] {
    const base: LlmProviderId[] =
      complexity === 'complex'
        ? ['runpod-local', 'ollama', 'cerebras', 'deepseek-pro', 'deepseek-flash', 'openrouter', 'mistral', 'publicai', 'gemini', 'openai']
        : complexity === 'moderate'
          ? ['runpod-local', 'ollama', 'cerebras', 'deepseek-flash', 'openrouter', 'mistral', 'publicai', 'deepseek-pro']
          : ['runpod-local', 'ollama', 'cerebras', 'deepseek-flash', 'mistral', 'openrouter', 'publicai'];
    const order = aiQualityTier() === 'high' ? promoteQuality(base) : base;
    const allowExternal = envKey('AI_ALLOW_EXTERNAL_LLM') === 'true';
    return order
      .filter((id) => allowExternal || LOCAL_LLM_PROVIDERS.has(id))
      .map((id) => this.providers.get(id))
      .filter((p): p is ILlmProvider => Boolean(p) && p.available);
  }

  /** Breaker eines Providers (wird bei Bedarf angelegt). */
  private breakerFor(id: LlmProviderId): CircuitBreaker {
    const existing = this.breakers.get(id);
    if (existing) return existing;
    const breaker = new CircuitBreaker(`llm:${id}`);
    this.breakers.set(id, breaker);
    return breaker;
  }

  /** Zustand aller Breaker (Diagnose/Statusrouten, ohne Netzwerk). */
  breakerStates(): Record<string, BreakerState> {
    const states: Record<string, BreakerState> = {};
    for (const [id, breaker] of this.breakers) states[id] = breaker.getState();
    return states;
  }

  /**
   * INFRA-AI-004: Kosten je LLM-Aufruf erfassen. Vorher liefen LlmRouter-Aufrufe
   * am Kostenbuch vorbei (nur Orchestrator-Jobs wurden verbucht).
   */
  private recordCost(completion: LlmCompletion, complexity: LlmComplexity): void {
    this.costCounter += 1;
    const provider = completion.provider;
    const model = completion.model ?? provider;
    try {
      llmCostTracker.record({
        jobId: `llm-${this.costCounter}`,
        sessionId: 'llm-router',
        provider,
        task: 'llm',
        model,
        gpuType: 'CPU',
        gpuRuntimeMs: Math.max(0, Math.round(completion.latencyMs)),
        inferenceMs: Math.max(0, Math.round(completion.latencyMs)),
        estimatedCostUsd: Number(llmCostTracker.estimateJobCostUsd('llm', provider, model).toFixed(6)),
      });
    } catch (error) {
      // Die Kostenbuchung darf den Aufruf nie verhindern.
      aiLogger.warn('llm cost record failed', { provider, complexity, error: (error as Error).message });
    }
  }

  /** Kostenzusammenfassung der LlmRouter-Aufrufe (Diagnose). */
  costSummary(): ReturnType<CostTracker['summary']> {
    return llmCostTracker.summary();
  }

  async complete(req: LlmRequest): Promise<LlmCompletion> {
    const timeoutMs = req.timeoutMs ?? llmTimeoutMs();
    const { signal, dispose } = combineSignals(timeoutMs, req.signal);
    const request: LlmRequest = signal === req.signal ? req : { ...req, signal };
    try {
      const ranked = this.rankProviders(req.complexity);
      if (ranked.length === 0) throw new Error('Kein LLM-Provider verfügbar (Keys fehlen).');
      let lastError: unknown;
      for (const provider of ranked) {
        const breaker = this.breakerFor(provider.id);
        if (breaker.getState() === 'OPEN') {
          aiLogger.warn('llm provider skipped: circuit breaker open', { provider: provider.id });
          lastError = new Error(`circuit breaker open: llm:${provider.id}`);
          continue;
        }
        try {
          const completion = await breaker.call(() => provider.complete(request));
          this.recordCost(completion, req.complexity);
          return completion;
        } catch (error) {
          lastError = error;
          aiLogger.warn('llm provider failed, trying next', {
            provider: provider.id,
            error: (error as Error).message,
          });
        }
      }
      // Abbruch (Zeitlimit/Aufrufer) klar benennen, damit Aufrufer nicht auf
      // einen Provider-Fehler schließen.
      if (signal.aborted && !req.signal?.aborted) throw new LlmTimeoutError(timeoutMs);
      throw lastError instanceof Error ? lastError : new Error('Alle LLM-Provider fehlgeschlagen.');
    } finally {
      dispose();
    }
  }

  /**
   * MOA/MCP-Planung: bevorzugt DeepSeek V4 Flash (günstig, reasoning-fähig),
   * fällt automatisch auf HF/Mistral/Ollama zurück.
   */
  async plan(task: string, maxTokens = 1024): Promise<LlmCompletion> {
    const prompt =
      'Du bist der MOA/MCP-Planer von audioMONASTRY. Zerlege die Aufgabe in klare ' +
      'Einzelschritte und antworte NUR als JSON-Array (keine Erklärung, kein Markdown): ' +
      '[{"pluginId":"string","command":"string","prompt":"string"}] . Aufgabe: ' + task;
    return this.complete({ prompt, complexity: 'moderate', maxTokens, temperature: 0.3, reasoningEffort: 'low' });
  }
}

export const llmRouter = new LlmRouter();
