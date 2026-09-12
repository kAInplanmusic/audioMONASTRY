/**
 * audioMONASTRY · AI Orchestrator – Fassade
 * ==========================================
 * Zentrale AI-Orchestrierung: Session → Job → Provider → Ergebnis, mit
 * Dedup/Concurrency, Modell-Management, MCP, Logging und Cost-Tracking.
 *
 * Nutzung (serverseitig):
 *   const result = await aiOrchestrator.orchestrate({ userId, task, model, input });
 */
import { aiLogger } from './aiLogger';
import { CostTracker } from './costTracker';
import { fleetStatus, sleepFleet, wakeFleet } from './fleetWake';
import { JobManager } from './jobManager';
import { AiJobRuntime, type AiRuntimeJobResult } from './aiJobRuntime';
import { McpRuntime, createDefaultMcpRuntime } from './mcpRuntime';
import { ModelManager, type EndpointClient } from './modelManager';
import { listModels, validateRegistry } from './modelRegistry';
import { ProviderRouter } from './providerRouter';
import { SessionManager } from './sessionManager';
import { AiProviderError, type AiJob, type AiTask, type IAiProvider } from './types';
import { PRESET_SAMPLE_DATABASE } from '../../../data/samples';

interface OrchestrateRequest {
  userId: string;
  task: AiTask;
  model: string;
  input: unknown;
  sessionId?: string;
  mcpPermission?: 'READ' | 'WRITE' | 'EXECUTION' | 'DESTRUCTIVE';
}

interface OrchestrateResult {
  job: AiJob;
  provider: string;
  result: unknown;
  costUsd: number;
}

interface AiOrchestratorOptions {
  endpointClient?: EndpointClient;
  sessionIdleTimeoutMs?: number;
  jobMaxConcurrency?: ConstructorParameters<typeof JobManager>[0]['maxConcurrency'];
  /** AI-P1-002: Gesamtzahl gleichzeitiger Provider-Aufrufe. */
  jobRuntimeConcurrency?: number;
  /** AI-P1-002: Per-Job-Timeout (ms); 0 = kein Timeout. */
  jobTimeoutMs?: number;
}

export class AiOrchestrator {
  readonly jobs: JobManager;
  readonly sessions: SessionManager;
  readonly models: ModelManager;
  readonly costs: CostTracker;
  readonly providers: ProviderRouter;
  readonly mcp: McpRuntime;
  /** AI-P1-002: Warteschlange/Timeout/Cancellation, isoliert vom Aufrufer-Thread. */
  readonly runtime: AiJobRuntime;
  private readonly jobTimeoutMs: number;

  constructor(options: AiOrchestratorOptions = {}) {
    this.jobTimeoutMs = Number.isFinite(options.jobTimeoutMs)
      ? Math.max(0, Math.floor(options.jobTimeoutMs as number))
      : Number(process.env.AI_JOB_TIMEOUT_MS ?? 120_000);
    this.runtime = new AiJobRuntime({
      maxConcurrent: options.jobRuntimeConcurrency ?? 4,
      defaultTimeoutMs: this.jobTimeoutMs,
    });
    this.jobs = new JobManager({ maxConcurrency: options.jobMaxConcurrency });
    this.sessions = new SessionManager(undefined, {
      idleTimeoutMs: options.sessionIdleTimeoutMs,
      // Idle-Timeout → Flotte schlafen legen (workersMin=0, keine Idle-GPU-Kosten).
      onScaleToZero: async () => {
        await sleepFleet();
      },
    });
    this.models = new ModelManager(options.endpointClient ?? noopEndpointClient());
    this.costs = new CostTracker();
    this.providers = new ProviderRouter();
    this.mcp = createDefaultMcpRuntime({
      runTask: (task, model, input) => this.runTask(task, model, input),
      getSessionState: () => ({ ...this.sessions.get(), models: this.models.getStatus(), cost: this.costs.summary() }),
      searchSamples: (query) => searchPresetSamples(query),
      getRuntimeStatus: () => ({ models: this.models.getStatus(), memory: this.models.getMemoryUsage(), cost: this.costs.summary() }),
      loadModel: (modelId) => this.models.load(modelId),
      unloadModel: (modelId) => this.models.unload(modelId),
      getFleetStatus: () => fleetStatus(),
      wakeFleet: () => wakeFleet(),
    });
  }

  registerProvider(provider: IAiProvider): void {
    this.providers.register(provider);
  }

  async initialize(): Promise<void> {
    const errors = validateRegistry();
    if (errors.length > 0) {
      aiLogger.error('model registry validation failed', { error: errors.join('; ') });
      throw new Error(`Model Registry invalid: ${errors.join('; ')}`);
    }
    aiLogger.info('ai orchestrator initialized', { models: listModels().length });
  }

