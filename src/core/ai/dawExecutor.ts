/**
 * audioMONASTRY · DAW-Executor (RT-AUDIT-P1-015, Schritt 6)
 * ==========================================================
 * Das kleine Executor-Modell (Default `qwen3-4b`, Komplexität `simple`) übersetzt
 * eine Nutzeranweisung in Plugin-Kommandos. Es darf dabei NUR Kommandos liefern,
 * die im kanonischen Katalog stehen (`PLUGIN_COMMAND_CATALOG`, src/utils/prompts.ts).
 *
 * Zwei Schichten sorgen dafür:
 *
 *  1. **Guided Decoding** – der Aufruf trägt das JSON-Schema der Plugin-Kommandos
 *     (`pluginCommandJsonSchema()`). Der vLLM-Brain-Endpoint erzwingt es per
 *     `guided_json` (siehe LlmRouter, `jsonSchema`). Ohne vLLM (nativer Worker,
 *     DeepSeek) ist das ein Hinweis, keine Garantie.
 *  2. **Validierung + Reparatur/Reject** – `validateExecutorOutput()` prüft JEDE
 *     Antwort gegen den Katalog. Erlaubt sind nur mechanische, eindeutige
 *     Reparaturen (Code-Zaun weg, Groß-/Kleinschreibung, `play()` → `play`,
 *     Zahl in den dokumentierten Bereich klemmen). Alles andere (unbekanntes
 *     Plugin/Kommando, fehlender Pflichtparameter, Nicht-Zahl für einen Zahlen-
 *     parameter) wird VERWORFEN – es wird nie ungültiges JSON durchgereicht und
 *     nie ein Parameter erfunden.
 *
 * Der Executor fragt höchstens einmal nach (Korrektur-Prompt mit den Fehlern);
 * ist auch die zweite Antwort ohne gültiges Kommando, lehnt er ab
 * (`ok: false`, `commands: []`).
 *
 * Browser-sicher: kein `process`, kein Netz auf Modulebene. Kein Audio-Pfad –
 * das Modul läuft nur in der Planungsstrecke, nie in `process()`.
 */
import type { LlmCompletion, LlmRequest } from './LlmRouter';
import { PLUGIN_COMMAND_CATALOG } from '../../utils/prompts';

/** Ein schema-gültiges Plugin-Kommando. */
export interface ExecutorCommand {
  pluginId: string;
  /** Kanonische Form: `name` oder `name(arg1, arg2)`. */
  command: string;
}

/** Ergebnis der Validierung einer Modellantwort. */
export interface ExecutorValidation {
  /** Mindestens ein gültiges Kommando, KEIN verworfenes. */
  ok: boolean;
  commands: ExecutorCommand[];
  /** Gründe für verworfene Einträge (leer bei ok). */
  errors: string[];
  /** Mechanische Reparaturen, die angewendet wurden. */
  repairs: string[];
  /** Kanonisches JSON (`{"commands":[…]}`) – immer parsebar und schema-gültig. */
  json: string;
}

/** Spezifikation eines Katalog-Kommandos (aus dem Katalog abgeleitet). */
export interface CatalogCommandSpec {
  name: string;
  params: string[];
}

/** Numerische Parameter mit dokumentierten Grenzen (Prompts/Registry). */
export const NUMERIC_PARAM_RANGES: Readonly<Record<string, { min: number; max: number; integer?: boolean }>> = {
  bpm: { min: 60, max: 250 },
  db: { min: -48, max: 12 },
  seconds: { min: 1, max: 120 },
  freq: { min: 20, max: 20_000 },
  channel: { min: 1, max: 10, integer: true },
  program: { min: 0, max: 127, integer: true },
};

/** Höchstzahl Kommandos je Antwort (wie MoaAgent-Plan: kurz und ausführbar). */
export const MAX_EXECUTOR_COMMANDS = 8;
const MAX_TEXT_ARG = 200;

