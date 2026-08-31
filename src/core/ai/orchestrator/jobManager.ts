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

export interface JobManagerOptions {
  maxConcurrency?: Partial<Record<AiTask, number>>;
}

export class JobManager {
  private jobs = new Map<string, AiJob>();
  private runningByTask = new Map<AiTask, number>();
  private dedupe = new Map<string, string>(); // dedupeKey -> jobId (laufend)
  private limits: Record<AiTask, number>;

  constructor(private options: JobManagerOptions = {}) {
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
      'audio.generate': 1,
      'multimodal': 1,
      ...options.maxConcurrency,
    };
  }

  private now(): number {
    return Date.now();
  }

  dedupeKey(sessionId: string, task: AiTask, model: string, input: unknown): string {
    const hash = createHash('sha256').update(JSON.stringify(input ?? {})).digest('hex').slice(0, 16);
    return `${sessionId}:${task}:${model}:${hash}`;
  }

  /** Erstellt einen Job oder liefert den bereits laufenden identischen Job. */
  create(sessionId: string, userId: string, task: AiTask, model: string, provider: AiJob['provider'], input: unknown): AiJob {
    const key = this.dedupeKey(sessionId, task, model, input);
    const existingId = this.dedupe.get(key);
    if (existingId) {
      const existing = this.jobs.get(existingId);
      if (existing && (existing.status === 'QUEUED' || existing.status === 'STARTING' || existing.status === 'RUNNING')) {
        aiLogger.info('duplicate ai job deduplicated', { jobId: existing.jobId, sessionId, task, model });
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
      dedupeKey: key,
    };
    this.jobs.set(jobId, job);
    this.dedupe.set(key, jobId);
    aiLogger.info('ai job created', { jobId, sessionId, task, model, provider });
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
    job.status = 'COMPLETED';
    job.completedAt = this.now();
    job.durationMs = job.completedAt - (job.startedAt ?? job.createdAt);
    job.result = result;
    this.release(job);
    aiLogger.info('ai job completed', { jobId, task: job.task, model: job.model, durationMs: job.durationMs });
  }

  fail(jobId: string, error: Error, status: JobStatus = 'FAILED'): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    job.status = status;
    job.completedAt = this.now();
    job.durationMs = job.completedAt - (job.startedAt ?? job.createdAt);
    job.error = error.message;
    this.release(job);
    aiLogger.warn('ai job finished with error', { jobId, task: job.task, model: job.model, status, error: error.message });
  }

  cancel(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    if (job.status === 'COMPLETED' || job.status === 'FAILED' || job.status === 'CANCELLED' || job.status === 'TIMEOUT') return;
    job.status = 'CANCELLED';
    job.completedAt = this.now();
    this.release(job);
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

  private release(job: AiJob): void {
    if (job.status === 'STARTING' || job.status === 'RUNNING' || job.status === 'QUEUED') {
      this.runningByTask.set(job.task, Math.max(0, (this.runningByTask.get(job.task) ?? 1) - 1));
    }
    if (job.dedupeKey && this.dedupe.get(job.dedupeKey) === job.jobId) {
      this.dedupe.delete(job.dedupeKey);
    }
  }
}
