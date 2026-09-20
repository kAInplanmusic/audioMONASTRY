/**
 * audioMONASTRY · AI-Orchestrator – Eval-Bewertung echter Modellantworten
 * ======================================================================
 * INFRA-AI-001: Der Eval-Lauf schrieb bisher `model: 'mock'`, `score: 5` und
 * `exactMatch: true` – expected und actual wurden identisch konstruiert, es lief
 * KEIN Modell. Damit konnte das Gate (Mindest-Score aus `evalMatrix.ts`)
 * per Konstruktion nie fehlschlagen, und die Doku-Matrix zeigte 21× „5.00 PASS".
 *
 * Dieses Modul bewertet dagegen eine ECHTE Antwort:
 *
 *   5.0  Antwort nennt Plugin + das erste Katalog-Kommando (Plan exakt)
 *   4.0  Antwort nennt Plugin + ein anderes gültiges Katalog-Kommando
 *   2.0  Antwort nennt ein falsches Plugin (Kommandowahl nicht bewertbar)
 *   1.0  Antwort ist kein verwertbares JSON oder nennt kein Kommando
 *   0.0  leere/fehlende Antwort
 *
 * Die Bewertung ist deterministisch und ohne Netz testbar; der Aufruf des
 * Modells passiert im Skript (`scripts/eval-ai.ts`).
 */

/** Geparste Plan-Antwort eines Modells. */
export interface PlanAnswer {
  pluginId: string;
  command: string;
}

/** Ergebnis der Bewertung einer Antwort. */
export interface PlanGrade {
  score: number;
  /** true nur bei exakter Plugin+Kommando-Übereinstimmung mit dem ersten Katalog-Eintrag. */
  exactMatch: boolean;
  reason: string;
  answer?: PlanAnswer;
}

/** Schneidet Markdown-Zäune weg (Modelle antworten oft mit ```json … ```). */
function stripCodeFence(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (fenced ? fenced[1] : text).trim();
}

/**
 * Zieht `{pluginId, command}` aus einer Modellantwort.
 * Nimmt das ERSTE JSON-Objekt im Text – Modelle schreiben häufig Prosa drumherum.
 */
export function parsePlanAnswer(answer: unknown): PlanAnswer | null {
  if (typeof answer !== 'string') return null;
  const text = stripCodeFence(answer);
  if (!text) return null;
  const candidates: string[] = [text];
  const objMatch = text.match(/\{[\s\S]*?\}/);
  if (objMatch) candidates.push(objMatch[0]);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      const pluginId = String(parsed.pluginId ?? parsed.plugin ?? parsed.id ?? '').trim();
      const command = String(parsed.command ?? parsed.cmd ?? parsed.action ?? '').trim();
      if (pluginId && command) return { pluginId, command };
    } catch {
      // nächster Kandidat
    }
  }
  return null;
}

function normalizeCommand(raw: string): string {
  // Kommandos im Katalog stehen als "name(args)" – verglichen wird der Name.
  return raw.trim().toLowerCase().split('(')[0].trim();
}

/**
 * Bewertet eine Modellantwort gegen den Kommando-Katalog eines Plugins.
 * `catalog` sind die rohen Katalog-Einträge (z. B. "gain(level), pan(value), status").
 */
export function gradePlanAnswer(pluginId: string, catalog: string | undefined, answer: unknown): PlanGrade {
  const commands = String(catalog ?? '')
    .split(',')
    .map((entry) => normalizeCommand(entry))
    .filter(Boolean);
  const expected = commands[0] ?? 'status';
  const parsed = parsePlanAnswer(answer);
  if (!parsed) {
    return { score: 1, exactMatch: false, reason: 'Antwort ist kein verwertbares JSON mit pluginId + command' };
  }
  const command = normalizeCommand(parsed.command);
  if (parsed.pluginId !== pluginId) {
    return {
      score: 2,
      exactMatch: false,
      reason: `falsches Plugin geplant: ${parsed.pluginId} statt ${pluginId}`,
      answer: parsed,
    };
  }
  if (!commands.includes(command)) {
    return {
      score: 1,
      exactMatch: false,
      reason: `Kommando '${parsed.command}' steht nicht im Katalog von ${pluginId}`,
      answer: parsed,
    };
  }
  if (command === expected) {
    return { score: 5, exactMatch: true, reason: 'Plan exakt', answer: parsed };
  }
  return {
    score: 4,
    exactMatch: false,
    reason: `gültiges, aber nicht erstes Katalog-Kommando ('${parsed.command}' statt '${expected}')`,
    answer: parsed,
  };
}

/** Baut den Planungs-Prompt, den das Skript an das Modell schickt. */
export function buildPlanPrompt(pluginId: string, catalog: string | undefined, task: string): string {
  const commands = String(catalog ?? 'status').trim();
  return [
    `Du planst Kommandos fuer das Plugin '${pluginId}' in audioMONASTRY.`,
    `Aufgabe: ${task}`,
    `Erlaubte Kommandos: ${commands}`,
    'Antworte NUR mit JSON, ohne Erklaerung und ohne Markdown: {"pluginId":"...","command":"..."}',
  ].join('\n');
}

/** Leere Antwort (Modell hat nur Whitespace geliefert). */
export function gradeEmptyAnswer(): PlanGrade {
  return { score: 0, exactMatch: false, reason: 'leere Antwort (kein Modell/kein Output)' };
}
