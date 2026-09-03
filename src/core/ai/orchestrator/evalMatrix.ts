// ============================================================================
// evalMatrix – Eval-Suite je Plugin mit Mindest-Score (P3-3 / GAP-5)
// ----------------------------------------------------------------------------
// Verbindliche Quelle für
//   * die 21 Plugin-IDs (Reihenfolge aus src/plugins/registry.ts),
//   * den Mindest-Score je Plugin (Gate für `npm run eval:ai` und Nightly-CI),
//   * die Eval-Task-Zuordnung.
// Bewusst frei von React-/Browser-Importen, damit Node-Skripte (scripts/*.ts)
// und Vitest dieselbe Matrix nutzen können.
// ============================================================================

/** Verbindliche 21 Plugin-IDs (Reihenfolge aus src/plugins/registry.ts). */
export const EVAL_PLUGIN_IDS = [
  'masterplayer', 'instrument', 'synthesizer', 'drum', 'sampler', 'mcp', 'voice', 'sound',
  'mixer', 'controller', 'effect', 'drop', 'library', 'eq', 'dsp', 'mastering', 'stem',
  'spatial', 'recording', 'performance', 'ai',
] as const;

export type EvalPluginId = (typeof EVAL_PLUGIN_IDS)[number];

export interface PluginEvalSpec {
  /** Eval-Task (Planungs-Case über den Plugin-Kommando-Katalog). */
  task: string;
  /** Mindest-Score 0..5; darunter gilt der Plugin-Run als FAIL (Gate). */
  minScore: number;
  /** Erlaubte Laufzeit je Plugin-Run in ms (Report-Spalte „Dauer"). */
  maxDurationMs: number;
}

/** Default-Gate: 4 von 5 Punkten, 5 s Laufzeit-Budget je Plugin-Run. */
export const DEFAULT_MIN_SCORE = 4;
export const DEFAULT_MAX_DURATION_MS = 5000;

/**
 * Mindest-Scores je Plugin. Audio-kritische Plugins (MAIN-Pfad, Mastering,
 * Mixer, Clock) liegen höher, weil ein Fehlplan dort hörbar wird.
 */
export const PLUGIN_EVAL_MATRIX: Record<string, PluginEvalSpec> = Object.freeze(
  EVAL_PLUGIN_IDS.reduce<Record<string, PluginEvalSpec>>((acc, pluginId) => {
    const critical = ['mixer', 'mastering', 'masterplayer', 'eq', 'dsp'].includes(pluginId);
    acc[pluginId] = {
      task: 'plan',
      minScore: critical ? 4.5 : DEFAULT_MIN_SCORE,
      maxDurationMs: DEFAULT_MAX_DURATION_MS,
    };
    return acc;
  }, {}),
);

export function evalSpecFor(pluginId: string): PluginEvalSpec {
  return PLUGIN_EVAL_MATRIX[pluginId] ?? {
    task: 'plan',
    minScore: DEFAULT_MIN_SCORE,
    maxDurationMs: DEFAULT_MAX_DURATION_MS,
  };
}

export function minScoreFor(pluginId: string): number {
  return evalSpecFor(pluginId).minScore;
}

/** Ein Plugin-Ergebnis im Nightly-Report (Score, Dauer, Fehler). */
export interface PluginEvalResult {
  pluginId: string;
  task: string;
  score: number;
  minScore: number;
  durationMs: number;
  maxDurationMs: number;
  errors: string[];
  status: 'PASS' | 'FAIL';
}

/**
 * Bewertet ein Plugin-Ergebnis gegen die Matrix: Score unter Mindest-Score,
 * Laufzeit über Budget oder gemeldete Fehler ⇒ FAIL (Gate für die Nightly-CI).
 */
export function gradePluginResult(input: {
  pluginId: string;
  score: number;
  durationMs: number;
  errors?: string[];
}): PluginEvalResult {
  const spec = evalSpecFor(input.pluginId);
  const errors = [...(input.errors ?? [])];
  if (input.score < spec.minScore) {
    errors.push(`score ${input.score} < minScore ${spec.minScore}`);
  }
  if (input.durationMs > spec.maxDurationMs) {
    errors.push(`duration ${Math.round(input.durationMs)} ms > budget ${spec.maxDurationMs} ms`);
  }
  return {
    pluginId: input.pluginId,
    task: spec.task,
    score: Number(input.score.toFixed(3)),
    minScore: spec.minScore,
    durationMs: Number(input.durationMs.toFixed(3)),
    maxDurationMs: spec.maxDurationMs,
    errors,
    status: errors.length === 0 ? 'PASS' : 'FAIL',
  };
}

/** Markdown-Report je Plugin: Score, Dauer, Fehler (P3-3-Prüfpunkt). */
export function renderEvalReportMarkdown(results: PluginEvalResult[], meta: { generatedAt: string }): string {
  const rows = results.map((r) =>
    `| ${r.pluginId} | ${r.task} | ${r.score.toFixed(2)} | ${r.minScore.toFixed(2)} | ${r.durationMs.toFixed(1)} | ${r.status === 'PASS' ? '✅ PASS' : '❌ FAIL'} | ${r.errors.length === 0 ? '–' : r.errors.join('; ')} |`,
  );
  const failed = results.filter((r) => r.status === 'FAIL').length;
  return [
    '# AI-Eval-Report (P3-3)',
    '',
    `> Erzeugt: ${meta.generatedAt} · Plugins: ${results.length} · FAIL: ${failed}`,
    '',
    '| Plugin | Task | Score | Min-Score | Dauer (ms) | Status | Fehler |',
    '|---|---|---|---|---|---|---|',
    ...rows,
    '',
  ].join('\n');
}
