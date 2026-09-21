// ============================================================================
// promptRoles – Rollen-/Prompt-Katalog je KI-Knoten (P3-1 · P3-2 · GAP-5)
// ----------------------------------------------------------------------------
// Ein Ort, an dem für JEDE verbindliche AI-Rolle steht:
//   * Systemprompt (Vollfassung: Rollensatz + Kommandos + Fehlerregel + Format)
//   * Few-Shots (Beispieleingabe → erwartete Plan-Antwort)
//   * MCP-Tools der Rolle (Namen wie sie `mcpRuntime` wirklich registriert)
//   * Eval-Fälle (Datensatz je Rolle, inkl. Negativ-Fall)
//   * Min-Score (Gate aus `evalMatrix.ts`)
//   * Status (PASS/FAIL/UNCHECKED – ohne Report ehrlich UNCHECKED)
//
// VERBINDLICHE QUELLEN – hier wird NICHTS neu erfunden:
//   * Rollen-IDs (Plugins)   → `EVAL_PLUGIN_IDS` (src/core/ai/orchestrator/evalMatrix.ts)
//   * Rollensatz             → `PLUGIN_MOA_SYSTEM_PROMPTS` (src/utils/prompts.ts)
//   * Kommandos              → `PLUGIN_COMMAND_CATALOG`   (MCP-Name: `${rolle}.${kommando}`)
//   * Aufgaben               → `PLUGIN_MOA_TASKS`
//   * Min-Score              → `PLUGIN_EVAL_MATRIX`
//   * Planer-Rolle           → `MOA_GLOBAL_PROMPT_KEY` (promptStore) + docs/AI_PROMPTS.md §1
//   * GPU-Rollen (Bild/Video) → `GPU_ROLE_IDS` (src/config/aiInfrastructure.ts)
//   * Bild-/Video-Prompt-Bau → `buildVisionPrompt`/`buildMotionPrompt`/`VISION_STYLES`
//
// ABDECKUNG IST EIN VERTRAG: `roleCoverageGaps()` muss leer sein. Die Tests in
// `tests/promptCatalog.test.ts` machen einen fehlenden Eintrag rot.
// ============================================================================

import { EVAL_PLUGIN_IDS, evalSpecFor, type PluginEvalSpec } from './evalMatrix';
import {
  PLUGIN_COMMAND_CATALOG,
  PLUGIN_MOA_SYSTEM_PROMPTS,
  PLUGIN_MOA_TASKS,
} from '../../../utils/prompts';
import { MOA_GLOBAL_PROMPT_KEY } from './promptStore';
import { GPU_ROLE_IDS } from '../../../config/aiInfrastructure';
import { buildMotionPrompt, buildVisionPrompt, VISION_STYLES } from '../vision/visionPrompt';

/**
 * Version der Prompt-Fassung im Katalog.
 *   v1 = reiner Rollensatz (`PLUGIN_MOA_SYSTEM_PROMPTS`, Altbestand)
 *   v2 = Rollensatz + Kommandoliste + Fehlerregel + Antwortformat + Few-Shots
 */
export const ROLE_PROMPT_VERSION = 2;

/** Art der Rolle – steuert, welche Vertragsfelder verpflichtend sind. */
export type RoleKind = 'plugin-monk' | 'system-module' | 'planner' | 'gpu-role';

/** Eval-Status einer Rolle (ohne Bericht ehrlich `UNCHECKED`). */
export type RoleEvalStatus = 'PASS' | 'FAIL' | 'UNCHECKED';

/** Ein Few-Shot-Beispiel der Rolle (Kommando stammt aus dem Kommando-Katalog). */
export interface PromptFewShot {
  /** Nutzeraufgabe (deutsch) – aus `PLUGIN_MOA_TASKS`. */
  task: string;
  /** Erwartete Plan-Antwort; `command` ist ein Katalog-Kommando bzw. ein MCP-Tool der Rolle. */
  answer: { pluginId: string; command: string; prompt: string };
  /** Herkunft/Hinweis (deutsch, fachlich – keine Erfindung). */
  note: string;
}

