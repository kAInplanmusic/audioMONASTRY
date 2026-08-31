/**
 * audioMONASTRY · AI Orchestrator – Provider Router
 * ==================================================
 * Zentrale Provider-Wahl. Bestehende Pfade werden wiederverwendet:
 * - `llm`            → LlmRouter (bestehend, Kosten-Ranking)
 * - `stem.separate`  → Replicate (bestehendes, verifiziertes Muster)
 * - `tts/sing/song`  → HF Serverless (bestehendes Muster) mit HF-Endpoint-Fallback
 * - `audio.*`        → HF Endpoint (Custom Container)
 */
import { llmRouter } from '../LlmRouter';
import { aiLogger } from './aiLogger';
import { assertSingleGpuEndpoint } from '../../../config/aiInfrastructure';
import { CircuitBreaker } from './circuitBreaker';
import { AiProviderError, type AiProviderId, type AiTask, type IAiProvider } from './types';

const HF_ROUTER = 'https://router.huggingface.co/hf-inference/models';
const HF_ROUTER_LEGACY = 'https://api-inference.huggingface.co/models';

function env(name: string): string {
  return (process.env[name] ?? '').trim();
}

// ---------------------------------------------------------------------------
// HF Standard Endpoint Provider – DEPRECATED / DEAKTIVIERT (GPU-Konsolidierung)
// ---------------------------------------------------------------------------
// Diese Klasse wird NICHT mehr im ProviderRouter registriert: Whisper/CLAP
// laufen auf dem gemeinsamen Custom-Container `samplemonk-ai` (HfEndpointProvider).
// Nur für Diagnose/Alt-Code aufbewahrt – keine Instanz erzeugen.
export class HfStandardEndpointProvider implements IAiProvider {
  readonly id = 'hf-standard-endpoint' as const;

  private endpoints: Partial<Record<AiTask, string>> = {};

  constructor() {
    const pilot = env('HF_PILOT_ENDPOINT_URL');
    const clap = env('HF_CLAP_ENDPOINT_URL');
    if (pilot) this.endpoints['audio.transcribe'] = pilot;
    if (clap) this.endpoints['audio.embed'] = clap;
  }

  get available(): boolean {
    return Object.values(this.endpoints).some(Boolean);
  }

  canRun(task: AiTask): boolean {
    return Boolean(this.endpoints[task]);
  }

  estimateCostUsd(): number {
    const perHour = Number(process.env.AI_COST_A100_USD_PER_HOUR ?? 2.5);
    return (10_000 / 3_600_000) * perHour;
  }

  async run(task: AiTask, _model: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
    const url = this.endpoints[task];
    if (!url) throw new AiProviderError(this.id, 'NO_ENDPOINT', `kein Standard-Endpoint für Task ${task}`, false);
    const key = env('HF_API_KEY') || env('HF_TOKEN');
    if (!key) throw new AiProviderError(this.id, 'NO_KEY', 'HF_TOKEN fehlt', false);
    const payload = input as { audioBase64?: string; audioDataUri?: string; audio?: string; text?: string; language?: string };
    const audio = payload.audioDataUri ?? payload.audioBase64 ?? payload.audio ?? '';
    const body: Record<string, unknown> = {};
    if (task === 'audio.transcribe') {
      body.inputs = audio;
      if (payload.language) body.parameters = { language: payload.language };
    } else if (task === 'audio.embed') {
      body.inputs = audio;
    }
    const resp = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(120_000),
    });
    if (resp.status === 503 || resp.status === 502) {
      throw new AiProviderError(this.id, 'ENDPOINT_WAKING', 'Standard-Endpoint wacht auf (Scale-to-Zero)', true);
    }
    if (!resp.ok) {
      throw new AiProviderError(this.id, `HTTP_${resp.status}`, (await resp.text().catch(() => '')).slice(0, 200), resp.status >= 500);
    }
    return await resp.json();
  }
}

