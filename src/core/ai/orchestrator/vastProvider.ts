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
import type { GpuRoleId } from '../../../config/aiInfrastructure';
import { VAST_48GB_USD_PER_HOUR } from '../../../config/aiInfrastructure';
import { AiGateError, assertRoleAllowed, isRoleAllowed, roleBlockCode } from '../aiGate';
import { aiLogger } from './aiLogger';
import { LONG_RUNNING_TASKS, resolveGpuRoles, type ResolvedGpuRole } from './endpointRegistry';
import { classifyPodJob, isPreemptionError, PodPreemption, podQueue } from './podJobQueue';
import { fleetMode, podBaseUrl, podRoleFor, podToken, type PodRoleId } from './podRouting';
import { ensurePodForJob, markPodStale, notePodActivity, PodWakeBlockedError } from './podStartTriggers';
import { AiProviderError, type AiProviderId, type AiTask, type IAiProvider } from './types';

/** Provider-ID je Flotten-Rolle. */
const PROVIDER_ID_BY_ROLE: Record<GpuRoleId, AiProviderId> = {
  brain: 'vast-brain',
  ears: 'vast-ears',
  voiceGen: 'vast-voiceGen',
  music: 'vast-music',
  imageHq: 'vast-imageHq',
  videoReal: 'vast-videoReal',
  videoAbstract: 'vast-videoAbstract',
  orchestrator: 'vast-orchestrator',
};

/**
 * Startpreise in USD/h - EINE Quelle (FLEET-P1-015 e): der Listenpreis steht in
 * `VAST_48GB_USD_PER_HOUR` (aiInfrastructure.ts) und wird hier nur gelesen.
 * Vorher standen hier 0,39 $/h gegen 0,49 $/h an zwei anderen Stellen - eine
 * Kostenschaetzung, die 20 % zu niedrig liegt, ist die gefaehrliche Richtung.
 */
const DEFAULT_HOURLY_USD: Record<GpuRoleId, number> = {
  brain: VAST_48GB_USD_PER_HOUR.pod.A40,
  ears: VAST_48GB_USD_PER_HOUR.pod.A40,
  voiceGen: VAST_48GB_USD_PER_HOUR.pod.A40,
  music: VAST_48GB_USD_PER_HOUR.pod.A40,
  imageHq: VAST_48GB_USD_PER_HOUR.pod.A40,
  videoReal: VAST_48GB_USD_PER_HOUR.pod.A40,
  videoAbstract: VAST_48GB_USD_PER_HOUR.pod.A40,
  orchestrator: VAST_48GB_USD_PER_HOUR.pod.A40,
};

/** Angenommene Jobdauer für die Kostenschätzung (sekundengenaue Abrechnung angenommen). */
const ASSUMED_JOB_SECONDS = 10;

/**
 * Ist der Job-Status noch nicht entschieden? Bei einem Kaltstart antwortet
 * `runsync` mit `IN_QUEUE`/`IN_PROGRESS` statt mit einem Ergebnis - der Job
 * laeuft serverseitig weiter und muss gepollt werden (DB-P1-004).
 */
export function isNonTerminalStatus(status: unknown): boolean {
  const s = String(status ?? '').toUpperCase();
  return s === 'IN_QUEUE' || s === 'IN_PROGRESS';
}

/** Ergebnis eines Warmup-Aufrufs (Session-Wake). */
export interface WarmupResult {
  role: GpuRoleId;
  ok: boolean;
  models: readonly string[];
  message?: string;
}

interface PodJobResponse {
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

/** Wohin ein Job geht: Pod-Basis-URL + Token. */
interface JobTarget {
  base: string;
  auth: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

