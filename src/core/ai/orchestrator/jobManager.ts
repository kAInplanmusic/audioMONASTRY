/**
 * audioMONASTRY · AI Orchestrator – Job System
 * =============================================
 * Jeder AI-Request bekommt einen Job mit jobId/sessionId/userId/model/provider/
 * status/Zeitstempeln/error. Status: QUEUED, STARTING, RUNNING, COMPLETED,
 * FAILED, CANCELLED, TIMEOUT.
 *
 * SampleMONK-Regel: Kein unkontrolliert paralleler identischer Job.
 * Dedup-Key = sessionId + task + model + input-Hash → identische Requests
 * laufen nicht doppelt (SingleFlight: laufender Job wird zurückgegeben).
 * Concurrency-Limits je Task-Klasse konfigurierbar.
 */
import { createHash } from 'node:crypto';
import { aiLogger } from './aiLogger';
import type { AiJob, AiTask, JobStatus } from './types';

/**
 * Gleicher Idempotenz-Schlüssel, aber anderer Payload: der Aufrufer hat den
 * Schlüssel wiederverwendet (Client-Bug oder Retry mit geändertem Request).
 * Wird als Konflikt gemeldet (HTTP 409), nie still als anderer Job ausgeführt.
 */
export class IdempotencyConflictError extends Error {
  readonly jobId: string;
  constructor(idempotencyKey: string, jobId: string) {
    super(`idempotency key reused with a different payload: ${idempotencyKey}`);
    this.name = 'IdempotencyConflictError';
    this.jobId = jobId;
  }
}

export interface JobManagerOptions {
  maxConcurrency?: Partial<Record<AiTask, number>>;
  /** Wie lange ein Idempotenz-Schlüssel gültig bleibt (Default 24 h). */
  idempotencyTtlMs?: number;
  /** Injizierbare Uhr (Tests). */
  now?: () => number;
}

export class JobManager {
  private jobs = new Map<string, AiJob>();
  private runningByTask = new Map<AiTask, number>();
  private dedupe = new Map<string, string>(); // dedupeKey -> jobId (laufend)
  /** Idempotenz: `${sessionId}:${key}` -> { jobId, fingerprint, at } */
  private idempotency = new Map<string, { jobId: string; fingerprint: string; at: number }>();
  private limits: Record<AiTask, number>;
  private readonly idempotencyTtlMs: number;

