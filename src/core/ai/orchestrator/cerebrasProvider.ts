/**
 * audioMONASTRY · Cerebras Provider (App + NLU/Struktur-Aufgaben)
 * ================================================================
 * OpenAI-kompatibler Provider für `https://api.cerebras.ai/v1`.
 * Kosten-/Modell-Tiering:
 *   - einfach   → qwen-3.8-27b   (günstig, schnell)
 *   - mittel    → gemma-4-31b    (Balance)
 *   - komplex   → gpt-oss-120b   (Reasoning/Coding)
 *
 * Verfügbar, wenn CB_API_KEY gesetzt ist. `nlu`-Tasks laufen im JSON-Modus,
 * damit Ergebnisse direkt als strukturierte Objekte (Intents/Pläne) nutzbar sind.
 */
import { AiProviderError, type AiProviderId, type AiTask, type IAiProvider } from './types';
import { aiLogger } from './aiLogger';

export const CEREBRAS_BASE_URL = 'https://api.cerebras.ai/v1';
const DEFAULT_MODEL = 'gpt-oss-120b';

export const CEREBRAS_MODEL_TIERS = {
  simple: 'qwen-3.8-27b',
  moderate: 'gemma-4-31b',
  complex: 'gpt-oss-120b',
} as const;

export type CerebrasComplexity = keyof typeof CEREBRAS_MODEL_TIERS;

export function pickCerebrasModel(complexity: CerebrasComplexity = 'moderate'): string {
  return CEREBRAS_MODEL_TIERS[complexity] ?? DEFAULT_MODEL;
}

function env(name: string): string {
  try { return (process.env[name] ?? '').trim(); } catch { return ''; }
}

export class CerebrasProvider implements IAiProvider {
  readonly id: AiProviderId = 'cerebras';
  private key = '';

  constructor() {
    this.key = env('CB_API_KEY');
  }

  get available(): boolean {
    return this.key.length > 0;
  }

  canRun(task: AiTask, _model?: string): boolean {
    // NLU/Struktur + LLM-Ersatz (Router lenkt 'llm' separat über LlmRouter).
    return task === 'nlu' || task === 'llm';
  }

  estimateCostUsd(task: AiTask, model?: string): number {
    const m = model ?? DEFAULT_MODEL;
    const per1k = m === CEREBRAS_MODEL_TIERS.simple ? 0.00008 : m === CEREBRAS_MODEL_TIERS.moderate ? 0.0002 : 0.001;
    return task === 'nlu' ? per1k * 2 : per1k * 4;
  }

  async run(task: AiTask, model: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
    if (!this.available) throw new AiProviderError(this.id, 'KEY_MISSING', 'CB_API_KEY fehlt', false);
    const raw = typeof input === 'string' ? input : JSON.stringify(input ?? {});
    const payload = (typeof input === 'object' && input !== null && 'prompt' in (input as object))
      ? String((input as { prompt: unknown }).prompt)
      : raw;
    const wantJson = task === 'nlu' || ((input as { json?: boolean } | null)?.json === true);
    const modelId = model || pickCerebrasModel((input as { complexity?: CerebrasComplexity } | null)?.complexity ?? 'moderate');

    const body: Record<string, unknown> = {
      model: modelId,
      messages: [
        { role: 'system', content: task === 'nlu'
          ? 'Du bist ein präziser Intent-/Struktur-Parser. Antworte NUR mit gültigem JSON im geforderten Schema.'
          : 'Du bist ein hilfreicher Coding-Assistent. Antworte präzise und vollständig.' },
        { role: 'user', content: String(payload) },
      ],
      temperature: 0.1,
      max_tokens: 4096,
    };
    if (wantJson) body.response_format = { type: 'json_object' };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort);
    try {
      const res = await fetch(`${CEREBRAS_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.key}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) throw new AiProviderError(this.id, `CEREBRAS_HTTP_${res.status}`, text.slice(0, 300), true);
      const data = JSON.parse(text) as { choices?: { message?: { content?: string } }[] };
      const content = data.choices?.[0]?.message?.content?.trim() ?? '';
      if (wantJson) {
        try { return JSON.parse(content) as unknown; }
        catch { aiLogger.warn('cerebras json parse failed', { model: modelId }); return { text: content }; }
      }
      return { provider: this.id, model: modelId, text: content };
    } catch (e) {
      if (e instanceof AiProviderError) throw e;
      throw new AiProviderError(this.id, 'NETWORK', (e as Error).message, true);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
}

export const cerebrasProvider = new CerebrasProvider();