/** Ein Eval-Fall je Rolle (Datensatz-Eintrag für `eval:ai`). */
export interface RoleEvalCase {
  id: string;
  /** Eval-Task – identisch zur Task-Spalte der Matrix (`plan`). */
  task: string;
  /** Aufgabenstellung für das Modell (der Katalog steht bewusst NICHT drin). */
  input: string;
  /**
   * Was der Fall erwartet:
   *   plan-exakt      = erstes Katalog-Kommando der Rolle (Grader-Score 5) –
   *                     genau dieser Fall läuft gegen das Matrix-Gate.
   *   plan-alternativ = anderes gültiges Katalog-Kommando (Grader-Score 4).
   *   plan-negativ    = Kommando außerhalb des Katalogs (Grader-Score 1).
   *   prompt-bau      = Bild-/Video-Rolle: der Prompt-Bauer muss den Stil liefern.
   */
  expect: 'plan-exakt' | 'plan-alternativ' | 'plan-negativ' | 'prompt-bau';
  /** Erwartetes Kommando aus dem Katalog der Rolle (bzw. MCP-Tool) – leer beim Negativ-Fall. */
  expectedCommand: string;
  /** Score, den die deterministische Bewertung für diesen Fall liefern MUSS. */
  expectedScore: number;
  /** Mindest-Score (Gate) der Rolle aus `evalMatrix.ts` bzw. deren Default. */
  minScore: number;
  /** Stil aus `VISION_STYLES` (nur `prompt-bau`). */
  style?: string;
  /** true = Negativ-Fall: ein Kommando AUSSERHALB des Katalogs taucht auf. */
  negative: boolean;
  /** Nur beim Negativ-Fall: dieses Kommando steht bewusst nicht im Katalog. */
  forbiddenCommand?: string;
}

/** Vollständige Rollenbeschreibung – Vertragsgegenstand der Tests. */
export interface RolePromptSpec {
  roleId: string;
  kind: RoleKind;
  /** v1/v2 – siehe `ROLE_PROMPT_VERSION`. */
  version: number;
  /**
   * Vollständiger Systemprompt der Rolle. Für `kind: 'gpu-role'` ist das der
   * deterministische Prompt-Bauer-Vertrag (Bild/Video laufen ohne LLM-Systemprompt).
   */
  systemPrompt: string;
  /** true = die Rolle bekommt einen echten LLM-Systemprompt (nicht nur einen Bau-Vertrag). */
  llmSystemPrompt: boolean;
  /** Kommandos aus dem Katalog (leer bei Planer/GPU-Rollen). */
  commands: string[];
  fewShots: PromptFewShot[];
  /** MCP-Tool-Namen (`mcpRuntime` muss sie registrieren). */
  mcpTools: string[];
  evalCases: RoleEvalCase[];
  /** Mindest-Score (Gate) der Rolle. */
  minScore: number;
  /** true = Mindest-Score steht in `EVAL_PLUGIN_IDS`/`PLUGIN_EVAL_MATRIX`; false = nur Default/Fallback. */
  minScoreFromMatrix: boolean;
  /** Kommando für „nicht verfügbar" – `status` nur, wenn die Rolle es kennt. */
  fallbackCommand: string | null;
}

// ---------------------------------------------------------------------------
// Ableitungen aus dem bestehenden Katalog
// ---------------------------------------------------------------------------

/** Kommando-Einträge ("gain(db), fade_in_main(seconds)") einer Rolle. */
export function commandsFor(roleId: string): string[] {
  return String(PLUGIN_COMMAND_CATALOG[roleId] ?? '')
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);
}

/** Kommando-NAME ohne Parameter ("gain(db)" → "gain"). */
export function commandNameOf(entry: string): string {
  return entry.split('(')[0].trim();
}

/** Namen der Katalog-Kommandos einer Rolle. */
export function commandNamesFor(roleId: string): string[] {
  return commandsFor(roleId).map(commandNameOf);
}

/** MCP-Tool-Namen der Rolle, wie `mcpRuntime` sie registriert: `${rolle}.${kommando}`. */
export function mcpToolsFor(roleId: string): string[] {
  return commandNamesFor(roleId).map((cmd) => `${roleId}.${cmd}`);
}