  /** Haupt-Einstieg: AI-Request mit Job-Dedup, Concurrency und Provider-Routing. */
  async orchestrate(req: OrchestrateRequest): Promise<OrchestrateResult> {
    const sessionId = req.sessionId ?? this.sessions.get().sessionId;
    const job = this.jobs.create(sessionId, req.userId, req.task, req.model, 'runpod', req.input);
    if (job.status !== 'QUEUED') {
      // Deduplizierter Job – auf Abschluss warten (SingleFlight).
      return this.waitForJob(job.jobId);
    }
    this.sessions.jobStarted(job.model);
    const started = Date.now();
    // AI-P1-002: Der Provider-Aufruf läuft in der Runtime (Queue/Timeout/Abort);
    // `submit` kehrt sofort zurück und der Aufrufer-/Render-Thread wird nie
    // blockiert. Das AbortSignal wird an den Provider durchgereicht.
    const handle = this.runtime.submit(
      async (signal) => {
        this.jobs.start(job.jobId);
        this.jobs.markRunning(job.jobId);
        return this.providers.run(job.task, job.model, req.input, signal);
      },
      { id: job.jobId, timeoutMs: this.jobTimeoutMs, label: `${job.task}:${job.model}` },
    );
    const outcome = await handle.promise;

    if (outcome.status === 'completed') {
      const { provider, result } = outcome.value as { provider: string; result: unknown };
      const inferenceMs = Date.now() - started;
      this.jobs.complete(job.jobId, result);
      const cost = this.costs.settle(this.jobs.get(job.jobId) ?? job, inferenceMs);
      this.sessions.jobFinished(job.model);
      return { job: this.jobs.get(job.jobId) ?? job, provider, result, costUsd: cost.estimatedCostUsd };
    }

    const aiError = this.toOrchestratorError(outcome);
    this.jobs.fail(
      job.jobId,
      aiError,
      outcome.status === 'timeout' ? 'TIMEOUT' : outcome.status === 'cancelled' ? 'CANCELLED' : 'FAILED',
    );
    this.sessions.jobFinished(job.model);
    throw aiError;
  }

  /** Bildet ein Runtime-Ergebnis auf einen normalisierten AI-Fehler ab. */
  private toOrchestratorError(outcome: AiRuntimeJobResult<unknown>): AiProviderError {
    if (outcome.error instanceof AiProviderError) return outcome.error;
    if (outcome.status === 'timeout') {
      return new AiProviderError('local', 'TIMEOUT', outcome.error?.message ?? 'AI-Job Timeout', true);
    }
    if (outcome.status === 'cancelled') {
      return new AiProviderError('local', 'CANCELLED', outcome.error?.message ?? 'AI-Job abgebrochen', false);
    }
    return new AiProviderError('local', 'UNKNOWN', outcome.error?.message ?? 'AI-Job fehlgeschlagen', false);
  }

  /**
   * AI-P1-002: Bricht einen wartenden oder laufenden AI-Job ab. Der Concurrency-
   * Slot wird sofort frei, das AbortSignal erreicht den Provider.
   */
  cancelJob(jobId: string, reason?: string): boolean {
    const cancelled = this.runtime.cancel(jobId, reason);
    if (cancelled) this.jobs.cancel(jobId);
    return cancelled;
  }

  /** Führt einen Task direkt aus (für MCP-Tools), ohne Job-Dedup. */
  async runTask(task: AiTask, model: string, input: unknown): Promise<unknown> {
    const { result } = await this.providers.run(task, model, input);
    return result;
  }

  async waitForJob(jobId: string, timeoutMs = 120_000): Promise<OrchestrateResult> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const job = this.jobs.get(jobId);
      if (!job) throw new Error(`job not found: ${jobId}`);
      if (job.status === 'COMPLETED') {
        return { job, provider: job.provider, result: job.result, costUsd: this.costs.costForJob(jobId) };
      }
      if (job.status === 'FAILED' || job.status === 'TIMEOUT' || job.status === 'CANCELLED') {
        throw new AiProviderError('local', job.status, job.error ?? job.status, false);
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new AiProviderError('local', 'JOB_TIMEOUT', `job ${jobId} nicht rechtzeitig fertig`, true);
  }

  getStatus() {
    return {
      session: this.sessions.get(),
      models: this.models.getStatus(),
      memory: this.models.getMemoryUsage(),
      jobs: this.jobs.list().length,
      cost: this.costs.summary(),
      fleet: fleetStatus(),
      // AI-P1-002: Queue-/Timeout-/Cancellation-Kennzahlen (queued/running/peak).
      runtime: this.runtime.snapshot(),
    };
  }
}

export const aiOrchestrator = new AiOrchestrator();

function noopEndpointClient(): EndpointClient {
  return {
    async loadModel(): Promise<void> {},
    async unloadModel(): Promise<void> {},
    async listModels(): Promise<Array<{ id: string; loaded: boolean }>> {
      return listModels().map((m) => ({ id: m.id, loaded: false }));
    },
  };
}

/** Lokale Sample-Suche in der eingebauten Preset-Bibliothek (echte Daten). */
function searchPresetSamples(query: string): Array<{ id: string; name: string; category: string }> {
  const q = query.trim().toLowerCase();
  return PRESET_SAMPLE_DATABASE.filter((s) => !q || s.name.toLowerCase().includes(q) || s.category.toLowerCase().includes(q))
    .slice(0, 20)
    .map((s) => ({ id: s.id, name: s.name, category: s.category }));
}
