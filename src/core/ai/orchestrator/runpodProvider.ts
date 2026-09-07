/**
 * audioMONASTRY · RunPod Serverless Provider
 * ==========================================
 * Führt AI-Tasks über einen RunPod Serverless Endpoint aus.
 *
 * Konfiguration:
 *   RUNPOD_ENDPOINT_ID=<serverless-endpoint-id>
 *   RUNPOD_API_KEY=<runpod-api-key>   (alternativ RP_API_KEY)
 *
 * Der Provider ist nur verfügbar, wenn Endpoint-ID + Key gesetzt sind.
 * Solange kein Endpoint existiert, bleibt er inaktiv und ändert das
 * bestehende Routing nicht.
 */
import { AiProviderError, type AiProviderId, type AiTask, type IAiProvider } from './types';
import { aiLogger } from './aiLogger';

const RUNPOD_API_BASE = 'https://api.runpod.io/v1';

function env(name: string): string {
  return (process.env[name] ?? '').trim();
}

/** Tasks, die über den RunPod-Worker laufen können. */
const RUNPOD_TASKS: ReadonlySet<AiTask> = new Set<AiTask>([
  'llm',
  'tts',
  'sing',
  'song',
  'stem.separate',
  'audio.classify',
  'audio.transcribe',
  'audio.embed',
  'audio.analyze',
  'audio.diarize',
  'audio.understand',
  'audio.generate',
  'multimodal',
  'nlu',
]);

export class RunPodProvider implements IAiProvider {
  readonly id = 'runpod' as const;

  private endpointId = env('RUNPOD_ENDPOINT_ID');
  private apiKey = env('RUNPOD_API_KEY') || env('RP_API_KEY');
  private timeoutMs = Number(env('RUNPOD_AI_TASK_TIMEOUT_MS') || 600_000);

  get available(): boolean {
    return Boolean(this.endpointId && this.apiKey);
  }

  canRun(task: AiTask): boolean {
    return RUNPOD_TASKS.has(task);
  }

  estimateCostUsd(_task: AiTask): number {
    // Platzhalter; sobald echte RunPod-Preise vorliegen per AI_COST_RUNPOD_* überschreiben.
    return Number(process.env.AI_COST_RUNPOD_USD ?? 0);
  }

  async run(task: AiTask, model: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
    if (!this.endpointId) throw new AiProviderError(this.id, 'ENDPOINT_NOT_CONFIGURED', 'RUNPOD_ENDPOINT_ID fehlt', false);
    if (!this.apiKey) throw new AiProviderError(this.id, 'NO_KEY', 'RUNPOD_API_KEY/RP_API_KEY fehlt', false);

    const url = `${RUNPOD_API_BASE}/${encodeURIComponent(this.endpointId)}/runsync`;
    const started = Date.now();
    let lastError: unknown;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const resp = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            input: { task, model, input },
          }),
          signal: signal ?? AbortSignal.timeout(this.timeoutMs),
        });

        if (resp.status === 402) {
          throw new AiProviderError(this.id, 'INSUFFICIENT_CREDIT', 'RunPod-Guthaben aufgebraucht', false);
        }
        if (resp.status === 429) {
          throw new AiProviderError(this.id, 'RATE_LIMITED', 'RunPod 429', true);
        }
        if (!resp.ok) {
          const text = await resp.text().catch(() => '');
          throw new AiProviderError(this.id, `HTTP_${resp.status}`, text.slice(0, 300), resp.status >= 500);
        }

        const data = (await resp.json()) as {
          output?: unknown;
          status?: string;
          error?: string;
          delayTime?: number;
          executionTime?: number;
        };

        if (data.status === 'FAILED' || data.status === 'ERROR') {
          throw new AiProviderError(this.id, 'JOB_FAILED', String(data.error ?? 'RunPod-Job fehlgeschlagen'), true);
        }

        aiLogger.info('runpod inference', {
          task,
          model,
          executionTimeMs: data.executionTime ?? Date.now() - started,
        });
        return data.output ?? data;
      } catch (error) {
        if (signal?.aborted) throw new AiProviderError(this.id, 'CANCELLED', 'request cancelled', false);
        lastError = error;
        if (error instanceof AiProviderError && !error.retryable) throw error;
        if (attempt < 2) await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      }
    }

    throw lastError instanceof Error
      ? new AiProviderError(this.id, 'RUNPOD_FAILED', lastError.message, true)
      : new AiProviderError(this.id, 'RUNPOD_FAILED', 'RunPod nicht erreichbar', true);
  }
}