// ---------------------------------------------------------------------------
// HF Endpoint Provider (Custom Container)
// ---------------------------------------------------------------------------
export class HfEndpointProvider implements IAiProvider {
  readonly id = 'hf-endpoint' as const;
  private endpointUrl = env('HF_ENDPOINT_URL');

  get available(): boolean {
    return Boolean(this.endpointUrl);
  }

  canRun(task: AiTask): boolean {
    return ['tts', 'sing', 'song', 'audio.classify', 'audio.transcribe', 'audio.embed', 'audio.analyze', 'audio.generate', 'multimodal'].includes(task);
  }

  estimateCostUsd(): number {
    const perHour = Number(process.env.AI_COST_A100_USD_PER_HOUR ?? 2.5);
    return (10_000 / 3_600_000) * perHour;
  }

  async run(task: AiTask, model: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
    if (!this.endpointUrl) throw new AiProviderError(this.id, 'ENDPOINT_NOT_CONFIGURED', 'HF_ENDPOINT_URL fehlt', false);
    const body = JSON.stringify({ task, model, input });
    const started = Date.now();
    let lastError: Error | null = null;
    // FA-P1-7: Gesamt-Deadline über alle Versuche (kein 10,5-Minuten-Hänger).
    const totalTimeoutMs = Number(process.env.AI_TIMEOUT_MS ?? 120_000);
    let deadline = Date.now() + totalTimeoutMs;
    // Kaltstart kann 2–5 min dauern: bei ENDPOINT_WAKING (503) wird die
    // Deadline einmalig auf AI_WAKE_TIMEOUT_MS (Default 300 s) verlängert.
    const wakeTimeoutMs = Number(process.env.AI_WAKE_TIMEOUT_MS ?? 300_000);
    let wakeExtended = false;
    // Endpoint-Wake: Scale-to-Zero liefert 502/503, bis die Replica bereit ist.
    for (let attempt = 0; attempt < 10; attempt++) {
      if (Date.now() >= deadline) throw new AiProviderError(this.id, 'TIMEOUT', `HF-Endpoint-Gesamt-Timeout (${totalTimeoutMs} ms) überschritten`, true);
      const remaining = deadline - Date.now();
      try {
        const resp = await fetch(`${this.endpointUrl.replace(/\/$/, '')}/infer`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env('HF_TOKEN')}` },
          body,
          signal: signal ?? AbortSignal.timeout(Math.min(120_000, remaining)),
        });
        if (resp.status === 503) {
          if (!wakeExtended) {
            wakeExtended = true;
            deadline = Math.max(deadline, Date.now() + wakeTimeoutMs);
          }
          lastError = new AiProviderError(this.id, 'ENDPOINT_WAKING', 'HF-Endpoint wacht auf (Scale-to-Zero)', true);
          await new Promise((r) => setTimeout(r, 2000 * 2 ** Math.min(attempt, 6)));
          continue;
        }
        if (resp.status === 429) throw new AiProviderError(this.id, 'RATE_LIMITED', 'HF-Endpoint 429', true);
        if (!resp.ok) {
          const text = await resp.text().catch(() => '');
          throw new AiProviderError(this.id, `HTTP_${resp.status}`, text.slice(0, 200), resp.status >= 500);
        }
        const data = (await resp.json()) as { result?: unknown; durationMs?: number };
        aiLogger.info('hf-endpoint inference', { task, model, durationMs: data.durationMs ?? Date.now() - started });
        return data.result;
      } catch (error) {
        if (signal?.aborted) throw new AiProviderError(this.id, 'CANCELLED', 'request cancelled', false);
        if (error instanceof AiProviderError) {
          lastError = error;
          if (!error.retryable) throw error;
        } else {
          lastError = error as Error;
        }
        if (attempt < 9) await new Promise((r) => setTimeout(r, 1000 * 2 ** Math.min(attempt, 6)));
      }
    }
    throw lastError instanceof Error ? lastError : new AiProviderError(this.id, 'ENDPOINT_FAILED', 'HF-Endpoint nicht erreichbar', true);
  }
}

// ---------------------------------------------------------------------------
// HF Serverless Provider (bestehendes Muster)
// ---------------------------------------------------------------------------
export class HfServerlessProvider implements IAiProvider {
  readonly id = 'hf-serverless' as const;

  get available(): boolean {
    return Boolean(env('HF_API_KEY') || env('HF_TOKEN'));
  }

  canRun(task: AiTask): boolean {
    return ['tts', 'sing', 'song', 'llm'].includes(task);
  }

  estimateCostUsd(task: AiTask): number {
    return task === 'song' ? 0.02 : task === 'tts' ? 0.002 : 0.001;
  }

  async run(task: AiTask, model: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
    const key = env('HF_API_KEY') || env('HF_TOKEN');
    if (!key) throw new AiProviderError(this.id, 'NO_KEY', 'HF_TOKEN fehlt', false);
    const payload = input as { inputs?: unknown; parameters?: Record<string, unknown>; prompt?: string; text?: string };
    const inputs = payload.inputs ?? payload.prompt ?? payload.text ?? input;
    let lastError: unknown;
    for (const base of [HF_ROUTER, HF_ROUTER_LEGACY]) {
      try {
        const resp = await fetch(`${base}/${model}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload.parameters ? { inputs, parameters: payload.parameters } : { inputs }),
          signal: signal ?? AbortSignal.timeout(90_000),
        });
        if (!resp.ok) throw new Error(`HF ${model} HTTP ${resp.status}`);
        return await resp.arrayBuffer();
      } catch (error) {
        lastError = error;
      }
    }
    throw new AiProviderError(this.id, 'HF_FAILED', String((lastError as Error)?.message ?? lastError), true);
  }
}

