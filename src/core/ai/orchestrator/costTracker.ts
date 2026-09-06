/**
 * audioMONASTRY · AI Orchestrator – Cost Tracking
 * ================================================
 * Erfasst pro Job/Session: GPU-Runtime, Startup, Inferenz, Modell, GPU-Typ,
 * geschätzte Kosten. Keine Fantasiewerte – Preisquellen sind unten dokumentiert
 * und per Env überschreibbar (AI_COST_*).
 *
 * Preisquellen (Stand 2026-08, live zu verifizieren):
 * - HF Endpoint A100 (AWS): $2.50/h – huggingface.co/docs/inference-endpoints/pricing
 * - HF CPU (intel-spr): $0.033/h – ebd.
 * - Replicate Demucs: ~$0.05/Stem-Job – Modellseite cjwbw/demucs
 * - DeepSeek V4 Flash: $0.22–0.44/M in, $0.66–1.32/M out – api-docs.deepseek.com
 * - HF Serverless: Free-Tier/PRO $9/Monat – huggingface.co/pricing
 */
import { aiLogger } from './aiLogger';
import type { AiJob, AiProviderId, AiTask } from './types';

export interface CostEntry {
  jobId: string;
  sessionId: string;
  provider: AiProviderId;
  task: AiTask;
  model: string;
  gpuType: string;
  gpuRuntimeMs: number;
  inferenceMs: number;
  estimatedCostUsd: number;
  createdAt: number;
}

const USD_PER_GPU_HOUR: Record<string, number> = {
  'A100': Number(process.env.AI_COST_A100_USD_PER_HOUR ?? 2.5),
  'L4': Number(process.env.AI_COST_L4_USD_PER_HOUR ?? 0.8),
  'CPU': Number(process.env.AI_COST_CPU_USD_PER_HOUR ?? 0.033),
};

const TASK_COST_USD: Partial<Record<AiTask, number>> = {
  'stem.separate': Number(process.env.AI_COST_STEM_USD ?? 0.05),
  'tts': Number(process.env.AI_COST_TTS_USD ?? 0.002),
  'sing': Number(process.env.AI_COST_SING_USD ?? 0.005),
  'song': Number(process.env.AI_COST_SONG_USD ?? 0.02),
  'llm': Number(process.env.AI_COST_LLM_USD ?? 0.001),
};

export class CostTracker {
  private entries: CostEntry[] = [];
  private bySession = new Map<string, CostEntry[]>();
  private byJob = new Map<string, CostEntry>();
  // FA-P2-1: Retention-Fenster (Default 30 Tage) gegen unbegrenztes Wachstum.
  private readonly retentionMs = Number(process.env.AI_COST_RETENTION_MS ?? 30 * 24 * 3_600_000);
  private gpuType = process.env.AI_GPU_TYPE ?? 'A100';

  setGpuType(gpuType: string): void {
    this.gpuType = gpuType;
  }

  estimateGpuCostUsd(gpuRuntimeMs: number, gpuType = this.gpuType): number {
    const rate = USD_PER_GPU_HOUR[gpuType] ?? USD_PER_GPU_HOUR.A100;
    return (gpuRuntimeMs / 3_600_000) * rate;
  }

  /** Schätzung für einen Job (vor Ausführung). */
  estimateJobCostUsd(task: AiTask, provider: AiProviderId, _model: string): number {
    if (provider === 'replicate' && task === 'stem.separate') return TASK_COST_USD['stem.separate'] ?? 0.05;
    if (provider === 'hf-endpoint') {
      const gpuMs = 10_000; // konservativ: 10 s aktive GPU inkl. Anteil Kaltstart
      return this.estimateGpuCostUsd(gpuMs);
    }
    if (provider === 'hf-serverless') return TASK_COST_USD[task] ?? 0.001;
    return 0;
  }

  private prune(now = Date.now()): void {
    const cutoff = now - this.retentionMs;
    while (this.entries.length > 0 && this.entries[0].createdAt < cutoff) {
      const old = this.entries.shift()!;
      const sessionList = this.bySession.get(old.sessionId);
      if (sessionList) {
        const idx = sessionList.indexOf(old);
        if (idx >= 0) sessionList.splice(idx, 1);
        if (sessionList.length === 0) this.bySession.delete(old.sessionId);
      }
      if (this.byJob.get(old.jobId) === old) this.byJob.delete(old.jobId);
    }
  }

  record(entry: Omit<CostEntry, 'createdAt'>): CostEntry {
    const full: CostEntry = { ...entry, createdAt: Date.now() };
    this.entries.push(full);
    this.prune();
    const sessionList = this.bySession.get(full.sessionId) ?? [];
    sessionList.push(full);
    this.bySession.set(full.sessionId, sessionList);
    this.byJob.set(full.jobId, full);
    aiLogger.info('cost recorded', {
      jobId: entry.jobId,
      provider: entry.provider,
      task: entry.task,
      estimatedCostUsd: Number(entry.estimatedCostUsd.toFixed(6)),
    });
    return full;
  }

  costForSession(sessionId: string): number {
    return (this.bySession.get(sessionId) ?? []).reduce((sum, e) => sum + e.estimatedCostUsd, 0);
  }

  costForJob(jobId: string): number {
    return this.byJob.get(jobId)?.estimatedCostUsd ?? 0;
  }

  /** Durchschnittskosten pro Stunde (über die letzten `windowMs`). */
  costPerHour(windowMs = 3_600_000): number {
    const cutoff = Date.now() - windowMs;
    const recent = this.entries.filter((e) => e.createdAt >= cutoff);
    const sum = recent.reduce((s, e) => s + e.estimatedCostUsd, 0);
    return (sum / windowMs) * 3_600_000;
  }

  costPerMonth(windowMs = 30 * 24 * 3_600_000): number {
    return (this.costPerHour(windowMs) / 3_600_000) * 30 * 24 * 3_600_000;
  }

  summary() {
    return {
      entries: this.entries.length,
      totalUsd: Number(this.entries.reduce((s, e) => s + e.estimatedCostUsd, 0).toFixed(4)),
      costPerHourUsd: Number(this.costPerHour().toFixed(4)),
      costPerMonthUsd: Number(this.costPerMonth().toFixed(2)),
      gpuType: this.gpuType,
    };
  }

  /** Job-Abrechnung bei Abschluss (nutzt echte Laufzeit). */
  settle(job: AiJob, inferenceMs: number): CostEntry {
    const gpuRuntimeMs = Math.max(inferenceMs, job.durationMs ?? inferenceMs);
    const base =
      job.provider === 'replicate'
        ? TASK_COST_USD['stem.separate'] ?? 0.05
        : job.provider === 'hf-endpoint'
          ? this.estimateGpuCostUsd(gpuRuntimeMs)
          : TASK_COST_USD[job.task] ?? 0;
    return this.record({
      jobId: job.jobId,
      sessionId: job.sessionId,
      provider: job.provider,
      task: job.task,
      model: job.model,
      gpuType: this.gpuType,
      gpuRuntimeMs,
      inferenceMs,
      estimatedCostUsd: Number(base.toFixed(6)),
    });
  }
}