  /**
   * Ziel eines Jobs. Pods: je Aufgabe der passende Pod (Stem-Trennung → stems,
   * LEGO/extract/complete mit xl-base → voice, FLEET-P1-009).
   */
  private targetFor(task?: AiTask, model?: string, input?: unknown): JobTarget {
    const pod = podRoleFor(this.roleId, task, model, input);
    return { base: pod ? podBaseUrl(pod) : '', auth: podToken() };
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

  async run(task: AiTask, model: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
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
    try {
      await ensurePodForJob(pod, task, signal);
    } catch (error) {
      if (error instanceof PodWakeBlockedError) {
        throw new AiProviderError(this.id, `POD_WAKE_${error.block.toUpperCase().replace(/-/g, '_')}`, error.message, false);
      }
      if (signal?.aborted) throw new AiProviderError(this.id, 'CANCELLED', 'request cancelled', false);
      throw error;
    }
    const cls = classifyPodJob(task, model, input);
    try {
      return await podQueue(pod).run(cls, `${task}:${model}`, exec, signal, this.id);
    } catch (error) {
      if (isPreemptionError(error)) {
        aiLogger.warn('pod job preempted, caller must retry', { provider: this.id, pod, task, model, code: (error as AiProviderError).code });
      } else if (!(error instanceof AiProviderError) || /^HTTP_5/.test(error.code)) {
        // Netzfehler/5xx: beim nächsten Job erneut prüfen, ob der Pod noch läuft.
        markPodStale(pod, (error as Error).message);
      }
      throw error;
    } finally {
      // FLEET-P1-012: Job-Ende schiebt den Idle-Timer des Auto-Stops weiter.
      notePodActivity(`job ${task} finished on ${pod}`);
    }
  }

  private async runDirect(task: AiTask, model: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
    const started = Date.now();
    const deadline = started + this.timeoutMs;
    const body = { input: { task, model, input } };
    const target = this.targetFor(task, model, input);

    if (LONG_RUNNING_TASKS.has(task)) {
      return this.submitAndPoll(target, task, model, input, signal, started, deadline);
    }

    const sync = await this.submitWithRetry(target, 'runsync', body, signal, deadline);
    // Kaltstart (scale-to-zero): runsync endet dann mit IN_QUEUE/IN_PROGRESS,
    // weil sein Wartefenster kuerzer ist als der Worker-Start. Der Job laeuft
    // serverseitig weiter - also denselben Job zu Ende pollen, statt einen
    // laufenden Job als Fehler zu verwerfen.
    if (isNonTerminalStatus(sync.status)) {
      const jobId = String(sync.id ?? '');
      if (!jobId) throw new AiProviderError(this.id, 'NO_JOB_ID', 'Pod lieferte keine Job-ID', false);
      const finished = await this.pollUntilDone(target, jobId, signal, deadline);
      return this.unwrap(finished, task, model, started);
    }
    return this.unwrap(sync, task, model, started);
  }

  /**
   * `run`, aber IMMER ueber `/run` + Status-Polling - auch fuer Tasks, die
   * sonst `runsync` nutzen. Fuer Batch-/CLI-Pfade (z. B. den Embedding-Indexer),
   * die einen Kaltstart bewusst in Kauf nehmen. Live gemessen 2026-09-17: zwei
   * Embedding-Jobs des Indexers endeten nach 3 Minuten mit
   * `Worker-Fehler: IN_QUEUE`, weil `runsync` das Kaltstart-Fenster nicht
   * ueberbrueckt - der Batch-Lauf war damit nicht reproduzierbar.
   */
  async runLong(task: AiTask, model: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
    this.assertConfigured(task, model, input);
    const exec = (s?: AbortSignal) => {
      const started = Date.now();
      return this.submitAndPoll(this.targetFor(task, model, input), task, model, input, s, started, started + this.timeoutMs);
    };
    return this.runOnPod(task, model, input, signal, exec);
  }

  /** Endpoint-ID + Key pruefen (identische Fehler wie bisher in `run`). */
  private assertConfigured(task?: AiTask, model?: string, input?: unknown): void {
    // INFRA-FEAT-001/002: ZUERST der Betriebsmodus. Bei „AI aus“ (bzw. für
    // Visual-Rollen ohne Visual-Freigabe) darf überhaupt kein Endpoint-Kontakt
    // entstehen – auch dann nicht, wenn Endpoint-ID und Key gesetzt sind.
    try {
      assertRoleAllowed(this.roleId, 'vast');
    } catch (error) {
      if (error instanceof AiGateError) {
        throw new AiProviderError(this.id, error.code, error.message, false);
      }
      throw error;
    }
    if (fleetMode() !== 'pods') {
      throw new AiProviderError(this.id, 'FLEET_NOT_PODS', 'Vast-Pods nicht aktiv (Serverless-Pfad entfernt)', false);
    }
    const pod = podRoleFor(this.roleId, task, model, input);
    if (!pod) {
      throw new AiProviderError(this.id, 'NO_POD_FOR_ROLE', `Für ${this.roleId} gibt es keinen Pod (keine Visual-Generierung)`, false);
    }
    if (!podBaseUrl(pod)) {
      throw new AiProviderError(this.id, 'POD_NOT_CONFIGURED', `Pod ${pod} fehlt (VAST_POD_URL_${pod.toUpperCase().replace(/-/g, '_')})`, false);
    }
    if (!podToken()) {
      throw new AiProviderError(this.id, 'NO_POD_TOKEN', 'AI_POD_TOKEN fehlt oder ist kürzer als 32 Zeichen', false);
    }
  }

  /** Submit per `/run` + Polling bis terminal - gemeinsamer Kern von run/runLong. */
  private async submitAndPoll(
    target: JobTarget,
    task: AiTask,
    model: string,
    input: unknown,
    signal: AbortSignal | undefined,
    started: number,
    deadline: number,
  ): Promise<unknown> {
    const submitted = await this.submitWithRetry(target, 'run', { input: { task, model, input } }, signal, deadline);
    const jobId = String(submitted.id ?? '');
    if (!jobId) throw new AiProviderError(this.id, 'NO_JOB_ID', 'Pod lieferte keine Job-ID', false);
    const finished = await this.pollUntilDone(target, jobId, signal, deadline);
    return this.unwrap(finished, task, model, started);
  }

  /**
   * Löst einen Warmup-Job aus, der die Preload-Modelle der Rolle in VRAM lädt.
   * Wird vom Session-Wake (`fleetWake.ts`) genutzt, damit der erste echte Task
   * keinen Modell-Load mehr bezahlt (die App braucht ohnehin 5–10 min zum Start).
   */
  async warmup(signal?: AbortSignal): Promise<WarmupResult> {
    const models = this.resolved?.preload ?? [];
    // INFRA-FEAT-001/002: Kein Warmup-Job, wenn der Betriebsmodus die Rolle sperrt.
    const block = roleBlockCode(this.roleId);
    if (block) {
      aiLogger.info('warmup suppressed by ai mode', { role: this.roleId, block });
      return { role: this.roleId, ok: false, models, message: block };
    }
    if (!this.available) {
      return { role: this.roleId, ok: false, models, message: 'endpoint not configured' };
    }
    const deadline = Date.now() + this.warmupTimeoutMs;
    const target = this.targetFor();
    try {
      const submitted = await this.submitWithRetry(
        target,
        'run',
        // Die Rolle entscheidet im Worker, welche Preload-Modelle geladen werden.
        { input: { task: 'warmup', model: '', input: { role: this.roleId, models } } },
        signal,
        deadline,
      );
      const jobId = String(submitted.id ?? '');
      if (!jobId) return { role: this.roleId, ok: false, models, message: 'no job id' };
      const finished = await this.pollUntilDone(target, jobId, signal, deadline);
      const status = String(finished.status ?? '').toUpperCase();
      const ok = status === 'COMPLETED';
      return { role: this.roleId, ok, models, message: ok ? undefined : String(finished.error ?? status) };
    } catch (error) {
      return { role: this.roleId, ok: false, models, message: (error as Error).message };
    }
  }

  /** Normalisiert Pod- und Worker-Fehler zu AiProviderError. */
  private unwrap(data: PodJobResponse, task: AiTask, model: string, started: number): unknown {
    const status = String(data.status ?? '').toUpperCase();
    if (status === 'FAILED' || status === 'ERROR') {
      throw new AiProviderError(this.id, 'JOB_FAILED', String(data.error ?? 'Pod-Job fehlgeschlagen'), true);
    }
    if (status === 'CANCELLED' || status === 'TIMED_OUT') {
      throw new AiProviderError(this.id, 'JOB_FAILED', `Pod-Job ${status}`, false);
    }
    if (status && status !== 'COMPLETED') {
      throw new AiProviderError(this.id, 'JOB_INCOMPLETE', `Pod-Job endete mit Status ${status}`, true);
    }

    aiLogger.info('vast inference', {
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
    target: JobTarget,
    path: 'run' | 'runsync',
    body: unknown,
    signal: AbortSignal | undefined,
    deadline: number,
  ): Promise<PodJobResponse> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (signal?.aborted) throw new AiProviderError(this.id, 'CANCELLED', 'request cancelled', false);
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new AiProviderError(this.id, 'TIMEOUT', `Pod-Deadline überschritten (${this.timeoutMs} ms)`, true);
      }
      try {
        return await this.post(target, path, body, signal, remaining);
      } catch (error) {
        if (signal?.aborted) throw new AiProviderError(this.id, 'CANCELLED', 'request cancelled', false);
        lastError = error;
        if (error instanceof AiProviderError && !error.retryable) throw error;
        if (attempt < 2) await sleep(1000 * 2 ** attempt);
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new AiProviderError(this.id, 'POD_UNREACHABLE', 'Pod nicht erreichbar', true);
  }

  private async post(
    target: JobTarget,
    path: string,
    body: unknown,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<PodJobResponse> {
    const url = `${target.base}/${path}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${target.auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(Math.max(1_000, timeoutMs)),
    });

    if (resp.status === 402) {
      throw new AiProviderError(this.id, 'INSUFFICIENT_CREDIT', `${this.roleId}: Guthaben aufgebraucht`, false);
    }
    if (resp.status === 429) {
      throw new AiProviderError(this.id, 'RATE_LIMITED', `${this.roleId}: Pod 429`, true);
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new AiProviderError(this.id, `HTTP_${resp.status}`, text.slice(0, 300), resp.status >= 500);
    }
    return (await resp.json()) as PodJobResponse;
  }

  private async pollUntilDone(
    target: JobTarget,
    jobId: string,
    signal: AbortSignal | undefined,
    deadline: number,
  ): Promise<PodJobResponse> {
    try {
      return await this.pollLoop(target, jobId, signal, deadline);
    } catch (error) {
      // FLEET-P1-009: Bei einer Unterbrechung zugunsten von TTS den Job auch auf
      // der GPU-Seite abbrechen (best effort, nie werfen).
      if (signal?.aborted && signal.reason instanceof PodPreemption) void this.cancelRemote(target, jobId);
      throw error;
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