// ---------------------------------------------------------------------------
// Replicate Provider (Stem-Separation – bestehendes, live verifiziertes Muster)
// ---------------------------------------------------------------------------
export class ReplicateProvider implements IAiProvider {
  readonly id = 'replicate' as const;

  get available(): boolean {
    return Boolean(env('REPLICATE_API_TOKEN'));
  }

  canRun(task: AiTask): boolean {
    return task === 'stem.separate';
  }

  estimateCostUsd(): number {
    return Number(process.env.AI_COST_STEM_USD ?? 0.05);
  }

  async run(_task: AiTask, model: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
    const token = env('REPLICATE_API_TOKEN');
    if (!token) throw new AiProviderError(this.id, 'NO_TOKEN', 'REPLICATE_API_TOKEN fehlt', false);
    const audio = (input as { audioDataUri?: string })?.audioDataUri ?? '';
    if (!audio) throw new AiProviderError(this.id, 'NO_AUDIO', 'audioDataUri fehlt', false);

    const modelResp = await fetch(`https://api.replicate.com/v1/models/${model}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: signal ?? AbortSignal.timeout(30_000),
    });
    if (!modelResp.ok) throw new AiProviderError(this.id, `MODEL_HTTP_${modelResp.status}`, `Replicate model ${modelResp.status}`, modelResp.status >= 500);
    const modelInfo = (await modelResp.json()) as { latest_version?: { id?: string } };
    const versionId = modelInfo.latest_version?.id ?? '';
    if (!versionId) throw new AiProviderError(this.id, 'NO_VERSION', 'keine lauffähige Version', false);

    const createResp = await fetch(`https://api.replicate.com/v1/models/${model}/versions/${versionId}/predictions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'wait' },
      body: JSON.stringify({ input: { audio } }),
      signal: signal ?? AbortSignal.timeout(180_000),
    });
    if (createResp.status === 402) throw new AiProviderError(this.id, 'INSUFFICIENT_CREDIT', 'Replicate-Guthaben aufgebraucht', false);
    if (!createResp.ok) throw new AiProviderError(this.id, `HTTP_${createResp.status}`, `Replicate ${createResp.status}`, createResp.status >= 500);

