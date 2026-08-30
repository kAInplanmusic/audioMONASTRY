/**
 * audioMONASTRY · App-weiter AI Control Layer (LLM-Router)
 * ========================================================
 * Kosten-/Qualitäts-Priorität (Stand 2026-08, angepasst):
 *   1. GÜNSTIG:    DeepSeek V4 Flash (MOA/MCP-Planer, reasoning-fähig,
 *                  $0.22–0.44/M in, $0.66–1.32/M out, Peak/Off-Peak)
 *   2. KOSTENLOS:  Hugging Face Inference (HF_API_KEY)
 *   3. GÜNSTIG:    Mistral (mistral-small-latest, EU, starkes Function-
 *                  Calling & Deutsch – MISTRAL_API_KEY)
 *   4. LOKAL:      Ollama (MOA/Sprachbefehle/TTS-Fallback auf der eigenen
 *                  CPU-Instanz – OLLAMA_URL/OLLAMA_MODEL)
 *   5. KOMPLEX:    DeepSeek V4 Pro
 *   6. NOTFALL:    Gemini / OpenAI (bezahlt; nur bei explizitem Enable,
 *                  z.B. AI_EMERGENCY_PROVIDERS=true – nicht im Default)
 *   (Groq ist bewusst entfernt – Pay-as-you-go/Freemium-Umstellung offen.)
 *
 * Hinweis: `deepseek-chat`/`deepseek-reasoner` sind seit 2026-07-24 deprecated;
 * wir nutzen `deepseek-v4-flash`/`deepseek-v4-pro` mit `reasoning_effort`.
 */

export type LlmComplexity = 'simple' | 'moderate' | 'complex';

export type LlmProviderId =
  | 'hf'
  | 'mistral'
  | 'ollama'
  | 'deepseek-flash'
  | 'deepseek-pro'
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
  hf: 'mistralai/Mistral-7B-Instruct-v0.3',
  mistral: 'mistral-small-latest',
  ollama: 'qwen2.5:7b',
  'deepseek-flash': 'deepseek-v4-flash',
  'deepseek-pro': 'deepseek-v4-pro',
  gemini: 'gemini-2.0-flash',
  openai: 'gpt-4o-mini',
};

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
  ) {}

  get available(): boolean {
    return Boolean(envKey(this.envName));
  }

  async complete(req: LlmRequest): Promise<LlmCompletion> {
    const started = Date.now();
    const model = this.model?.trim() || envKey(`${this.envName}_MODEL`) || DEFAULT_MODELS[this.id];
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

class HfProvider implements ILlmProvider {
  readonly id = 'hf' as const;
  get available(): boolean { return Boolean(envKey('HF_API_KEY')); }

  async complete(req: LlmRequest): Promise<LlmCompletion> {
    const started = Date.now();
    const model = envKey('HF_LLM_MODEL') || DEFAULT_MODELS.hf;
    const resp = await postJson(
      `https://api-inference.huggingface.co/models/${model}`,
      { Authorization: `Bearer ${envKey('HF_API_KEY')}` },
      { inputs: req.prompt, parameters: { max_new_tokens: req.maxTokens ?? 256, temperature: req.temperature ?? 0.7 } },
    );
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

export class LlmRouter {
  private providers = new Map<LlmProviderId, ILlmProvider>();

  constructor() {
    this.register(new HfProvider());
    this.register(new OpenAiCompatibleProvider('mistral', 'https://api.mistral.ai/v1/chat/completions', 'MISTRAL_API_KEY'));
    this.register(new OllamaProvider());
    this.register(new OpenAiCompatibleProvider('deepseek-flash', 'https://api.deepseek.com/chat/completions', 'DEEPSEEK_API_KEY'));
    this.register(new OpenAiCompatibleProvider('deepseek-pro', 'https://api.deepseek.com/chat/completions', 'DEEPSEEK_API_KEY'));

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

  /** Liefert die Provider in der für die Komplexität gültigen Kosten-Reihenfolge. */
  rankProviders(complexity: LlmComplexity): ILlmProvider[] {
    const order: LlmProviderId[] =
      complexity === 'complex'
        ? ['deepseek-pro', 'deepseek-flash', 'hf', 'mistral', 'ollama', 'gemini', 'openai']
        : complexity === 'moderate'
          ? ['deepseek-flash', 'hf', 'mistral', 'deepseek-pro', 'ollama']
          : ['deepseek-flash', 'hf', 'mistral', 'ollama'];
    return order
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
