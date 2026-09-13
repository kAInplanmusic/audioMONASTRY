/**
 * audioMONASTRY · RunPod Serverless Provider (rollenfähig)
 * =======================================================
 * Führt AI-Tasks über EINEN RunPod-Serverless-Endpoint der Flotte aus.
 * Die Flotte besteht aus drei Rollen (siehe endpointRegistry.ts):
 *
 *   brain     → runpod-brain   (llm, nlu)
 *   ears      → runpod-ears    (audio.*)
 *   voiceGen  → runpod-voice   (tts, sing, song, audio.generate, stem.separate)
 *
 * Konfiguration je Rolle:
 *   RP_ENDPOINT_ID_BRAIN / _EARS / _VOICE
 *   RP_AGENT_KEY (Fallback: RP_API_KEY / RUNPOD_API_KEY)
 *   Fehlt eine Rollen-ID, fällt die Rolle auf RP_ENDPOINT_ID zurück
 *   (Legacy-Single-Endpoint-Modus – der Cutover bleibt damit lauffähig).
 *
 * Ausführung:
 *   - kurze Tasks  → POST /runsync (ein Roundtrip)
 *   - lange Tasks  → POST /run + Polling auf GET /status/{id}
 *     (Song-/Stem-/Generierungsjobs sprengen das runsync-Fenster)
 *
 * API-Basis ist `https://api.runpod.ai/v2` – nicht `api.runpod.io/v1`.
 */
import type { GpuRoleId } from '../../../config/aiInfrastructure';
import { aiLogger } from './aiLogger';
import { LONG_RUNNING_TASKS, resolveGpuRoles, type ResolvedGpuRole } from './endpointRegistry';
import { AiProviderError, type AiProviderId, type AiTask, type IAiProvider } from './types';

/** RunPod Serverless API-Basis (per RUNPOD_API_BASE überschreibbar, z. B. Tests). */
const DEFAULT_API_BASE = 'https://api.runpod.ai/v2';

/** Provider-ID je Flotten-Rolle. */
const PROVIDER_ID_BY_ROLE: Record<GpuRoleId, AiProviderId> = {
  brain: 'runpod-brain',
  ears: 'runpod-ears',
  voiceGen: 'runpod-voice',
};

/** Startpreise in USD/h (RunPod Serverless, A6000 48 GB) – vor Produktivbetrieb prüfen. */
const DEFAULT_HOURLY_USD: Record<GpuRoleId, number> = {
  brain: 0.39,
  ears: 0.39,
  voiceGen: 0.39,
};

/** Angenommene Jobdauer für die Kostenschätzung (RunPod rechnet sekundengenau). */
const ASSUMED_JOB_SECONDS = 10;

/** Ergebnis eines Warmup-Aufrufs (Session-Wake). */
export interface WarmupResult {
  role: GpuRoleId;
  ok: boolean;
  models: readonly string[];
  message?: string;
}

interface RunPodJobResponse {
  id?: string;
  status?: string;
  output?: unknown;
  error?: string;
  delayTime?: number;
  executionTime?: number;
}

/**
 * Browser-sicher: dieser Wert wird auch aus Client-Bundles erreicht (LlmRouter
 * exportiert einen Modul-Singleton). Im Browser gibt es kein `process` – ein
 * direkter Zugriff liess die App beim Laden abstuerzen
 * (`ReferenceError: process is not defined`).
 */
function env(name: string): string {
  if (typeof process === 'undefined' || !process.env) return '';
  return (process.env[name] ?? '').trim();
}

