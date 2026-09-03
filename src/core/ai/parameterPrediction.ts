/**
 * audioMONASTRY · AM-E6-4: Selbstlernende Parameter-Vorhersage (heuristisch)
 * =========================================================================
 * Nutzt die MOA/MCP-Historie (`MoaHistory`) und optional Eval-Scores als
 * Datensatz für Automation-Vorschläge. Zunächst bewusst HEURISTISCH (kein ML):
 *   * Frequenz-Ranking der zuletzt gewählten Ergebnisse je Plugin/Task
 *   * Rezenz-Gewichtung mit exponentieller Halbwertszeit (neuere Läufe zählen mehr)
 *   * Konfidenz = Gewichtsanteil des Top-Kandidaten
 *
 * Pure Funktionen (kein IndexedDB/Storage) → serverlos testbar. Die UI kann
 * die Vorschläge z. B. im MoaAssistant als „Nächster Schritt“-Chips anbieten.
 */
import type { MoaHistoryEntry } from './MoaHistory';

export interface AutomationCandidate {
  value: string;
  weight: number;
  count: number;
}

export interface AutomationSuggestion {
  pluginId: string;
  task: string;
  value: string;
  confidence: number; // 0..1
  basedOn: number;     // Anzahl berücksichtigter Historien-Einträge
}

const DEFAULT_RECENCY_HALF_LIFE_MS = 30 * 60 * 1000; // 30 Minuten

/** Rezenz-Gewicht eines Eintrags (exponentieller Zerfall). */
export function recencyWeight(at: number, now: number, halfLifeMs = DEFAULT_RECENCY_HALF_LIFE_MS): number {
  const age = Math.max(0, now - at);
  return Math.exp(-(age * Math.LN2) / halfLifeMs);
}

/**
 * Rangfolge der häufigsten Ergebnisse (letzter `results`-Eintrag) für ein
 * Plugin/Task-Paar, gewichtet nach Rezenz.
 */
export function rankAutomationCandidates(
  entries: readonly MoaHistoryEntry[],
  pluginId: string,
  task: string,
  now = Date.now(),
  halfLifeMs = DEFAULT_RECENCY_HALF_LIFE_MS,
): AutomationCandidate[] {
  const byValue = new Map<string, { weight: number; count: number }>();
  for (const e of entries) {
    if (e.pluginId !== pluginId || e.task !== task) continue;
    const last = e.results?.[e.results.length - 1];
    if (!last) continue;
    const w = recencyWeight(e.at, now, halfLifeMs);
    const cur = byValue.get(last) ?? { weight: 0, count: 0 };
    cur.weight += w;
    cur.count += 1;
    byValue.set(last, cur);
  }
  return [...byValue.entries()]
    .map(([value, s]) => ({ value, weight: s.weight, count: s.count }))
    .sort((a, b) => b.weight - a.weight);
}

/** Bester Vorschlag für ein Plugin/Task-Paar (oder null ohne Historie). */
export function suggestAutomationValue(
  entries: readonly MoaHistoryEntry[],
  pluginId: string,
  task: string,
  now = Date.now(),
): AutomationSuggestion | null {
  const ranked = rankAutomationCandidates(entries, pluginId, task, now);
  if (ranked.length === 0) return null;
  const top = ranked[0];
  const total = ranked.reduce((sum, c) => sum + c.weight, 0);
  return {
    pluginId,
    task,
    value: top.value,
    confidence: total > 0 ? top.weight / total : 0,
    basedOn: ranked.reduce((sum, c) => sum + c.count, 0),
  };
}

/** Bester Vorschlag je Plugin über alle Tasks (für UI-Chips). */
export function suggestNextForPlugin(
  entries: readonly MoaHistoryEntry[],
  pluginId: string,
  now = Date.now(),
): AutomationSuggestion | null {
  const tasks = [...new Set(entries.filter((e) => e.pluginId === pluginId).map((e) => e.task))];
  let best: AutomationSuggestion | null = null;
  for (const task of tasks) {
    const s = suggestAutomationValue(entries, pluginId, task, now);
    if (s && (!best || s.confidence * s.basedOn > best.confidence * best.basedOn)) best = s;
  }
  return best;
}
