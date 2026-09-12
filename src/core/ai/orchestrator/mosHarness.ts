/**
 * audioMONASTRY · MOS-Harness (AI-P1-003 P2, Hörer-Erfassung + Gate)
 * ====================================================================
 * MOS (Mean Opinion Score) ist definitionsgemäß eine MENSCHLICHE Bewertung.
 * Dieses Modul macht die Erfassung deterministisch und gate-fähig:
 *
 *   - `add()` validiert jede Hörer-Wertung (1..5, Modell, Sprache, Hörer-ID)
 *     und persistiert sie über `aiPersistence.saveEvaluation`
 *     (task `voice.mos`, pluginId `voice`) – damit fließen die Werte in die
 *     bestehende Evaluierungs-Datenbank.
 *   - `summaryFor()`/`gateFor()` aggregieren je Modell: Anzahl, Mittelwert,
 *     Min/Max und PASS/FAIL gegen `AI_MOS_MIN_SCORE` (Default 4.0) und
 *     `AI_MOS_MIN_RATINGS` (Default 3 Hörer).
 *
 * Ohne echte Hörerwerte bleibt der Gate-Status ehrlich `pass: false` mit
 * Begründung – es wird kein MOS erfunden.
 */
import { aiLogger } from './aiLogger';
import { aiPersistence } from './aiPersistence';

export interface MosRatingInput {
  modelId: string;
  language: 'DE' | 'EN';
  score: number;
  evaluatorId: string;
  notes?: string;
}

export interface MosRating extends MosRatingInput {
  createdAt: number;
}

export interface MosSummary {
  modelId: string;
  count: number;
  avg: number;
  min: number;
  max: number;
  requiredCount: number;
  minScore: number;
  pass: boolean;
  reason: string;
}

function envNum(name: string, fallback: number): number {
  const raw = Number(process.env[name] ?? '');
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

export class MosHarness {
  private readonly ratings: MosRating[] = [];

  get minScore(): number {
    return envNum('AI_MOS_MIN_SCORE', 4);
  }

  get requiredCount(): number {
    return Math.max(1, Math.floor(envNum('AI_MOS_MIN_RATINGS', 3)));
  }

  /** Nimmt eine Hörer-Wertung entgegen (validiert, persistiert, aggregiert). */
  add(input: MosRatingInput): { ok: true; summary: MosSummary } | { ok: false; error: string } {
    const modelId = (input.modelId ?? '').trim().slice(0, 64);
    const evaluatorId = (input.evaluatorId ?? '').trim().slice(0, 64);
    if (!modelId) return { ok: false, error: 'modelId fehlt' };
    if (!evaluatorId) return { ok: false, error: 'evaluatorId fehlt' };
    if (!['DE', 'EN'].includes(input.language)) return { ok: false, error: 'language muss DE oder EN sein' };
    if (!Number.isInteger(input.score) || input.score < 1 || input.score > 5) {
      return { ok: false, error: 'score muss eine ganze Zahl 1..5 sein' };
    }
    const rating: MosRating = {
      modelId,
      language: input.language,
      score: input.score,
      evaluatorId,
      notes: (input.notes ?? '').slice(0, 500),
      createdAt: Date.now(),
    };
    this.ratings.push(rating);

    // In die bestehende Evaluierungs-DB (ai_evaluations) – task voice.mos.
    void aiPersistence.saveEvaluation({
      pluginId: 'voice',
      task: 'voice.mos',
      promptVersion: 1,
      model: modelId,
      provider: 'mos-listener',
      input: JSON.stringify({ language: input.language, evaluatorId }),
      output: String(input.score),
      score: input.score,
      metrics: { latencyMs: 0, exactMatch: false },
    }).catch((e) => {
      aiLogger.warn('mos persistence failed', { modelId, error: (e as Error).message });
    });

    aiLogger.info('mos rating recorded', { modelId, score: input.score, language: input.language });
    return { ok: true, summary: this.summaryFor(modelId) };
  }

  /** Aggregat je Modell inkl. Gate-Entscheidung. */
  summaryFor(modelId: string): MosSummary {
    const all = this.ratings.filter((r) => r.modelId === modelId);
    const count = all.length;
    const scores = all.map((r) => r.score);
    const avg = count ? scores.reduce((a, b) => a + b, 0) / count : 0;
    const pass = count >= this.requiredCount && avg >= this.minScore;
    const reason = count === 0
      ? `keine Hörerwertungen (benötigt ${this.requiredCount})`
      : count < this.requiredCount
        ? `erst ${count} von ${this.requiredCount} Hörerwertungen`
        : `MOS ${avg.toFixed(2)} ${avg >= this.minScore ? '>=' : '<'} ${this.minScore}`;
    return {
      modelId,
      count,
      avg: Number(avg.toFixed(3)),
      min: count ? Math.min(...scores) : 0,
      max: count ? Math.max(...scores) : 0,
      requiredCount: this.requiredCount,
      minScore: this.minScore,
      pass,
      reason,
    };
  }

  /** Gate-Alias: dieselbe Entscheidung wie summaryFor, explizit benannt. */
  gateFor(modelId: string): MosSummary {
    return this.summaryFor(modelId);
  }

  /** Alle bislang bewerteten Modelle. */
  list(): MosSummary[] {
    const ids = [...new Set(this.ratings.map((r) => r.modelId))].sort();
    return ids.map((id) => this.summaryFor(id));
  }
}

export const mosHarness = new MosHarness();