/**
 * Kommando für den Fehlerfall. `status` gibt es nur bei 9 der 18 Rollen – die
 * alte Universalregel („wähle 'status'") war für die anderen 9 (mixer,
 * syntisampler, drumsampler, instru, biblio, voice, spatial, eq, dsp) falsch.
 */
export function fallbackCommandFor(roleId: string): string | null {
  const names = commandNamesFor(roleId);
  return names.includes('status') ? 'status' : null;
}

/** Höchstzahl Few-Shots je Rolle (ein Beispiel pro Kommando, gedeckelt). */
export const MAX_FEW_SHOTS_PER_ROLE = 3;

/** Few-Shots werden aus Katalog-Kommandos + bestehender Aufgabe abgeleitet. */
export function fewShotsFor(roleId: string): PromptFewShot[] {
  const task = PLUGIN_MOA_TASKS[roleId] ?? `Optimiere dieses Modul (${roleId})`;
  return commandsFor(roleId)
    .slice(0, MAX_FEW_SHOTS_PER_ROLE)
    .map((entry, index) => {
      const name = commandNameOf(entry);
      return {
        task: index === 0 ? task : `${task} – Kommando ${name}`,
        answer: { pluginId: roleId, command: entry, prompt: `${name} für ${roleId}` },
        note: `Beispiel aus PLUGIN_COMMAND_CATALOG (${roleId}: ${entry})`,
      };
    });
}

/** Negativ-Kommando der Eval-Fälle: bewusst NICHT im Katalog. */
export const NEGATIVE_EVAL_COMMAND = 'nicht_im_katalog';

/**
 * Eval-Datensatz einer Rolle: ein Fall je Katalog-Kommando plus ein Negativ-Fall
 * („erfinde ein Kommando") – der Negativ-Fall hält fest, dass die Bewertung
 * (`evalGrading.gradePlanAnswer`) ein Kommando außerhalb des Katalogs bestraft.
 */
export function evalCasesFor(roleId: string, spec: PluginEvalSpec = evalSpecFor(roleId)): RoleEvalCase[] {
  const cases: RoleEvalCase[] = commandsFor(roleId).map((entry, index) => {
    const name = commandNameOf(entry);
    return {
      id: `${roleId}:${name}`,
      task: spec.task,
      input: `Waehle das Kommando '${name}' fuer die Rolle ${roleId}.`,
      expect: index === 0 ? 'plan-exakt' : 'plan-alternativ',
      expectedCommand: name,
      expectedScore: index === 0 ? 5 : 4,
      minScore: spec.minScore,
      negative: false,
    };
  });
  cases.push({
    id: `${roleId}:negativ`,
    task: spec.task,
    input: `Erfinde ein Kommando fuer die Rolle ${roleId}, das nicht im Katalog steht.`,
    expect: 'plan-negativ',
    expectedCommand: '',
    expectedScore: 1,
    minScore: spec.minScore,
    negative: true,
    forbiddenCommand: NEGATIVE_EVAL_COMMAND,
  });
  return cases;
}

// ---------------------------------------------------------------------------
// Systemprompt-Vollfassung
// ---------------------------------------------------------------------------

/**
 * Baut den vollständigen Rollenprompt (v2): bestehender Rollensatz + Kommandos
 * + Fehlerregel + Antwortformat + Few-Shots. Deutsch mit englischen Keywords
 * (D18) – die englischen Bestandteile sind die Kommando-/JSON-Keywords selbst.
 */
export function composeRoleSystemPrompt(roleId: string): string {
  const roleSentence = PLUGIN_MOA_SYSTEM_PROMPTS[roleId]
    ?? 'Du bist ein audioMONASTRY-Produktions-Agent. Wähle passende Kommandos aus dem Katalog.';
  return `${roleSentence}\n\n${roleCommandBlock(roleId)}`;
}

/**
 * Der operative Block einer Rolle (Kommandos, Fehlerregel, Antwortformat,
 * Few-Shots). Genau dieser Block füllt eine Rolle auf, wenn sie nur den
 * Rollensatz enthält – er wird auch vom Iterations-Loop angehängt.
 */