  constructor(private options: JobManagerOptions = {}) {
    this.idempotencyTtlMs = options.idempotencyTtlMs ?? 24 * 60 * 60 * 1000;
    this.limits = {
      'llm': 4,
      'tts': 2,
      'sing': 1,
      'song': 1,
      'stem.separate': 2,
      'audio.classify': 2,
      'audio.transcribe': 2,
      'audio.embed': 2,
      'audio.analyze': 1,
      'audio.diarize': 1,
      'audio.understand': 1,
      'audio.generate': 1,
      'multimodal': 1,
      'nlu': 4,
      ...options.maxConcurrency,
    };
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  dedupeKey(sessionId: string, task: AiTask, model: string, input: unknown): string {
    const hash = createHash('sha256').update(JSON.stringify(input ?? {})).digest('hex').slice(0, 16);
    return `${sessionId}:${task}:${model}:${hash}`;
  }

  /** Entfernt abgelaufene Idempotenz-Einträge (bounded memory). */
  private pruneIdempotency(now: number): void {
    for (const [key, entry] of this.idempotency) {
      if (now - entry.at >= this.idempotencyTtlMs) this.idempotency.delete(key);
    }
  }

  /**
   * Erstellt einen Job oder liefert einen bereits existierenden.
   *
   * Dedup (ohne Schlüssel): identischer laufender Request ⇒ derselbe Job.
   * Idempotenz (`opts.idempotencyKey`, z. B. HTTP `Idempotency-Key`): derselbe
   * Schlüssel + identischer Payload liefert **immer** denselben Job – auch wenn
   * er schon COMPLETED ist (Retry-Antwort ohne Doppelausführung). Derselbe
   * Schlüssel mit anderem Payload wirft `IdempotencyConflictError`.
   */
  create(
    sessionId: string,
    userId: string,
    task: AiTask,
    model: string,
    provider: AiJob['provider'],
    input: unknown,
    opts: { idempotencyKey?: string } = {},
  ): AiJob {
    const fingerprint = this.dedupeKey(sessionId, task, model, input);
    const now = this.now();
    const rawKey = (opts.idempotencyKey ?? '').trim().slice(0, 200);
    const idemMapKey = rawKey ? `${sessionId}:${rawKey}` : '';

    if (idemMapKey) {
      const entry = this.idempotency.get(idemMapKey);
      if (entry) {
        if (now - entry.at >= this.idempotencyTtlMs) {
          this.idempotency.delete(idemMapKey);
        } else {
          const existing = this.jobs.get(entry.jobId);
          if (existing) {
            if (entry.fingerprint !== fingerprint) {
              aiLogger.warn('idempotency key reuse conflict', { sessionId, task, model });
              throw new IdempotencyConflictError(rawKey, existing.jobId);
            }
            aiLogger.info('idempotent ai job replayed', { jobId: existing.jobId, sessionId, task, model, status: existing.status });
            return existing;
          }
          this.idempotency.delete(idemMapKey);
        }
      }
      this.pruneIdempotency(now);
    }

    const existingId = this.dedupe.get(fingerprint);
    if (existingId) {
      const existing = this.jobs.get(existingId);
      if (existing && (existing.status === 'QUEUED' || existing.status === 'STARTING' || existing.status === 'RUNNING')) {
        aiLogger.info('duplicate ai job deduplicated', { jobId: existing.jobId, sessionId, task, model });
        if (idemMapKey) this.idempotency.set(idemMapKey, { jobId: existing.jobId, fingerprint, at: now });
        return existing;
      }
    }
    const jobId = `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const job: AiJob = {
      jobId,
      sessionId,
      userId,
      task,
      model,
      provider,
      status: 'QUEUED',
      createdAt: this.now(),
      startedAt: null,
      completedAt: null,
      durationMs: null,
      error: null,
      dedupeKey: fingerprint,
      idempotencyKey: rawKey || null,
    };
    this.jobs.set(jobId, job);
    this.dedupe.set(fingerprint, jobId);
    if (idemMapKey) this.idempotency.set(idemMapKey, { jobId, fingerprint, at: now });
    aiLogger.info('ai job created', { jobId, sessionId, task, model, provider, idempotent: Boolean(rawKey) });
    return job;
  }

  get(jobId: string): AiJob | undefined {
    const job = this.jobs.get(jobId);
    return job ? { ...job } : undefined;
  }

  list(sessionId?: string): AiJob[] {
    return [...this.jobs.values()]
      .filter((j) => !sessionId || j.sessionId === sessionId)
      .map((j) => ({ ...j }))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  canStart(task: AiTask): boolean {
    return (this.runningByTask.get(task) ?? 0) < (this.limits[task] ?? 1);
  }

  start(jobId: string): AiJob | undefined {
    const job = this.jobs.get(jobId);
    if (!job) return undefined;
    if (!this.canStart(job.task)) {
      throw new Error(`concurrency limit reached for task ${job.task}`);
    }
    job.status = 'STARTING';
    job.startedAt = this.now();
    this.runningByTask.set(job.task, (this.runningByTask.get(job.task) ?? 0) + 1);
    return { ...job };
  }

  markRunning(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (job) job.status = 'RUNNING';
  }

  complete(jobId: string, result?: unknown): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    const wasRunning = this.isRunning(job);
    job.status = 'COMPLETED';
    job.completedAt = this.now();
    job.durationMs = job.completedAt - (job.startedAt ?? job.createdAt);
    job.result = result;
    this.release(job, wasRunning);
    aiLogger.info('ai job completed', { jobId, task: job.task, model: job.model, durationMs: job.durationMs });
  }

  fail(jobId: string, error: Error, status: JobStatus = 'FAILED'): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    const wasRunning = this.isRunning(job);
    job.status = status;
    job.completedAt = this.now();
    job.durationMs = job.completedAt - (job.startedAt ?? job.createdAt);
    job.error = error.message;
    this.release(job, wasRunning);
    aiLogger.warn('ai job finished with error', { jobId, task: job.task, model: job.model, status, error: error.message });
  }

  cancel(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    if (job.status === 'COMPLETED' || job.status === 'FAILED' || job.status === 'CANCELLED' || job.status === 'TIMEOUT') return;
    const wasRunning = this.isRunning(job);
    job.status = 'CANCELLED';
    job.completedAt = this.now();
    this.release(job, wasRunning);
  }

  /** Dead-Job-Detection: hängende Jobs nach Timeout automatisch beenden. */
  cleanupStale(maxMs = 10 * 60 * 1000): AiJob[] {
    const stale: AiJob[] = [];
    const now = this.now();
    for (const job of this.jobs.values()) {
      if ((job.status === 'STARTING' || job.status === 'RUNNING' || job.status === 'QUEUED') && now - job.createdAt >= maxMs) {
        this.fail(job.jobId, new Error('job timed out (stale detection)'), 'TIMEOUT');
        stale.push(job);
      }
    }
    return stale;
  }

  /** Belegt der Job aktuell einen Concurrency-Slot? (nur nach `start()`). */
  private isRunning(job: AiJob): boolean {
    return job.status === 'STARTING' || job.status === 'RUNNING';
  }

  /**
   * Gibt Concurrency-Slot und Dedupe-Key frei. `wasRunning` muss VOR dem
   * Statuswechsel ermittelt werden – sonst bliebe der Slot dauerhaft belegt.
   */
  private release(job: AiJob, wasRunning: boolean): void {
    if (wasRunning) {
      this.runningByTask.set(job.task, Math.max(0, (this.runningByTask.get(job.task) ?? 1) - 1));
    }
    if (job.dedupeKey && this.dedupe.get(job.dedupeKey) === job.jobId) {
      this.dedupe.delete(job.dedupeKey);
    }
  }
}
