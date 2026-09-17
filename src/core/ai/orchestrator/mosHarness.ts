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
 * Das Gate zaehlt **verschiedene Hörer** (`evaluatorId`), nicht Wertungen: eine
 * einzelne Person kann mehrere Hörproben bewerten, darf das Gate aber nicht
 * allein auf "3 Hörer" bringen. Ohne echte Hörerwerte bleibt der Gate-Status
 * ehrlich `pass: false` mit Begründung – es wird kein MOS erfunden.
 *
 * AI-P1-007: `add()` schrieb bisher nur in die DB, es gab keinen Ladepfad -
 * nach einem Server-Neustart war die Bewertungsliste leer (live belegt
 * 2026-09-17: sechs eingetragene Wertungen mussten neu eingegeben werden).
 * `loadPersisted()` holt die `voice.mos`-Zeilen aus `ai_evaluations` zurueck;
 * es ist idempotent (Dedupe ueber Modell/Sprache/Score/Hoerer/Sekunde) und wird
 * beim Serverstart sowie lazy beim ersten GET aufgerufen. Ungueltige oder
 * fremde Zeilen werden gezaehlt uebersprungen, nicht geraten.
 */
import { aiLogger } from './aiLogger';
import { aiPersistence, isAiPersistenceConfigured, type PersistedEvaluation } from './aiPersistence';

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
  /** Anzahl abgegebener Wertungen (ein Hörer kann mehrere Hörproben bewerten). */
  count: number;
  /** Anzahl VERSCHIEDENER Hörer – das ist die Größe, die das Gate prüft. */
  evaluators: number;
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

/** Ergebnis eines Persistenz-Ladevorgangs (AI-P1-007). */
export interface MosHydrateResult {
  /** Neu uebernommene Wertungen. */
  loaded: number;
  /** Uebersprungene Zeilen (Dublette, ungueltig oder fremder Task). */
  skipped: number;
  /** Anzahl Wertungen im Speicher nach dem Ladevorgang. */
  total: number;
  /** War eine Persistenz ueberhaupt konfiguriert? (sonst ist "leer" ehrlich "leer") */
  configured: boolean;
}

/** Liest `language`/`evaluatorId`/`notes` aus dem jsonb-`input` (String ODER Objekt). */
export function parseMosInput(input: unknown): { language?: 'DE' | 'EN'; evaluatorId?: string; notes?: string } {
  let value: unknown = input;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return {};
    }
  }
  if (!value || typeof value !== 'object') return {};
  const v = value as Record<string, unknown>;
  const language = v.language === 'DE' || v.language === 'EN' ? v.language : undefined;
  const evaluatorId = typeof v.evaluatorId === 'string' ? v.evaluatorId : undefined;
  const notes = typeof v.notes === 'string' ? v.notes : undefined;
  return { language, evaluatorId, notes };
}

/**
 * Wandelt eine persistierte `ai_evaluations`-Zeile in eine MOS-Wertung.
 * `null` heisst: Zeile ist fuer das MOS-Gate nicht brauchbar (wird gezaehlt
 * uebersprungen) - es wird nichts erfunden oder gerundet.
 */
export function mosRatingFromEvaluation(row: PersistedEvaluation): MosRating | null {
  const modelId = String(row.model ?? '').trim().slice(0, 64);
  if (!modelId) return null;
  const score = Number(row.score);
  if (!Number.isInteger(score) || score < 1 || score > 5) return null;
  const parsed = parseMosInput(row.input);
  if (!parsed.language || !parsed.evaluatorId) return null;
  const evaluatorId = parsed.evaluatorId.trim().slice(0, 64);
  if (!evaluatorId) return null;
  const createdAt = Date.parse(row.createdAt);
  return {
    modelId,
    language: parsed.language,
    score,
    evaluatorId,
    notes: (parsed.notes ?? '').slice(0, 500),
    createdAt: Number.isFinite(createdAt) ? createdAt : 0,
  };
}

/**
 * Identitaet einer Wertung fuer das Dedupe. Die DB hat keinen Unique-Key, also
 * dient der fachliche Inhalt plus die Sekunde des Zeitstempels als Schluessel -
 * dieselbe Zeile zweimal zu laden bleibt damit folgenlos.
 */
function ratingFingerprint(r: MosRating): string {
  return `${r.modelId}|${r.language}|${r.score}|${r.evaluatorId}|${Math.floor(r.createdAt / 1000)}`;
}