export function roleCommandBlock(roleId: string): string {
  const catalog = PLUGIN_COMMAND_CATALOG[roleId] ?? 'status';
  const fallback = fallbackCommandFor(roleId);
  const errorRule = fallback
    ? `Fehlerbehandlung: Wenn ein Kommando nicht verfügbar ist, wähle '${fallback}' und melde den Fehler im Feld "prompt".`
    : 'Fehlerbehandlung: Wenn ein Kommando nicht verfügbar ist, melde den Fehler im Feld "prompt", wiederhole das Kommando nicht und nutze kein anderes als die oben erlaubten.';
  const shots = fewShotsFor(roleId)
    .map((shot) => `Eingabe: ${shot.task}\nAntwort: [${JSON.stringify(shot.answer)}]`)
    .join('\n');

  return [
    '## Erlaubte Kommandos (nur diese, Syntax command(parameter))',
    `${roleId}: ${catalog}`,
    '',
    '## Fehlerregel',
    errorRule,
    '',
    '## Antwortformat',
    'Antworte NUR als JSON-Array, ohne Erklärung und ohne Markdown: [{"pluginId":"string","command":"string","prompt":"string"}]',
    ...(shots ? ['', '## Beispiele (Few-Shot)', shots] : []),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Planer-Rolle (globaler MoA/MCP-Planer)
// ---------------------------------------------------------------------------

/**
 * Globaler Planer-Prompt. Bis hierher existierte er NUR in `docs/AI_PROMPTS.md`
 * §1; im Code fiel `moaSystemPromptForPlugin('')` auf einen generischen Satz
 * zurück. Der Wortlaut stammt aus der Doku (kein neuer Text).
 */
export const PLANNER_ROLE_ID = MOA_GLOBAL_PROMPT_KEY;

export const MOA_GLOBAL_SYSTEM_PROMPT = [
  'Du bist der MOA/MCP-Planer von audioMONASTRY. Zerlege die Aufgabe in klare Einzelschritte und antworte NUR als JSON-Array (keine Erklärung, kein Markdown):',
  '[{"pluginId":"string","command":"string","prompt":"string"}]',
  '',
  '## Erlaubte Kommandos (nur diese, Syntax command(parameter))',
  Object.entries(PLUGIN_COMMAND_CATALOG).map(([id, cmds]) => `${id}: ${cmds}`).join('; '),
  '',
  '## Antwortformat',
  'Antworte NUR als JSON-Array, ohne Erklärung und ohne Markdown: [{"pluginId":"string","command":"string","prompt":"string"}]',
].join('\n');

function plannerFewShots(): PromptFewShot[] {
  return EVAL_PLUGIN_IDS.slice(0, 2).map((pluginId, index) => ({
    task: index === 0
      ? `${PLUGIN_MOA_TASKS[pluginId] ?? pluginId} (Rolle ${pluginId})`
      : `${PLUGIN_MOA_TASKS[pluginId] ?? pluginId} – Kommando ${commandNameOf(commandsFor(pluginId)[0] ?? 'status')}`,
    answer: {
      pluginId,
      command: commandsFor(pluginId)[0] ?? 'status',
      prompt: PLUGIN_MOA_TASKS[pluginId] ?? pluginId,
    },
    note: `Rollen-Beispiel aus PLUGIN_COMMAND_CATALOG (${pluginId})`,
  }));
}

// ---------------------------------------------------------------------------
// Bild-/Video-Rollen (GPU-Flotte: imageHq / videoReal / videoAbstract)
// ---------------------------------------------------------------------------

/**
 * Die visuellen GPU-Rollen kennen KEINEN LLM-Systemprompt: Bild und Video
 * entstehen über die deterministischen Prompt-Bauer in
 * `src/core/ai/vision/visionPrompt.ts`. Der „Prompt" der Rolle ist deshalb der
 * Bau-Vertrag (Eingaben, Grenzen, MCP-Tool) – kein erfundener Rollenroman.
 */
export const VISUAL_GPU_ROLE_IDS = ['imageHq', 'videoReal', 'videoAbstract'] as const;
export type VisualGpuRoleId = (typeof VISUAL_GPU_ROLE_IDS)[number];

const VISUAL_ROLE_TOOL_PREFIX: Record<VisualGpuRoleId, string> = {
  imageHq: 'image',
  videoReal: 'video_real',
  videoAbstract: 'video_abstract',
};

/** Bild-/Video-Prompt-Vertrag je visueller GPU-Rolle (hergeleitet, nicht erfunden). */
export function visualRoleContract(roleId: VisualGpuRoleId): string {
  const styles = VISION_STYLES.join(', ');
  const sampleVision = buildVisionPrompt({ text: '<motiv>', style: 'industrial', bpm: 140, energy: 0.8 });
  const sampleMotion = buildMotionPrompt({ text: '<motiv>', style: 'industrial', bpm: 140, energy: 0.8 });
  if (roleId === 'imageHq') {
    return [
      `Rolle '${roleId}' (GPU-Flotte): Einzelbilder aus Text – Prompt-Bauer buildVisionPrompt().`,
      `Eingaben: text, style, bpm, energy, moodTags. Stile (VISION_STYLES): ${styles}.`,
      `Beispiel (140 BPM, energy 0.8, style industrial): ${sampleVision}`,
      'Grenzen: Prompt max. 1200 Zeichen; ohne Eingaben greift der neutrale Ambient-Fallback.',
      `MCP-Tools: ${VISUAL_ROLE_MCP_TOOLS.imageHq.join(', ')}.`,
    ].join('\n');
  }
  return [
    `Rolle '${roleId}' (GPU-Flotte): Clip aus einem fertigen Bild – Prompt-Bauer buildMotionPrompt().`,
    `Eingaben: text (Motivhinweis), style, bpm, energy. Bewegungs-Hinweise kommen aus motionStyleHintFor(style) (Stile: ${styles}).`,
    `Beispiel (140 BPM, energy 0.8, style industrial): ${sampleMotion}`,
    'Grenzen: Prompt max. 500 Zeichen; Motiv/Komposition bleiben unverändert (kein Neuerfinden von Bildinhalten).',
    `MCP-Tools: ${VISUAL_ROLE_MCP_TOOLS[roleId].join(', ')}.`,
  ].join('\n');
}

const VISUAL_ROLE_MCP_TOOLS: Record<VisualGpuRoleId, string[]> = {
  imageHq: ['image.generate', 'image.img2img', 'image.keyframes', 'image.upscale'],
  videoReal: ['video_real.text2video', 'video_real.img2video', 'video_real.loop'],
  videoAbstract: ['video_abstract.text2video', 'video_abstract.img2video', 'video_abstract.glitch'],
};

// ---------------------------------------------------------------------------
// Der Katalog
// ---------------------------------------------------------------------------

const MATRIX_ROLE_IDS: readonly string[] = EVAL_PLUGIN_IDS;

function isMatrixRole(roleId: string): boolean {
  return MATRIX_ROLE_IDS.includes(roleId);
}

function buildPluginRole(roleId: string): RolePromptSpec {
  const spec = evalSpecFor(roleId);
  return {
    roleId,
    kind: ['ai', 'perfor'].includes(roleId) ? 'system-module' : 'plugin-monk',
    version: ROLE_PROMPT_VERSION,
    systemPrompt: composeRoleSystemPrompt(roleId),
    llmSystemPrompt: true,
    commands: commandsFor(roleId),
    fewShots: fewShotsFor(roleId),
    mcpTools: mcpToolsFor(roleId),
    evalCases: evalCasesFor(roleId, spec),
    minScore: spec.minScore,
    minScoreFromMatrix: isMatrixRole(roleId),
    fallbackCommand: fallbackCommandFor(roleId),
  };
}

function buildPlannerRole(): RolePromptSpec {
  const spec = evalSpecFor(PLANNER_ROLE_ID);
  const shots = plannerFewShots();
  return {
    roleId: PLANNER_ROLE_ID,
    kind: 'planner',
    version: ROLE_PROMPT_VERSION,
    systemPrompt: MOA_GLOBAL_SYSTEM_PROMPT,
    llmSystemPrompt: true,
    commands: [],
    fewShots: shots,
    mcpTools: [],
    evalCases: shots.map((shot, index) => ({
      id: `${PLANNER_ROLE_ID}:plan${index + 1}`,
      task: spec.task,
      input: shot.task,
      expect: 'plan-exakt' as const,
      expectedCommand: commandNameOf(shot.answer.command),
      expectedScore: 5,
      minScore: spec.minScore,
      negative: false,
    })),
    minScore: spec.minScore,
    minScoreFromMatrix: false,
    fallbackCommand: null,
  };
}

function buildVisualRole(roleId: VisualGpuRoleId): RolePromptSpec {
  const spec = evalSpecFor(roleId);
  const tools = VISUAL_ROLE_MCP_TOOLS[roleId];
  const prefix = VISUAL_ROLE_TOOL_PREFIX[roleId];
  const shots = VISION_STYLES.slice(0, MAX_FEW_SHOTS_PER_ROLE).map((style) => ({
    task: `Stil ${style}`,
    answer: {
      pluginId: roleId,
      command: `${prefix}.${roleId === 'imageHq' ? 'generate' : 'img2video'}`,
      prompt: roleId === 'imageHq'
        ? buildVisionPrompt({ style, energy: 0.5 })
        : buildMotionPrompt({ style, energy: 0.5 }),
    },
    note: `Stil aus VISION_STYLES (${style}) mit dem jeweiligen Prompt-Bauer`,
  }));
  return {
    roleId,
    kind: 'gpu-role',
    version: ROLE_PROMPT_VERSION,
    systemPrompt: visualRoleContract(roleId),
    llmSystemPrompt: false,
    commands: tools,
    fewShots: shots,
    mcpTools: [...tools],
    evalCases: VISION_STYLES.slice(0, 2).map((style, index) => ({
      id: `${roleId}:${style}`,
      task: spec.task,
      input: `Baue einen ${roleId}-Prompt zum Stil '${style}'.`,
      expect: 'prompt-bau' as const,
      expectedCommand: tools[index === 0 ? 0 : 1],
      expectedScore: 5,
      minScore: spec.minScore,
      style,
      negative: false,
    })),
    minScore: spec.minScore,
    minScoreFromMatrix: false,
    fallbackCommand: null,
  };
}

/**
 * Verbindlicher Rollen-Katalog. Reihenfolge: Plugin-Rollen (evalMatrix) →
 * globaler Planer → visuelle GPU-Rollen (Bild/Video).
 */
export const ROLE_PROMPT_SPECS: Record<string, RolePromptSpec> = Object.freeze({
  ...EVAL_PLUGIN_IDS.reduce<Record<string, RolePromptSpec>>((acc, roleId) => {
    acc[roleId] = buildPluginRole(roleId);
    return acc;
  }, {}),
  [PLANNER_ROLE_ID]: buildPlannerRole(),
  ...VISUAL_GPU_ROLE_IDS.reduce<Record<string, RolePromptSpec>>((acc, roleId) => {
    acc[roleId] = buildVisualRole(roleId);
    return acc;
  }, {}),
});

/** Alle Rollen-IDs des Katalogs in fester Reihenfolge. */
export const ROLE_IDS: readonly string[] = Object.freeze(Object.keys(ROLE_PROMPT_SPECS));

/** Katalog-IDs mit Kommando-Eintrag, aber OHNE Plugin-Rolle in `evalMatrix`. */
export const NON_ROLE_CATALOG_IDS: readonly string[] = Object.freeze(
  Object.keys(PLUGIN_COMMAND_CATALOG).filter((id) => !isMatrixRole(id)),
);

/** GPU-Rollen der Flotte ohne Eintrag in diesem Prompt-Katalog. */
export const GPU_ROLES_WITHOUT_PROMPT_SPEC: readonly string[] = Object.freeze(
  GPU_ROLE_IDS.filter((id) => !ROLE_IDS.includes(id)),
);

// ---------------------------------------------------------------------------
// Abdeckung (Vertrag)
// ---------------------------------------------------------------------------

/** Eine Zeile der Abdeckungs-Tabelle (Zahlen, keine Scores). */
export interface RoleCoverageRow {
  roleId: string;
  kind: RoleKind;
  systemPromptVersion: number | null;
  systemPromptChars: number;
  fewShots: number;
  mcpTools: number;
  evalCases: number;
  minScore: number;
  /** false = kein verbindliches Gate in der Matrix, nur Default-Fallback. */
  minScoreFromMatrix: boolean;
  status: RoleEvalStatus;
}

/**
 * Abdeckungs-Zeilen je Rolle. `reportedStatus` kommt aus einem echten
 * Eval-Report (z. B. `test-results/ai-eval-report.json`); fehlt er, ist der
 * Status ehrlich `UNCHECKED` – es wird kein Score erfunden.
 */
export function roleCoverageRows(
  reportedStatus: Record<string, RoleEvalStatus> = {},
): RoleCoverageRow[] {
  return ROLE_IDS.map((roleId) => {
    const spec = ROLE_PROMPT_SPECS[roleId];
    return {
      roleId,
      kind: spec.kind,
      systemPromptVersion: spec.systemPrompt.trim().length > 0 ? spec.version : null,
      systemPromptChars: spec.systemPrompt.trim().length,
      fewShots: spec.fewShots.length,
      mcpTools: spec.mcpTools.length,
      evalCases: spec.evalCases.length,
      minScore: spec.minScore,
      minScoreFromMatrix: spec.minScoreFromMatrix,
      status: reportedStatus[roleId] ?? 'UNCHECKED',
    };
  });
}

/**
 * Fehlende Vertragsbestandteile je Rolle. Leer = Vertrag erfüllt.
 *   * Plugin-/System-Rollen: Systemprompt, Few-Shots, MCP-Tools (= 1 je Kommando),
 *     Kommando-Katalog, Eval-Fälle, Mindest-Score aus der Matrix.
 *   * Planer: Systemprompt, Few-Shots, Eval-Fälle (kein eigenes MCP-Tool).
 *   * GPU-/Bild-Video-Rollen: Bau-Vertrag, Few-Shots, MCP-Tools, Eval-Fälle;
 *     ein LLM-Systemprompt ist hier ausdrücklich NICHT gefordert.
 */
export function roleCoverageGaps(): string[] {
  const gaps: string[] = [];
  for (const roleId of ROLE_IDS) {
    const spec = ROLE_PROMPT_SPECS[roleId];
    if (spec.systemPrompt.trim().length < 40) gaps.push(`${roleId}: Systemprompt fehlt/zu kurz`);
    if (spec.fewShots.length < 1) gaps.push(`${roleId}: Few-Shots fehlen`);
    if (spec.evalCases.length < 1) gaps.push(`${roleId}: Eval-Datensatz fehlt`);

    if (spec.kind === 'planner') {
      if (spec.evalCases.some((c) => !c.expectedCommand)) gaps.push(`${roleId}: Eval-Fall ohne erwartetes Kommando`);
      continue;
    }

    if (spec.mcpTools.length < 1) gaps.push(`${roleId}: MCP-Tools fehlen`);
    for (const evalCase of spec.evalCases) {
      if (evalCase.minScore !== spec.minScore) gaps.push(`${roleId}: Eval-Fall ${evalCase.id} nutzt nicht den Mindest-Score der Rolle`);
      if (evalCase.expect === 'plan-exakt' && evalCase.expectedScore < evalCase.minScore) {
        gaps.push(`${roleId}: Eval-Fall ${evalCase.id} (plan-exakt) liegt unter dem Gate`);
      }
    }

    if (spec.kind === 'gpu-role') {
      for (const shot of spec.fewShots) {
        if (!spec.mcpTools.includes(shot.answer.command)) {
          gaps.push(`${roleId}: Few-Shot nennt ein MCP-Tool außerhalb der Rolle (${shot.answer.command})`);
        }
      }
      for (const evalCase of spec.evalCases) {
        if (evalCase.expect !== 'prompt-bau') gaps.push(`${roleId}: Eval-Fall ${evalCase.id} ist kein Prompt-Bau-Fall`);
        if (!spec.mcpTools.includes(evalCase.expectedCommand)) {
          gaps.push(`${roleId}: Eval-Fall ${evalCase.id} erwartet ein MCP-Tool außerhalb der Rolle`);
        }
        if (!evalCase.style || !(VISION_STYLES as readonly string[]).includes(evalCase.style)) {
          gaps.push(`${roleId}: Eval-Fall ${evalCase.id} nennt keinen Stil aus VISION_STYLES`);
        }
      }
      continue;
    }

    // Plugin-/System-Rolle
    if (spec.commands.length < 1) gaps.push(`${roleId}: Kommando-Katalog fehlt`);
    if (!spec.minScoreFromMatrix) gaps.push(`${roleId}: Mindest-Score fehlt in evalMatrix`);
    if (spec.mcpTools.length !== spec.commands.length) {
      gaps.push(`${roleId}: MCP-Tools (${spec.mcpTools.length}) ≠ Katalog-Kommandos (${spec.commands.length})`);
    }
    for (const shot of spec.fewShots) {
      if (shot.answer.pluginId !== roleId) gaps.push(`${roleId}: Few-Shot nennt falsche Rolle (${shot.answer.pluginId})`);
      const name = commandNameOf(shot.answer.command);
      if (!commandNamesFor(roleId).includes(name)) {
        gaps.push(`${roleId}: Few-Shot nennt Kommando außerhalb des Katalogs (${shot.answer.command})`);
      }
    }
    for (const evalCase of spec.evalCases) {
      if (evalCase.negative) {
        if (!evalCase.forbiddenCommand) gaps.push(`${roleId}: Negativ-Eval-Fall ohne verbotenes Kommando`);
        else if (commandNamesFor(roleId).includes(evalCase.forbiddenCommand)) {
          gaps.push(`${roleId}: Negativ-Eval-Fall nutzt ein Katalog-Kommando (${evalCase.forbiddenCommand})`);
        }
        continue;
      }
      if (!commandNamesFor(roleId).includes(evalCase.expectedCommand)) {
        gaps.push(`${roleId}: Eval-Fall ${evalCase.id} erwartet ein Kommando außerhalb des Katalogs`);
      }
    }
  }
  return gaps;
}

/** Markdown-Tabelle der Abdeckung (Quelle für docs/PLUGIN_PROMPT_MATRIX.md). */
export function formatCoverageTable(rows: RoleCoverageRow[] = roleCoverageRows()): string {
  const header = '| Rolle (ID) | Art | Systemprompt (Version) | Few-Shots | MCP-Tools | Eval-Fälle | Min-Score | Status |\n|---|---|---|---|---|---|---|---|';
  const lines = rows.map((row) =>
    `| ${row.roleId} | ${row.kind} | v${row.systemPromptVersion} (${row.systemPromptChars} Zeichen) | ${row.fewShots} | ${row.mcpTools} | ${row.evalCases} | ${row.minScore.toFixed(2)}${row.minScoreFromMatrix ? '' : ' *'} | ${row.status} |`,
  );
  return [header, ...lines].join('\n');
}

/** Summenzeile der Abdeckung (für Bericht/Report). */
export function coverageTotals(rows: RoleCoverageRow[] = roleCoverageRows()): {
  rollen: number;
  systemprompts: number;
  fewShots: number;
  mcpTools: number;
  evalCases: number;
  mitMatrixGate: number;
  unchecked: number;
} {
  return {
    rollen: rows.length,
    systemprompts: rows.filter((r) => r.systemPromptVersion !== null).length,
    fewShots: rows.reduce((s, r) => s + r.fewShots, 0),
    mcpTools: rows.reduce((s, r) => s + r.mcpTools, 0),
    evalCases: rows.reduce((s, r) => s + r.evalCases, 0),
    mitMatrixGate: rows.filter((r) => r.minScoreFromMatrix).length,
    unchecked: rows.filter((r) => r.status === 'UNCHECKED').length,
  };
}
