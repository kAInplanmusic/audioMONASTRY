/**
 * audioMONASTRY · Vast Pod Provider (rollenfähig)
 * ================================================
 * Führt AI-Tasks auf den Vast-gehosteten Pods der Flotte aus. Die Pods sprechen
 * das Job-Protokoll aus `services/audiomonastry-ai-runtime/pod_jobs.py`:
 *   POST /runsync · POST /run · GET /status/{id} · POST /cancel/{id}
 *
 * Rolle → Provider-ID: `vast-${role}` (brain, ears, voiceGen, music, imageHq,
 * videoReal, videoAbstract, orchestrator).
 *
 * Adresse je Pod: `podRouting.podBaseUrl` (VAST_POD_URL_*), Token: AI_POD_TOKEN.
 *
 * Herkunft: Pod-Pfad des früheren RunPodProvider (bis 285ef5c). Der
 * RunPod-Serverless-Pfad (api.runpod.ai) ist mit der Vast-Migration entfallen;
 * außerhalb des Pod-Modus ist der Provider nicht verfügbar.
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

  private get timeoutMs(): number {
    return Number(env('VAST_AI_TASK_TIMEOUT_MS') || 600_000);
  }

  private get warmupTimeoutMs(): number {
    return Number(env('VAST_WARMUP_TIMEOUT_MS') || 900_000);
  }

  get available(): boolean {
    // INFRA-FEAT-001/002: Der AI-Betriebsmodus ist Teil der Verfügbarkeit.
    // Bei „AI aus“ bzw. für Visual-Rollen im Modus "ohne Visuals" ist der
    // Provider nicht verfügbar – der Router fällt dann auf lokale Pfade
    // (deterministisch) zurück statt eine GPU zu wecken.
    if (fleetMode() !== 'pods') return false;
    const pod = podRoleFor(this.roleId);
    return Boolean(pod && podBaseUrl(pod) && podToken()) && isRoleAllowed(this.roleId);
  }

  canRun(task: AiTask, _model?: string): boolean {
    return task === 'warmup' || GPU_ROLES[this.roleId].tasks.includes(task);
  }

  /** Nur die Tasks der eigenen Rolle – die Task-Mengen sind disjunkt. */
  canRun(task: AiTask): boolean {
    return Boolean(this.resolved?.tasks.includes(task));
  }

  /** Kostenschätzung aus dem Stundensatz der Rolle (sekundengenaue Abrechnung angenommen). */
  estimateCostUsd(_task?: AiTask, _model?: string): number {
    const override = Number(process.env[`AI_COST_VAST_${this.roleId.toUpperCase()}_USD_PER_HOUR`] ?? '');
    const perHour = Number.isFinite(override) && override > 0 ? override : DEFAULT_HOURLY_USD[this.roleId];
    return (ASSUMED_JOB_SECONDS / 3600) * perHour;
  }

  run(task: AiTask, model: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
    return this.execute(task, model, input, signal, false);
  }

  private async execute(task: AiTask, model: string, input: unknown, signal: AbortSignal | undefined, forceAsync: boolean): Promise<unknown> {
    this.assertConfigured(task, model, input);
    return this.runOnPod(task, model, input, signal, (s) => this.runDirect(task, model, input, s));
  }

  /**
   * Pod-Modus (FLEET-P1-001/-009): Start-Trigger des Ziel-Pods (lazy wake,
   * bereit = keine Wartezeit), dann die Prioritäts-Warteschlange des Pods
   * (TTS > SFX > LEGO; TTS darf einen laufenden LEGO-Job unterbrechen).
   */
  private async runOnPod(
    task: AiTask,
    model: string,
    input: unknown,
    signal: AbortSignal | undefined,
    exec: (signal: AbortSignal) => Promise<unknown>,
  ): Promise<unknown> {
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
      // FLEET-P1-012: Job-Ende schiebt den Idle-Timer des Auto-Stops weiter.
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

  /** `POST /cancel/{id}` – best effort; Ergebnis wird nur geloggt. */
  private async cancelRemote(target: JobTarget, jobId: string): Promise<void> {
    try {
      const resp = await fetch(`${target.base}/cancel/${encodeURIComponent(jobId)}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${target.auth}` },
        signal: AbortSignal.timeout(10_000),
      });
      aiLogger.info('remote cancel after preemption', { provider: this.id, jobId, status: resp.status, supported: resp.ok });
    } catch (error) {
      aiLogger.warn('remote cancel after preemption failed', { provider: this.id, jobId, error: (error as Error).message });
    }
  }

  /**
   * Status-Polling eines Pod-Jobs (DA-2026-10-17-016).
   *
   * Vorher: eine While-Schleife ohne Versuchsdeckel, ohne Jitter und - sobald
   * ein Aufrufer-Signal gesetzt war - ohne eigenen Request-Timeout. Ein
   * haengender Status-Endpunkt belegte den Aufrufer damit bis zur globalen
   * Deadline (Default 600 s). Jetzt gilt:
   *   - hartes ENDE ueber die uebergebene Deadline (Gesamtlauf, nicht pro Schritt)
   *   - jeder Status-GET hat sein eigenes Timeout (30 s), kombiniert mit dem
   *     Abbruchsignal des Aufrufers
   *   - Backoff mit Jitter, Deckel 30 s, Versuchsdeckel (`VAST_POLL_MAX_ATTEMPTS`)
   *   - transiente Netz-/5xx-Fehler werden bis `VAST_POLL_MAX_ERRORS`
   *     aufeinanderfolgenden Fehlern toleriert, dann abgebrochen
   *   - ein Abbruch des Aufrufers endet sofort als CANCELLED
   * Das Antwortformat bleibt unveraendert (`PodJobResponse`).
   */
  private async pollLoop(
    target: JobTarget,
    jobId: string,
    signal: AbortSignal | undefined,
    deadline: number,
  ): Promise<PodJobResponse> {
    const url = `${target.base}/status/${encodeURIComponent(jobId)}`;
    const initialDelay = Math.max(0, Number(env('VAST_POLL_INITIAL_MS') || 1_500));
    const maxDelay = Math.max(initialDelay, Number(env('VAST_POLL_MAX_DELAY_MS') || 30_000));
    const maxAttempts = Math.max(1, Number(env('VAST_POLL_MAX_ATTEMPTS') || 240));
    const maxErrors = Math.max(0, Number(env('VAST_POLL_MAX_ERRORS') || 3));

    let delay = initialDelay;
    let attempts = 0;
    let consecutiveErrors = 0;
    let last: PodJobResponse = { status: 'IN_QUEUE' };

    const backoff = async (): Promise<void> => {
      const jitter = 0.8 + Math.random() * 0.4;
      const wait = Math.min(maxDelay, Math.round(delay * jitter));
      await sleep(Math.max(0, Math.min(wait, deadline - Date.now())));
      delay = Math.min(maxDelay, Math.max(initialDelay, Math.round(delay * 1.5)));
    };

    while (attempts < maxAttempts) {
      if (signal?.aborted) throw new AiProviderError(this.id, 'CANCELLED', 'request cancelled', false);
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      attempts += 1;

      let resp: Response;
      try {
        const requestTimeout = AbortSignal.timeout(Math.max(1_000, Math.min(remaining, 30_000)));
        resp = await fetch(url, {
          headers: { Authorization: `Bearer ${target.auth}` },
          signal: signal ? AbortSignal.any([signal, requestTimeout]) : requestTimeout,
        });
      } catch (error) {
        if (signal?.aborted) throw new AiProviderError(this.id, 'CANCELLED', 'request cancelled', false);
        consecutiveErrors += 1;
        last = { status: 'IN_PROGRESS' };
        if (consecutiveErrors > maxErrors) {
          aiLogger.warn('vast poll failed', { provider: this.id, jobId, attempts, error: (error as Error).message });
          throw new AiProviderError(this.id, 'POD_POLL_FAILED', `Pod-Status ${jobId} nicht erreichbar`, true);
        }
        aiLogger.warn('vast poll retry', { provider: this.id, jobId, consecutiveErrors });
        await backoff();
        continue;
      }

      if (resp.status === 404) {
        throw new AiProviderError(this.id, 'JOB_NOT_FOUND', `Pod-Job ${jobId} unbekannt`, false);
      }
      if (resp.status === 429 || resp.status >= 500) {
        // Transient: der Job laeuft weiter, nur der Status-Endpunkt klemmt.
        consecutiveErrors += 1;
        if (consecutiveErrors > maxErrors) {
          throw new AiProviderError(this.id, `HTTP_${resp.status}`, `Pod-Status ${resp.status}`, true);
        }
        await backoff();
        continue;
      }
      if (!resp.ok) {
        throw new AiProviderError(this.id, `HTTP_${resp.status}`, `Pod-Status ${resp.status}`, false);
      }

      consecutiveErrors = 0;
      last = (await resp.json()) as PodJobResponse;
      const status = String(last.status ?? '').toUpperCase();
      if (status && status !== 'IN_QUEUE' && status !== 'IN_PROGRESS') return last;
      await backoff();
    }

    // Deadline oder Versuchsdeckel erreicht: derselbe Fehlercode wie bisher.
    throw new AiProviderError(this.id, 'TIMEOUT', `Pod-Job ${jobId} Timeout (${this.timeoutMs} ms)`, true);
  }
}
