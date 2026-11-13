/**
 * audioMONASTRY · Vast AI Provider
 * =================================
 * Führt AI-Tasks über Vast-gehostete Pod-Endpoints aus.
 */
import { envNumber, type GpuRoleId } from '../../../config/aiInfrastructure';
import { GPU_ROLES, LONG_RUNNING_TASKS } from './endpointRegistry';
import { AiGateError, assertRoleAllowed, isRoleAllowed } from '../aiGate';
import { AiProviderError, type AiProviderId, type AiTask, type IAiProvider } from './types';
import { podBaseUrl, podRoleFor, podToken, type PodRoleId } from './podRouting';
import { ensurePodForJob, markPodStale, notePodActivity, PodWakeBlockedError } from './podStartTriggers';
import { classifyPodJob, isPreemptionError, podQueue } from './podJobQueue';
import { aiLogger } from './aiLogger';

export class VastProvider implements IAiProvider {
  readonly id: AiProviderId;
  private readonly roleId: GpuRoleId;

  constructor(roleId: GpuRoleId) {
    this.roleId = roleId;
    this.id = `vast-${roleId}` as AiProviderId;
  }

  get available(): boolean {
    const pod = podRoleFor(this.roleId);
    return Boolean(pod && podBaseUrl(pod) && podToken()) && isRoleAllowed(this.roleId);
  }

  canRun(task: AiTask, _model?: string): boolean {
    return task === 'warmup' || GPU_ROLES[this.roleId].tasks.includes(task);
  }

  estimateCostUsd(_task: AiTask, _model?: string): number {
    // Costs are managed at the fleet level for Vast
    return 0;
  }

  run(task: AiTask, model: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
    return this.execute(task, model, input, signal, false);
  }

  private async execute(task: AiTask, model: string, input: unknown, signal: AbortSignal | undefined, forceAsync: boolean): Promise<unknown> {
    this.assertConfigured(task, model, input);
    const pod = podRoleFor(this.roleId, task, model, input) as PodRoleId;
    let timeout: AbortSignal | undefined;
    try {
      signal?.throwIfAborted();
      await ensurePodForJob(pod, task, signal);
      return await podQueue(pod).run(
        classifyPodJob(task, model, input), `${task}:${model}`,
        (jobSignal) => {
          // Same 600-s inference deadline as the pre-cutover provider, after wake/queue.
          timeout = AbortSignal.timeout(Math.max(1, envNumber('VAST_AI_TASK_TIMEOUT_MS', 600_000)));
          return this.runDirect(pod, task, model, input, AbortSignal.any([jobSignal, timeout]), forceAsync);
        }, signal, this.id,
      );
    } catch (error) {
      if (error instanceof PodWakeBlockedError) {
        throw new AiProviderError(this.id, `POD_WAKE_${error.block.toUpperCase().replace(/-/g, '_')}`, error.message, false);
      }
      if (isPreemptionError(error)) {
        aiLogger.warn('pod job preempted, caller must retry', { provider: this.id, pod, task, model });
        throw error;
      }
      if (timeout?.aborted || signal?.aborted) {
        throw new AiProviderError(this.id, timeout?.aborted && !signal?.aborted ? 'TIMEOUT' : 'CANCELLED',
          timeout?.aborted && !signal?.aborted ? 'request timed out' : 'request cancelled', Boolean(timeout?.aborted && !signal?.aborted));
      }
      markPodStale(pod, (error as Error).message);
      throw error;
    } finally {
      notePodActivity(`job ${task} finished on ${pod}`);
    }
  }

  /** Native /run + /status waits for long jobs too; never returns a queued receipt. */
  runLong(task: AiTask, model: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
    return this.execute(task, model, input, signal, true);
  }