/** Zerlegt `gain(db), fade_in_main(seconds), channel(channel)` in Specs. */
export function parseCatalogEntry(entry: string): CatalogCommandSpec[] {
  const specs: CatalogCommandSpec[] = [];
  // Index-basiert (keine Regex mit Backtracking): Kommas in Klammern gehören zum Kommando.
  let depth = 0;
  let current = '';
  const flush = () => {
    const raw = current.trim();
    current = '';
    if (!raw) return;
    const open = raw.indexOf('(');
    if (open === -1) {
      specs.push({ name: raw.toLowerCase(), params: [] });
      return;
    }
    const name = raw.slice(0, open).trim().toLowerCase();
    const inner = raw.slice(open + 1, raw.lastIndexOf(')')).trim();
    specs.push({ name, params: inner ? inner.split(',').map((p) => p.trim()).filter(Boolean) : [] });
  };
  for (const ch of String(entry ?? '')) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) { flush(); continue; }
    current += ch;
  }
  flush();
  return specs;
}

/** Katalog als Map `pluginId → Kommando-Specs` (einmal berechnet). */
let catalogCache: Map<string, Map<string, CatalogCommandSpec>> | null = null;
export function executorCatalog(): Map<string, Map<string, CatalogCommandSpec>> {
  if (catalogCache) return catalogCache;
  const map = new Map<string, Map<string, CatalogCommandSpec>>();
  for (const [pluginId, entry] of Object.entries(PLUGIN_COMMAND_CATALOG)) {
    const commands = new Map<string, CatalogCommandSpec>();
    for (const spec of parseCatalogEntry(entry)) commands.set(spec.name, spec);
    map.set(pluginId, commands);
  }
  catalogCache = map;
  return map;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * JSON-Schema der Executor-Antwort für vLLM Guided Decoding (`guided_json`).
 * Je Plugin ein Zweig: `pluginId` fest, `command` per Regex auf die Katalog-
 * Kommandos (mit genau so vielen Argumenten, wie der Katalog nennt) begrenzt.
 */
export function pluginCommandJsonSchema(): Record<string, unknown> {
  const branches = [...executorCatalog().entries()].map(([pluginId, commands]) => {
    const alternatives = [...commands.values()].map((spec) => {
      if (spec.params.length === 0) return escapeRegex(spec.name);
      const arg = `[^(),]{1,${MAX_TEXT_ARG}}`;
      const args = spec.params.map(() => arg).join(', ?');
      return `${escapeRegex(spec.name)}\\(${args}\\)`;
    });
    return {
      type: 'object',
      properties: {
        pluginId: { type: 'string', const: pluginId },
        command: { type: 'string', pattern: `^(${alternatives.join('|')})$` },
      },
      required: ['pluginId', 'command'],
      additionalProperties: false,
    };
  });
  return {
    type: 'object',
    properties: {
      commands: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_EXECUTOR_COMMANDS,
        items: { anyOf: branches },
      },
    },
    required: ['commands'],
    additionalProperties: false,
  };
}

/** Schneidet Markdown-Zäune und Prosa weg; liefert Kandidaten zum Parsen. */
function jsonCandidates(raw: string): string[] {
  let text = String(raw ?? '').trim();
  // Qwen3-Denkblock (falls Thinking doch an war) entfernen.
  const thinkEnd = text.lastIndexOf('</think>');
  if (thinkEnd >= 0) text = text.slice(thinkEnd + '</think>'.length).trim();
  const fenceStart = text.indexOf('```');
  if (fenceStart >= 0) {
    const afterFence = text.indexOf('\n', fenceStart);
    const fenceEnd = text.indexOf('```', fenceStart + 3);
    if (afterFence >= 0 && fenceEnd > afterFence) text = text.slice(afterFence + 1, fenceEnd).trim();
  }
  const candidates = [text];
  const objStart = text.indexOf('{');
  const objEnd = text.lastIndexOf('}');
  if (objStart >= 0 && objEnd > objStart) candidates.push(text.slice(objStart, objEnd + 1));
  const arrStart = text.indexOf('[');
  const arrEnd = text.lastIndexOf(']');
  if (arrStart >= 0 && arrEnd > arrStart) candidates.push(text.slice(arrStart, arrEnd + 1));
  return candidates;
}

