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

export type LlmComplexity = 'simple' | 'moderate' | 'complex';

export type LlmProviderId =
  | 'runpod-local'
  | 'hf'
  | 'mistral'
  | 'ollama'
  | 'deepseek-flash'
  | 'deepseek-pro'
  | 'qwen3-coder'
  | 'publicai'
  | 'cerebras'
  | 'openrouter'
  | 'gemini'
  | 'openai';

export interface LlmCompletion {
  provider: LlmProviderId;
  text: string;
  latencyMs: number;
}

export interface LlmRequest {
  prompt: string;
  complexity: LlmComplexity;
  maxTokens?: number;
  temperature?: number;
  /** DeepSeek-V4: 'low' | 'high' | 'max' (Default: low, spart Tokens). */
  reasoningEffort?: 'low' | 'high' | 'max';
}

export interface ILlmProvider {
  readonly id: LlmProviderId;
  readonly available: boolean;
  complete(req: LlmRequest): Promise<LlmCompletion>;
}

const DEFAULT_MODELS: Record<LlmProviderId, string> = {
  // Gepinntes, heute lauffähiges Brain-Modell. Upgrade auf qwen3-32b /
  // glm-4.5-air per RUNPOD_BRAIN_MODEL, sobald die Revision gepinnt ist.
  'runpod-local': 'qwen3-14b',
  hf: 'Qwen/Qwen2.5-72B-Instruct',
  mistral: 'mistral-small-latest',
  ollama: 'qwen2.5:7b',
  'deepseek-flash': 'deepseek-v4-flash',
  'deepseek-pro': 'deepseek-v4-pro',
  'qwen3-coder': 'Qwen/Qwen3-Coder-Next',
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

function envKey(name: string): string | undefined {
  const v = (typeof process !== 'undefined' && process.env ? process.env[name] : undefined)?.trim();
  return v && v.length > 0 ? v : undefined;
}

function postJson(url: string, headers: Record<string, string>, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

async function extractText(resp: Response): Promise<string> {
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
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
    const resp = await postJson(this.baseUrl, { Authorization: `Bearer ${envKey(this.envName)}` }, body);
    return { provider: this.id, text: await extractText(resp), latencyMs: Date.now() - started };
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
    });
    return { provider: this.id, text: await extractText(resp), latencyMs: Date.now() - started };
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
    );
    return { provider: this.id, text: await extractText(resp), latencyMs: Date.now() - started };
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
    );
    return { provider: this.id, text: await extractText(resp), latencyMs: Date.now() - started };
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

  get available(): boolean {
    const openAiUrl = envKey('RUNPOD_BRAIN_OPENAI_URL');
    if (openAiUrl) return Boolean(envKey('RUNPOD_API_KEY') || envKey('RP_API_KEY'));
    return this.brainProvider().available;
  }

  private apiKey(): string | undefined {
    return envKey('RUNPOD_API_KEY') || envKey('RP_API_KEY');
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
    if (envKey('RUNPOD_BRAIN_OPENAI_URL')) {
      return envKey('RUNPOD_BRAIN_MODEL') || DEFAULT_MODELS['runpod-local'];
    }
    if (complexity === 'simple') {
      return envKey('RUNPOD_EXECUTOR_MODEL') || 'qwen3-4b';
    }
    return envKey('RUNPOD_BRAIN_MODEL') || DEFAULT_MODELS['runpod-local'];
  }

  async complete(req: LlmRequest): Promise<LlmCompletion> {
    const started = Date.now();
    const model = this.modelFor(req.complexity);
    const openAiUrl = envKey('RUNPOD_BRAIN_OPENAI_URL');
    // Qwen3 gibt sonst zuerst einen <think>-Block aus, der das Token-Budget
    // frisst. Für Tool-Calling/Interaktion ist Thinking aus; nur bei explizit
    // hohem Reasoning-Budget bleibt es an.
    const enableThinking = req.reasoningEffort === 'high' || req.reasoningEffort === 'max';

    if (openAiUrl) {
      const resp = await postJson(
        `${openAiUrl.replace(/\/+$/, '')}/chat/completions`,
        { Authorization: `Bearer ${this.apiKey()}` },
        {
          model,
          messages: [{ role: 'user', content: req.prompt }],
          max_tokens: req.maxTokens ?? 1024,
          temperature: req.temperature ?? 0.7,
          // vLLM reicht das an das Qwen3-Chat-Template durch (kein <think>-Block).
          chat_template_kwargs: { enable_thinking: enableThinking },
        },
      );
      return { provider: this.id, text: await extractText(resp), latencyMs: Date.now() - started };
    }

    const result = await this.brainProvider().run('llm', model, {
      prompt: req.prompt,
      maxTokens: req.maxTokens ?? 1024,
      temperature: req.temperature ?? 0.7,
      enableThinking,
    });
    return { provider: this.id, text: extractWorkerText(result), latencyMs: Date.now() - started };
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
   */
  rankProviders(complexity: LlmComplexity): ILlmProvider[] {
    const order: LlmProviderId[] =
      complexity === 'complex'
        ? ['runpod-local', 'ollama', 'cerebras', 'deepseek-pro', 'qwen3-coder', 'deepseek-flash', 'openrouter', 'hf', 'mistral', 'publicai', 'gemini', 'openai']
        : complexity === 'moderate'
          ? ['runpod-local', 'ollama', 'cerebras', 'deepseek-flash', 'qwen3-coder', 'openrouter', 'hf', 'mistral', 'publicai', 'deepseek-pro']
          : ['runpod-local', 'ollama', 'cerebras', 'deepseek-flash', 'hf', 'mistral', 'openrouter', 'publicai'];
    const allowExternal = envKey('AI_ALLOW_EXTERNAL_LLM') === 'true';
    return order
      .filter((id) => allowExternal || LOCAL_LLM_PROVIDERS.has(id))
      .map((id) => this.providers.get(id))
      .filter((p): p is ILlmProvider => Boolean(p) && p.available);
  }

  async complete(req: LlmRequest): Promise<LlmCompletion> {
    const ranked = this.rankProviders(req.complexity);
    if (ranked.length === 0) throw new Error('Kein LLM-Provider verfügbar (Keys fehlen).');
    let lastError: unknown;
    for (const provider of ranked) {
      try {
        return await provider.complete(req);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Alle LLM-Provider fehlgeschlagen.');
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