  private async runDirect(pod: PodRoleId, task: AiTask, model: string, input: unknown, signal: AbortSignal, forceAsync: boolean): Promise<unknown> {
    const base = podBaseUrl(pod);
    const headers = { Authorization: `Bearer ${podToken()}`, 'Content-Type': 'application/json' };
    let jobId: string | undefined;
    const cancel = () => {
      if (!jobId) return;
      // Separate bounded signal: the caller's signal is already aborted.
      void fetch(`${base}/cancel/${encodeURIComponent(jobId)}`, {
        method: 'POST', headers, signal: AbortSignal.timeout(2_000),
      }).catch(() => {});
    };
    const request = async (url: string, init: RequestInit = {}): Promise<Record<string, unknown>> => {
      const requestSignal = !init.method || init.method === 'GET'
        ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : signal;
      const response = await fetch(url, { ...init, headers, signal: requestSignal });
      if (!response.ok) {
        throw new AiProviderError(this.id, `HTTP_${response.status}`, `worker HTTP ${response.status}`, response.status >= 500);
      }
      const body: unknown = await response.json();
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new AiProviderError(this.id, 'INVALID_RESPONSE', 'worker response must be an object', false);
      }
      return body as Record<string, unknown>;
    };
    try {
      signal.throwIfAborted();
      let job = await request(`${base}/${forceAsync || LONG_RUNNING_TASKS.has(task) ? 'run' : 'runsync'}`, { method: 'POST', body: JSON.stringify({ input: { task, model, input } }) });
      jobId = typeof job.id === 'string' && job.id ? job.id : undefined;
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) { cancel(); signal.throwIfAborted(); }
      let attempts = 0;
      let errors = 0;
      const maxAttempts = Math.max(1, envNumber('VAST_POLL_MAX_ATTEMPTS', 240));
      const maxErrors = Math.max(0, envNumber('VAST_POLL_MAX_ERRORS', 3));
      let delay = Math.max(0, envNumber('VAST_POLL_INITIAL_MS', 1_500));
      const maxDelay = Math.max(delay, envNumber('VAST_POLL_MAX_DELAY_MS', 30_000));
      for (;;) {
        signal.throwIfAborted();
        if (job.status === 'COMPLETED') {
          const output = job.output;
          if (output && typeof output === 'object' && (output as { status?: unknown }).status === 'error') {
            const failure = output as { code?: string; message?: string };
            throw new AiProviderError(this.id, failure.code ?? 'WORKER_ERROR', failure.message ?? 'worker failed', !['MODEL_UNAVAILABLE', 'INVALID_TASK', 'INVALID_MODEL'].includes(failure.code ?? ''));
          }
          if (output === undefined) throw new AiProviderError(this.id, 'INVALID_RESPONSE', 'completed job has no output', false);
          return output;
        }
        if (['FAILED', 'CANCELLED', 'TIMED_OUT'].includes(String(job.status))) {
          throw new AiProviderError(this.id, 'JOB_FAILED', `worker job ${String(job.status)}`, job.status === 'FAILED');
        }
        if (!jobId || !['IN_QUEUE', 'IN_PROGRESS'].includes(String(job.status))) {
          throw new AiProviderError(this.id, 'INVALID_RESPONSE', 'worker returned an invalid job receipt', false);
        }
        if (++attempts > maxAttempts) throw new AiProviderError(this.id, 'TIMEOUT', 'worker polling attempt limit reached', true);
        await new Promise<void>((resolve, reject) => {
          const aborted = () => { clearTimeout(timer); reject(signal.reason); };
          const timer = setTimeout(() => { signal.removeEventListener('abort', aborted); resolve(); },
            Math.min(maxDelay, Math.round(delay * (0.8 + Math.random() * 0.4))));
          signal.addEventListener('abort', aborted, { once: true });
          if (signal.aborted) aborted();
        });
        delay = Math.min(maxDelay, Math.max(delay, Math.round(delay * 1.5)));
        try {
          job = await request(`${base}/status/${encodeURIComponent(jobId)}`);
          errors = 0;
        } catch (error) {
          if (signal.aborted) throw error;
          const transient = !(error instanceof AiProviderError) || error.retryable || error.code === 'HTTP_429';
          if (!transient || ++errors > maxErrors) throw error;
        }
      }
    } finally {
      signal.removeEventListener('abort', cancel);
    }
  }

  private assertConfigured(task?: AiTask, model?: string, input?: unknown): void {
    try { assertRoleAllowed(this.roleId, 'vast'); } catch (error) {
      if (error instanceof AiGateError) throw new AiProviderError(this.id, error.code, error.message, false);
      throw error;
    }
    const pod = podRoleFor(this.roleId, task, model, input);
    if (!pod) {
      throw new AiProviderError(this.id, 'NO_POD_FOR_ROLE', `Für ${this.roleId} gibt es keinen Pod`, false);
    }
    if (!podBaseUrl(pod)) {
      throw new AiProviderError(this.id, 'POD_NOT_CONFIGURED', `Pod ${pod} fehlt`, false);
    }
    if (!podToken()) {
      throw new AiProviderError(this.id, 'NO_POD_TOKEN', 'AI_POD_TOKEN fehlt', false);
    }
  }
}