function parseLoose(raw: string): unknown {
  for (const candidate of jsonCandidates(raw)) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // nächster Kandidat
    }
  }
  return undefined;
}

/** Holt die Kommandoliste aus den üblichen Antwortformen. */
function extractItems(parsed: unknown): unknown[] | null {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') {
    const record = parsed as Record<string, unknown>;
    for (const key of ['commands', 'steps', 'plan']) {
      if (Array.isArray(record[key])) return record[key] as unknown[];
    }
    if ('pluginId' in record || 'plugin' in record) return [record];
  }
  return null;
}

function stripQuotes(value: string): string {
  let out = value;
  if (out.startsWith('"') || out.startsWith("'")) out = out.slice(1);
  if (out.endsWith('"') || out.endsWith("'")) out = out.slice(0, -1);
  return out.trim();
}

/** Zerlegt `gain(-6, x)` → name + Argumente; null bei kaputter Klammerung. */
function splitCommand(raw: string): { name: string; args: string[]; hadParens: boolean } | null {
  const text = raw.trim();
  const open = text.indexOf('(');
  if (open === -1) {
    if (text.includes(')')) return null;
    return { name: text.toLowerCase(), args: [], hadParens: false };
  }
  if (!text.endsWith(')') || text.indexOf('(', open + 1) !== -1) return null;
  const name = text.slice(0, open).trim().toLowerCase();
  const inner = text.slice(open + 1, -1).trim();
  const args = inner.length === 0 ? [] : inner.split(',').map((a) => stripQuotes(a.trim()));
  return { name, args, hadParens: true };
}

type ArgResult = { value: string; error?: undefined } | { value?: undefined; error: string };

function normalizeArg(param: string, value: string, repairs: string[], label: string): ArgResult {
  const range = NUMERIC_PARAM_RANGES[param];
  if (!value) return { error: `${label}: Parameter '${param}' ist leer` };
  if (!range) {
    if (value.length > MAX_TEXT_ARG) return { error: `${label}: Parameter '${param}' länger als ${MAX_TEXT_ARG} Zeichen` };
    return { value };
  }
  // Eindeutige Einheiten-/Präfixreste abräumen ("128bpm", "-6 dB", "channel3").
  const stripped = value.toLowerCase().replace(/^channel/, '').replace(/\s*(bpm|db|s|sec|seconds|hz)$/, '').trim();
  const num = Number(stripped);
  if (stripped === '' || !Number.isFinite(num)) {
    return { error: `${label}: Parameter '${param}' muss eine Zahl sein (war '${value}')` };
  }
  let fixed = range.integer ? Math.round(num) : num;
  fixed = Math.min(range.max, Math.max(range.min, fixed));
  const out = String(fixed);
  if (out !== value) repairs.push(`${label}: ${param} '${value}' → ${out}`);
  return { value: out };
}

function canonicalJson(commands: ExecutorCommand[]): string {
  return JSON.stringify({ commands });
}

/**
 * Prüft eine rohe Modellantwort gegen den Katalog. Ergebnis ist IMMER
 * schema-gültig: entweder gültige Kommandos oder eine leere Liste mit Gründen.
 */