    let prediction = (await createResp.json()) as { id?: string; status?: string; output?: unknown };
    for (let i = 0; i < 45 && prediction.status !== 'succeeded' && prediction.status !== 'failed'; i++) {
      if (signal?.aborted) throw new AiProviderError(this.id, 'CANCELLED', 'request cancelled', false);
      await new Promise((r) => setTimeout(r, 4000));
      const pollResp = await fetch(`https://api.replicate.com/v1/predictions/${prediction.id}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(30_000),
      });
      prediction = (await pollResp.json()) as typeof prediction;
    }
    if (prediction.status !== 'succeeded') throw new AiProviderError(this.id, 'JOB_FAILED', 'Replicate-Stem-Job fehlgeschlagen', true);
    return { provider: 'replicate', stems: prediction.output ?? {} };
  }
}

// ---------------------------------------------------------------------------
// Local/Deterministischer Provider (DAW bleibt ohne Cloud nutzbar)
// ---------------------------------------------------------------------------
export class LocalProvider implements IAiProvider {
  readonly id = 'local' as const;

  get available(): boolean {
    return true;
  }

  canRun(task: AiTask): boolean {
    return ['llm', 'tts', 'song'].includes(task);
  }

  estimateCostUsd(): number {
    return 0;
  }

  async run(task: AiTask, _model: string, input: unknown): Promise<unknown> {
    const prompt = typeof input === 'string' ? input : JSON.stringify(input ?? {});
    if (task === 'llm') {
      // Bestehender Ollama-/deterministischer Pfad wird über den LlmRouter abgedeckt.
      throw new AiProviderError(this.id, 'LOCAL_LLM_NOT_DIRECT', 'LLM lokal über LlmRouter', false);
    }
    return { provider: 'local', text: prompt, hint: 'deterministischer Fallback' };
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
export class ProviderRouter {
  // GPU-Konsolidierung: NUR der Custom-Container-Endpoint `samplemonk-ai`
  // (HfEndpointProvider) darf GPU nutzen. HfStandardEndpointProvider
  // (separate pilot/clap-Endpoints) ist bewusst NICHT mehr registriert.
  private providers: IAiProvider[] = [
    new HfEndpointProvider(),
    new HfServerlessProvider(),
    new ReplicateProvider(),
    new LocalProvider(),
  ];
  private breakers = new Map<string, CircuitBreaker>();

  constructor() {
    // Harte Kostenregel: niemals mehr als 1 GPU-Endpoint.
    assertSingleGpuEndpoint();
  }

  register(provider: IAiProvider): void {
    this.providers = [provider, ...this.providers.filter((p) => p.id !== provider.id)];
  }

  /** Liefert alle Provider, die den Task ausführen können (in Prioritäts-Reihenfolge). */
  candidates(task: AiTask): IAiProvider[] {
    return this.providers.filter((p) => p.available && p.canRun(task));
  }

  async run(task: AiTask, model: string, input: unknown, signal?: AbortSignal): Promise<{ provider: AiProviderId; result: unknown }> {
    if (task === 'llm') {
      const completion = await llmRouter.complete({
        prompt: String((input as { prompt?: string })?.prompt ?? input ?? ''),
        complexity: (input as { complexity?: 'simple' | 'moderate' | 'complex' })?.complexity ?? 'moderate',
      });
      return { provider: completion.provider as AiProviderId, result: completion };
    }
    const ranked = this.candidates(task);
    if (ranked.length === 0) throw new AiProviderError('local', 'NO_PROVIDER', `kein Provider für Task ${task}`, false);
    let lastError: Error | null = null;
    for (const provider of ranked) {
      const breaker = this.breakers.get(provider.id) ?? new CircuitBreaker(provider.id);
      this.breakers.set(provider.id, breaker);
      try {
        const result = await breaker.call(() => provider.run(task, model, input, signal));
        return { provider: provider.id, result };
      } catch (error) {
        lastError = error as Error;
        aiLogger.warn('provider failed, trying next', { provider: provider.id, task, model, error: (error as Error).message });
      }
    }
    throw lastError ?? new AiProviderError('local', 'ALL_PROVIDERS_FAILED', `alle Provider für ${task} fehlgeschlagen`, true);
  }
}
