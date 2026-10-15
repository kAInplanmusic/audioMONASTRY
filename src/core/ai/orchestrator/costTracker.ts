/**
 * audioMONASTRY · AI Orchestrator – Cost Tracking
 * ================================================
 * Erfasst pro Job/Session: GPU-Runtime, Startup, Inferenz, Modell, GPU-Typ,
 * geschätzte Kosten. Keine Fantasiewerte – Preisquellen sind unten dokumentiert
 * und per Env überschreibbar (AI_COST_*).
 *
 * Preisquellen (Stand 2026-09, nach RunPod-Cutover):
 * - RunPod Serverless, 48-GB-Karte (NVIDIA A40): $1.22/h je aktivem Worker
 *   (live gemessen; als residenter Pod dieselbe Karte 0,49 $/h)
 * - Cerebras/DeepSeek V4 Flash: $0.22–0.44/M in, $0.66–1.32/M out – api-docs.deepseek.com
 */
import { envNumber, envString } from '../../../config/aiInfrastructure';
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

// Browser-sicher gelesen: das Modul wird ueber LlmRouter auch vom Client erreicht.
const USD_PER_GPU_HOUR: Record<string, number> = {
  'A100': envNumber('AI_COST_A100_USD_PER_HOUR', 2.5),
  'L4': envNumber('AI_COST_L4_USD_PER_HOUR', 0.8),
  'CPU': envNumber('AI_COST_CPU_USD_PER_HOUR', 0.033),
};

const TASK_COST_USD: Partial<Record<AiTask, number>> = {
  'stem.separate': envNumber('AI_COST_STEM_USD', 0.05),
  'tts': envNumber('AI_COST_TTS_USD', 0.002),
  'sing': envNumber('AI_COST_SING_USD', 0.005),
  'song': envNumber('AI_COST_SONG_USD', 0.02),
  'llm': envNumber('AI_COST_LLM_USD', 0.001),
};

export class CostTracker {
  private entries: CostEntry[] = [];
  private bySession = new Map<string, CostEntry[]>();
  private byJob = new Map<string, CostEntry>();
  // FA-P2-1: Retention-Fenster (Default 30 Tage) gegen unbegrenztes Wachstum.
  private readonly retentionMs = envNumber('AI_COST_RETENTION_MS', 30 * 24 * 3_600_000);
  private gpuType = envString('AI_GPU_TYPE', 'A100');

  setGpuType(gpuType: string): void {
    this.gpuType = gpuType;
  }

  estimateGpuCostUsd(gpuRuntimeMs: number, gpuType = this.gpuType): number {
    const rate = USD_PER_GPU_HOUR[gpuType] ?? USD_PER_GPU_HOUR.A100;
    return (gpuRuntimeMs / 3_600_000) * rate;
  }

  /** Schätzung für einen Job (vor Ausführung). */
  estimateJobCostUsd(task: AiTask, _provider: AiProviderId, _model: string): number {
    return TASK_COST_USD[task] ?? 0;
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

  /** Laufende Pod-Kosten (FLEET-P1-012): Rate, aufgelaufene Summe, läuft der Zähler? */
  podRunStatus(): PodCostMeterStatus {
    return podCostMeter.status();
  }

  /** Job-Abrechnung bei Abschluss (nutzt echte Laufzeit). */
  settle(job: AiJob, inferenceMs: number): CostEntry {
    const base = TASK_COST_USD[job.task] ?? 0;
    return this.record({
      jobId: job.jobId,
      sessionId: job.sessionId,
      provider: job.provider,
      task: job.task,
      model: job.model,
      gpuType: this.gpuType,
      gpuRuntimeMs: Math.max(inferenceMs, job.durationMs ?? inferenceMs),
      inferenceMs,
      estimatedCostUsd: Number(base.toFixed(6)),
    });
  }
}

// ---------------------------------------------------------------------------
// FLEET-P1-012: Laufzeit-Kostenzähler der residenten Pods
// ---------------------------------------------------------------------------
//
// Die Job-Abrechnung oben kennt nur Kosten je Auftrag. Residente RunPod-Pods
// kosten aber pro Stunde, solange sie existieren – auch ohne Auftrag. Dieser
// Zähler integriert die aktuelle Rate (EUR/h) über die Zeit. Er läuft, solange
// die Rate > 0 ist, und STOPPT (Rate 0, keine weitere Aufsummierung), sobald
// der Auto-Stop alle Pods terminiert hat. Kein Timer: aufsummiert wird bei
// jeder Ratenänderung und beim Lesen.

export interface PodCostMeterStatus {
  running: boolean;
  activePods: number;
  eurPerHour: number;
  /** Seit Prozessstart aufgelaufene Pod-Kosten (Schätzung, EUR). */
  accruedEur: number;
  /** Beginn der aktuellen Laufphase (null = gestoppt). */
  since: number | null;
  stoppedAt: number | null;
  /** Kostenzeile für Status/Logs, deutsch formatiert (z. B. "0,00 €/h"). */
  costLine: string;
}

export function formatEurPerHour(eurPerHour: number): string {
  const value = Number.isFinite(eurPerHour) && eurPerHour > 0 ? eurPerHour : 0;
  return `${value.toFixed(2).replace('.', ',')} €/h`;
}

export class PodCostMeter {
  private rate = 0;
  private pods = 0;
  private accrued = 0;
  private lastAt: number | null = null;
  private since: number | null = null;
  private stoppedAt: number | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  private accrue(t: number): void {
    if (this.lastAt !== null && this.rate > 0) {
      this.accrued += ((t - this.lastAt) / 3_600_000) * this.rate;
    }
    this.lastAt = t;
  }

  /** Neue Rate setzen; 0 stoppt den Zähler. */
  setRate(activePods: number, eurPerHour: number): void {
    const t = this.now();
    this.accrue(t);
    const nextRate = Number.isFinite(eurPerHour) && eurPerHour > 0 ? eurPerHour : 0;
    const wasRunning = this.rate > 0;
    this.rate = nextRate;
    this.pods = nextRate > 0 ? Math.max(0, Math.floor(activePods)) : 0;
    if (nextRate > 0 && !wasRunning) {
      this.since = t;
      this.stoppedAt = null;
    } else if (nextRate === 0 && wasRunning) {
      this.since = null;
      this.stoppedAt = t;
      aiLogger.info('pod cost meter stopped', { accruedEur: Number(this.accrued.toFixed(4)), costLine: formatEurPerHour(0) });
    }
  }

  stop(): void {
    this.setRate(0, 0);
  }

  status(): PodCostMeterStatus {
    this.accrue(this.now());
    return {
      running: this.rate > 0,
      activePods: this.pods,
      eurPerHour: Number(this.rate.toFixed(3)),
      accruedEur: Number(this.accrued.toFixed(4)),
      since: this.since,
      stoppedAt: this.stoppedAt,
      costLine: formatEurPerHour(this.rate),
    };
  }

  /** Nur für Tests. */
  reset(): void {
    this.rate = 0;
    this.pods = 0;
    this.accrued = 0;
    this.lastAt = null;
    this.since = null;
    this.stoppedAt = null;
  }
}

/** Eine Instanz je Prozess – die Pods gibt es auch nur einmal. */
export const podCostMeter = new PodCostMeter();