export function validateExecutorOutput(raw: unknown): ExecutorValidation {
  const errors: string[] = [];
  const repairs: string[] = [];
  const commands: ExecutorCommand[] = [];
  const reject = (reason: string): ExecutorValidation => ({
    ok: false, commands: [], errors: [reason], repairs, json: canonicalJson([]),
  });

  if (typeof raw !== 'string' || raw.trim() === '') return reject('leere Antwort');
  const parsed = parseLoose(raw);
  if (parsed === undefined) return reject('Antwort ist kein JSON');
  const items = extractItems(parsed);
  if (!items) return reject('JSON ohne Kommandoliste ({"commands":[…]})');
  if (items.length === 0) return reject('Kommandoliste ist leer');
  if (items.length > MAX_EXECUTOR_COMMANDS) {
    repairs.push(`Liste auf ${MAX_EXECUTOR_COMMANDS} Kommandos gekürzt (war ${items.length})`);
  }

  const catalog = executorCatalog();
  items.slice(0, MAX_EXECUTOR_COMMANDS).forEach((item, index) => {
    const label = `#${index + 1}`;
    if (!item || typeof item !== 'object') { errors.push(`${label}: kein Objekt`); return; }
    const record = item as Record<string, unknown>;
    const rawPlugin = String(record.pluginId ?? record.plugin ?? '').trim();
    const pluginId = rawPlugin.toLowerCase();
    if (pluginId !== rawPlugin && rawPlugin) repairs.push(`${label}: pluginId '${rawPlugin}' → '${pluginId}'`);
    const pluginCommands = catalog.get(pluginId);
    if (!pluginCommands) { errors.push(`${label}: unbekanntes Plugin '${rawPlugin || '(leer)'}'`); return; }
    const rawCommand = String(record.command ?? record.action ?? record.cmd ?? '').trim();
    const split = splitCommand(rawCommand);
    if (!split || !split.name) { errors.push(`${label}: Kommando '${rawCommand}' nicht lesbar`); return; }
    const spec = pluginCommands.get(split.name);
    if (!spec) { errors.push(`${label}: '${split.name}' steht nicht im Katalog von ${pluginId}`); return; }

    // Argumente aus einem separaten Objekt (`args`/`params`) übernehmen, wenn
    // das Modell sie dort statt in der Klammer geliefert hat.
    let args = split.args;
    if (args.length === 0 && spec.params.length > 0) {
      const bag = (record.args ?? record.params ?? record.parameters) as unknown;
      if (Array.isArray(bag)) args = bag.map((v) => String(v).trim());
      else if (bag && typeof bag === 'object') {
        args = spec.params.map((p) => String((bag as Record<string, unknown>)[p] ?? '').trim());
      }
      if (args.length > 0) repairs.push(`${label}: Argumente aus separatem Feld übernommen`);
    }

    if (spec.params.length === 0) {
      if (args.length > 0) { errors.push(`${label}: ${pluginId}.${spec.name} nimmt keine Parameter`); return; }
      if (split.hadParens) repairs.push(`${label}: '${rawCommand}' → '${spec.name}'`);
      commands.push({ pluginId, command: spec.name });
      return;
    }
    // Ein einzelner Text-Parameter (speak(text), search(query) …) darf Kommas
    // enthalten; die Klammer-Zerlegung hat ihn dann zerteilt → wieder verbinden.
    if (spec.params.length === 1 && args.length > 1 && !NUMERIC_PARAM_RANGES[spec.params[0]]) {
      args = [args.join(' ')];
      repairs.push(`${label}: Kommas im Text-Parameter '${spec.params[0]}' entfernt`);
    }
    if (args.length !== spec.params.length) {
      errors.push(`${label}: ${pluginId}.${spec.name} braucht ${spec.params.length} Parameter (${spec.params.join(', ')}), hat ${args.length}`);
      return;
    }
    const normalized: string[] = [];
    for (let i = 0; i < spec.params.length; i += 1) {
      const result = normalizeArg(spec.params[i], args[i], repairs, label);
      if (result.error !== undefined) { errors.push(result.error); return; }
      if (/[(),]/.test(result.value)) { errors.push(`${label}: Parameter '${spec.params[i]}' enthält Klammer/Komma`); return; }
      normalized.push(result.value);
    }
    commands.push({ pluginId, command: `${spec.name}(${normalized.join(', ')})` });
  });

  const ok = commands.length > 0 && errors.length === 0;
  return { ok, commands, errors, repairs, json: canonicalJson(commands) };
}