function apiBase(): string {
  return (env('RUNPOD_API_BASE') || DEFAULT_API_BASE).replace(/\/+$/, '');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class RunPodProvider implements IAiProvider {
  readonly id: AiProviderId;
  private readonly roleId: GpuRoleId;
  private resolved: ResolvedGpuRole | null;

  constructor(roleId: GpuRoleId) {
    this.roleId = roleId;
    this.id = PROVIDER_ID_BY_ROLE[roleId];
    this.resolved = resolveGpuRoles().find((r) => r.role === roleId) ?? null;
  }

  /** Rollen-Definition inkl. aufgelöster Endpoint-ID (null, wenn unbekannt). */
  get role(): ResolvedGpuRole | null {
    return this.resolved;
  }

  private get endpointId(): string {
    return this.resolved?.endpointId ?? '';
  }

  private get apiKey(): string {
    return env('RP_AGENT_KEY') || env('RP_API_KEY') || env('RUNPOD_API_KEY');
  }

  private get timeoutMs(): number {
    return Number(env('RUNPOD_AI_TASK_TIMEOUT_MS') || 600_000);
  }

  private get warmupTimeoutMs(): number {
    return Number(env('RUNPOD_WARMUP_TIMEOUT_MS') || 900_000);
  }

  get available(): boolean {
    return Boolean(this.endpointId && this.apiKey);
  }

  /** Nur die Tasks der eigenen Rolle – die Task-Mengen sind disjunkt. */
  canRun(task: AiTask): boolean {
    return Boolean(this.resolved?.tasks.includes(task));
  }

  /** Kostenschätzung aus dem Stundensatz der Rolle (RunPod rechnet sekundengenau). */
  estimateCostUsd(_task?: AiTask, _model?: string): number {
    const override = Number(process.env[`AI_COST_RUNPOD_${this.roleId.toUpperCase()}_USD_PER_HOUR`] ?? '');
    const perHour = Number.isFinite(override) && override > 0 ? override : DEFAULT_HOURLY_USD[this.roleId];
    return (ASSUMED_JOB_SECONDS / 3600) * perHour;
  }

  async run(task: AiTask, model: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
    if (!this.endpointId) {
      throw new AiProviderError(
        this.id,
        'ENDPOINT_NOT_CONFIGURED',
        `Endpoint-ID fehlt (${this.resolved?.endpointIdEnv ?? this.roleId})`,
        false,
      );
    }
    if (!this.apiKey) {
      throw new AiProviderError(this.id, 'NO_KEY', 'RP_AGENT_KEY/RP_API_KEY/RUNPOD_API_KEY fehlt', false);
    }

    const started = Date.now();
    const deadline = started + this.timeoutMs;
    const body = { input: { task, model, input } };

    if (LONG_RUNNING_TASKS.has(task)) {
      const submitted = await this.submitWithRetry('run', body, signal, deadline);
      const jobId = String(submitted.id ?? '');
      if (!jobId) throw new AiProviderError(this.id, 'NO_JOB_ID', 'RunPod lieferte keine Job-ID', false);
      const finished = await this.pollUntilDone(jobId, signal, deadline);
      return this.unwrap(finished, task, model, started);
    }

    const sync = await this.submitWithRetry('runsync', body, signal, deadline);
    return this.unwrap(sync, task, model, started);
  }

  /**
   * Löst einen Warmup-Job aus, der die Preload-Modelle der Rolle in VRAM lädt.
   * Wird vom Session-Wake (`fleetWake.ts`) genutzt, damit der erste echte Task
   * keinen Modell-Load mehr bezahlt (die App braucht ohnehin 5–10 min zum Start).
   */
  async warmup(signal?: AbortSignal): Promise<WarmupResult> {
    const models = this.resolved?.preload ?? [];
    if (!this.available) {
      return { role: this.roleId, ok: false, models, message: 'endpoint not configured' };
    }
    const deadline = Date.now() + this.warmupTimeoutMs;
    try {
      const submitted = await this.submitWithRetry(
        'run',
        // Die Rolle entscheidet im Worker, welche Preload-Modelle geladen werden.
        { input: { task: 'warmup', model: '', input: { role: this.roleId, models } } },
        signal,
        deadline,
      );
      const jobId = String(submitted.id ?? '');
      if (!jobId) return { role: this.roleId, ok: false, models, message: 'no job id' };
      const finished = await this.pollUntilDone(jobId, signal, deadline);
      const status = String(finished.status ?? '').toUpperCase();
      const ok = status === 'COMPLETED';
      return { role: this.roleId, ok, models, message: ok ? undefined : String(finished.error ?? status) };
    } catch (error) {
      return { role: this.roleId, ok: false, models, message: (error as Error).message };
    }
  }

  /** Normalisiert RunPod- und Worker-Fehler zu AiProviderError. */
  private unwrap(data: RunPodJobResponse, task: AiTask, model: string, started: number): unknown {
    const status = String(data.status ?? '').toUpperCase();
    if (status === 'FAILED' || status === 'ERROR') {
      throw new AiProviderError(this.id, 'JOB_FAILED', String(data.error ?? 'RunPod-Job fehlgeschlagen'), true);
    }
    if (status === 'CANCELLED' || status === 'TIMED_OUT') {
      throw new AiProviderError(this.id, 'JOB_FAILED', `RunPod-Job ${status}`, false);
    }
    if (status && status !== 'COMPLETED') {
      throw new AiProviderError(this.id, 'JOB_INCOMPLETE', `RunPod-Job endete mit Status ${status}`, true);
    }

    aiLogger.info('runpod inference', {
      provider: this.id,
      task,
      model,
      executionTimeMs: data.executionTime ?? Date.now() - started,
    });

    const output = data.output ?? data;
    // Der Worker meldet Fehler als { status: 'error', code, message } im Output.
    if (output && typeof output === 'object' && (output as { status?: string }).status === 'error') {
      const code = String((output as { code?: string }).code ?? 'WORKER_ERROR');
      const retryable = code !== 'MODEL_UNAVAILABLE' && code !== 'INVALID_TASK' && code !== 'INVALID_MODEL';
      throw new AiProviderError(this.id, code, String((output as { message?: string }).message ?? 'Worker-Fehler'), retryable);
    }
    return output;
  }

  private async submitWithRetry(
    path: 'run' | 'runsync',
    body: unknown,
    signal: AbortSignal | undefined,
    deadline: number,
  ): Promise<RunPodJobResponse> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (signal?.aborted) throw new AiProviderError(this.id, 'CANCELLED', 'request cancelled', false);
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new AiProviderError(this.id, 'TIMEOUT', `RunPod-Deadline überschritten (${this.timeoutMs} ms)`, true);
      }
      try {
        return await this.post(path, body, signal, remaining);
      } catch (error) {
        if (signal?.aborted) throw new AiProviderError(this.id, 'CANCELLED', 'request cancelled', false);
        lastError = error;
        if (error instanceof AiProviderError && !error.retryable) throw error;
        if (attempt < 2) await sleep(1000 * 2 ** attempt);
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new AiProviderError(this.id, 'RUNPOD_FAILED', 'RunPod nicht erreichbar', true);
  }

  private async post(
    path: string,
    body: unknown,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<RunPodJobResponse> {
    const url = `${apiBase()}/${encodeURIComponent(this.endpointId)}/${path}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(Math.max(1_000, timeoutMs)),
    });

    if (resp.status === 402) {
      throw new AiProviderError(this.id, 'INSUFFICIENT_CREDIT', `${this.roleId}: RunPod-Guthaben aufgebraucht`, false);
    }
    if (resp.status === 429) {
      throw new AiProviderError(this.id, 'RATE_LIMITED', `${this.roleId}: RunPod 429`, true);
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new AiProviderError(this.id, `HTTP_${resp.status}`, text.slice(0, 300), resp.status >= 500);
    }
    return (await resp.json()) as RunPodJobResponse;
  }

  private async pollUntilDone(
    jobId: string,
    signal: AbortSignal | undefined,
    deadline: number,
  ): Promise<RunPodJobResponse> {
    const url = `${apiBase()}/${encodeURIComponent(this.endpointId)}/status/${encodeURIComponent(jobId)}`;
    let delay = 1_500;
    let last: RunPodJobResponse = { status: 'IN_QUEUE' };

    while (Date.now() < deadline) {
      if (signal?.aborted) throw new AiProviderError(this.id, 'CANCELLED', 'request cancelled', false);
      const remaining = deadline - Date.now();
      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: signal ?? AbortSignal.timeout(Math.max(5_000, Math.min(remaining, 60_000))),
      });
      if (resp.status === 404) {
        throw new AiProviderError(this.id, 'JOB_NOT_FOUND', `RunPod-Job ${jobId} unbekannt`, false);
      }
      if (!resp.ok) {
        throw new AiProviderError(this.id, `HTTP_${resp.status}`, `RunPod-Status ${resp.status}`, resp.status >= 500);
      }
      last = (await resp.json()) as RunPodJobResponse;
      const status = String(last.status ?? '').toUpperCase();
      if (status && status !== 'IN_QUEUE' && status !== 'IN_PROGRESS') return last;
      await sleep(Math.min(delay, Math.max(0, deadline - Date.now())));
      delay = Math.min(delay * 1.5, 6_000);
    }

    throw new AiProviderError(this.id, 'TIMEOUT', `RunPod-Job ${jobId} Timeout (${this.timeoutMs} ms)`, true);
  }
}