export class MosHarness {
  private readonly ratings: MosRating[] = [];
  /** AI-P1-007: true, sobald erfolgreich aus der Persistenz geladen wurde. */
  private hydrated = false;

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
    // `notes` wandert mit in `input` (jsonb), sonst waere es nach einem Neustart
    // verloren; aeltere Zeilen ohne `notes` bleiben lesbar (AI-P1-007).
    void aiPersistence.saveEvaluation({
      pluginId: 'voice',
      task: 'voice.mos',
      promptVersion: 1,
      model: modelId,
      provider: 'mos-listener',
      input: JSON.stringify({ language: input.language, evaluatorId, notes: rating.notes ?? '' }),
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
    // Das Gate zaehlt HOERER, nicht Wertungen. Sonst koennte eine einzelne
    // Person mit drei Wertungen das Gate als "3 Hoerer" ausweisen - genau die
    // Art erfundener Evidenz, die dieses Modul verhindern soll.
    const evaluators = new Set(all.map((r) => r.evaluatorId)).size;
    const scores = all.map((r) => r.score);
    const avg = count ? scores.reduce((a, b) => a + b, 0) / count : 0;
    const pass = evaluators >= this.requiredCount && avg >= this.minScore;
    const reason = evaluators === 0
      ? `keine Hörerwertungen (benötigt ${this.requiredCount})`
      : evaluators < this.requiredCount
        ? `erst ${evaluators} von ${this.requiredCount} Hörern${count > evaluators ? ` (${count} Wertungen)` : ''}`
        : `MOS ${avg.toFixed(2)} ${avg >= this.minScore ? '>=' : '<'} ${this.minScore}`;
    return {
      modelId,
      count,
      evaluators,
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

  /**
   * AI-P1-007: Persistierte Zeilen in den Speicher uebernehmen.
   *
   * Idempotent und verlustfrei: die DB ist die Wahrheit ueber die ANZAHL je
   * Fingerprint (Modell/Sprache/Score/Hoerer/Sekunde). Der Speicher wird nur
   * AUFGEFUELLT, nie gekuerzt. Damit gilt beides zugleich:
   *   * derselbe Bestand zweimal geladen aendert nichts,
   *   * und eine kurz zuvor per `add()` erzeugte Wertung (die in der DB als
   *     eigene Zeile steht) wird nicht doppelt gezaehlt.
   * Bewusst kein Set-Dedupe: drei gleichartige Wertungen desselben Hoerers in
   * einer Sekunde (in den Echtdaten real vorhanden) sind Daten, keine Dublette -
   * sie zu verschlucken waere genau der Datenverlust, den AI-P1-007 behebt.
   * Das Gate selbst zaehlt ohnehin verschiedene Hoerer (Set), ist also von
   * dieser Feinheit unabhaengig.
   */
  hydrate(rows: PersistedEvaluation[]): MosHydrateResult {
    const inMemory = new Map<string, number>();
    for (const r of this.ratings) {
      const fp = ratingFingerprint(r);
      inMemory.set(fp, (inMemory.get(fp) ?? 0) + 1);
    }

    const parsed: MosRating[] = [];
    let skipped = 0;
    for (const row of [...rows].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))) {
      const rating = mosRatingFromEvaluation(row);
      if (!rating) {
        skipped += 1;
        continue;
      }
      parsed.push(rating);
    }

    const byFingerprint = new Map<string, MosRating[]>();
    for (const rating of parsed) {
      const fp = ratingFingerprint(rating);
      const group = byFingerprint.get(fp);
      if (group) group.push(rating);
      else byFingerprint.set(fp, [rating]);
    }

    let loaded = 0;
    for (const [fp, group] of byFingerprint) {
      const have = inMemory.get(fp) ?? 0;
      const missing = Math.max(0, group.length - have);
      for (let i = 0; i < missing; i += 1) {
        this.ratings.push(group[i]);
        loaded += 1;
      }
      skipped += group.length - missing;
    }
    return { loaded, skipped, total: this.ratings.length, configured: isAiPersistenceConfigured() };
  }

  /**
   * Holt die `voice.mos`-Zeilen aus der Persistenz. Einmal pro Prozess
   * ausreichend (Serverstart), wiederholte Aufrufe sind durch den Merker bzw.
   * das Dedupe folgenlos. Ohne konfigurierte Persistenz bleibt der Speicher
   * leer - das wird als `configured: false` gemeldet statt als "keine Daten".
   */
  async loadPersisted(): Promise<MosHydrateResult> {
    if (this.hydrated) {
      return { loaded: 0, skipped: 0, total: this.ratings.length, configured: true };
    }
    if (!isAiPersistenceConfigured()) {
      aiLogger.warn('mos persistence not configured - ratings stay in memory only', {});
      return { loaded: 0, skipped: 0, total: this.ratings.length, configured: false };
    }
    const rows = await aiPersistence.loadEvaluations({ task: 'voice.mos', pluginId: 'voice' });
    const result = this.hydrate(rows);
    this.hydrated = true;
    if (result.loaded > 0) {
      aiLogger.info('mos ratings restored from persistence', { loaded: result.loaded, skipped: result.skipped, total: result.total });
    }
    return result;
  }

  /** Diagnose: Ist der Ladepfad bereits gelaufen und war eine Persistenz da? */
  persistenceStatus(): { hydrated: boolean; configured: boolean; ratings: number } {
    return { hydrated: this.hydrated, configured: isAiPersistenceConfigured(), ratings: this.ratings.length };
  }
}

export const mosHarness = new MosHarness();