/** Executor-Prompt: Aufgabe + Katalog + Ausgabeformat. */
export function buildExecutorPrompt(task: string, correction?: string[]): string {
  const catalog = Object.entries(PLUGIN_COMMAND_CATALOG).map(([id, cmds]) => `${id}: ${cmds}`).join('\n');
  const lines = [
    'Du bist der DAW-Executor von audioMONASTRY. Übersetze die Aufgabe in Plugin-Kommandos.',
    'Erlaubt sind NUR diese Plugins und Kommandos (Syntax command(parameter)):',
    catalog,
    `Zahlenbereiche: ${Object.entries(NUMERIC_PARAM_RANGES).map(([p, r]) => `${p} ${r.min}..${r.max}`).join(', ')}.`,
    'Antworte NUR mit JSON, ohne Markdown: {"commands":[{"pluginId":"…","command":"…"}]}',
  ];
  if (correction && correction.length > 0) {
    lines.push(`Deine letzte Antwort war ungültig: ${correction.slice(0, 5).join('; ')}. Korrigiere sie.`);
  }
  lines.push(`Aufgabe: ${task}`);
  return lines.join('\n');
}

/** Ergebnis eines Executor-Laufs. */
export interface ExecutorResult extends ExecutorValidation {
  /** Anzahl Modellaufrufe (1 oder 2). */
  attempts: number;
  provider?: string;
  model?: string;
  /** Rohantwort des letzten Versuchs (Diagnose; NIE ausgeführt). */
  raw: string;
}

type ExecutorCompleteFn = (req: LlmRequest) => Promise<LlmCompletion>;

/**
 * Der DAW-Executor. `complete` ist injizierbar (Tests: deterministisches
 * Mock-Modell; Server: `llmRouter.complete`).
 */
export class DawExecutor {
  constructor(
    private readonly complete: ExecutorCompleteFn,
    private readonly options: { maxAttempts?: number; timeoutMs?: number } = {},
  ) {}

  async run(task: string): Promise<ExecutorResult> {
    const clean = String(task ?? '').trim();
    if (!clean) {
      return { ...validateExecutorOutput(''), attempts: 0, raw: '' };
    }
    const maxAttempts = Math.max(1, Math.min(3, this.options.maxAttempts ?? 2));
    const schema = pluginCommandJsonSchema();
    let last: ExecutorResult = { ...validateExecutorOutput(''), attempts: 0, raw: '' };
    let correction: string[] | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let completion: LlmCompletion;
      try {
        completion = await this.complete({
          prompt: buildExecutorPrompt(clean, correction),
          // `simple` → Executor-Modell (qwen3-4b) im LlmRouter.
          complexity: 'simple',
          maxTokens: 256,
          temperature: 0,
          reasoningEffort: 'low',
          jsonSchema: schema,
          ...(this.options.timeoutMs ? { timeoutMs: this.options.timeoutMs } : {}),
        });
      } catch (error) {
        const reason = `Modellaufruf fehlgeschlagen: ${(error as Error).message}`;
        return { ok: false, commands: [], errors: [reason], repairs: [], json: canonicalJson([]), attempts: attempt, raw: '' };
      }
      const validation = validateExecutorOutput(completion.text);
      last = { ...validation, attempts: attempt, provider: completion.provider, model: completion.model, raw: completion.text };
      if (validation.ok) return last;
      correction = validation.errors;
    }
    // Reject: teilweise gültige Listen werden NICHT ausgeführt (kein halber Plan).
    return { ...last, ok: false, commands: [], json: canonicalJson([]) };
  }
}
