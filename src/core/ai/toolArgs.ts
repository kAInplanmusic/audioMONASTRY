/**
 * audioMONASTRY · Werkzeug-Argumente vor der Ausfuehrung pruefen
 * =============================================================
 * DA-2026-10-17-018: Die Argumente eines MCP-Werkzeugs kamen aus der Antwort
 * eines LLM (`{steps:[{tool,args}]}` im Agent-Plan bzw. `command(param, …)` im
 * Server-Agenten). Geprueft wurde nur der Werkzeugname gegen den Katalog, nie
 * die Struktur der Argumente. Diese landeten unveraendert im `input` eines
 * RunPod-Jobs (Prompt-Injection -> beliebige Payloads, riesige Strings,
 * unbekannte Schluessel).
 *
 * Regeln hier (bewusst konservativ, fail-closed):
 *   - nur echte Objekte, max. 24 Schluessel, Schluessel ≤ 64 Zeichen
 *   - keine Prototype-Schluessel (`__proto__`, `constructor`, `prototype`)
 *   - je Werkzeug eine Allowlist der Parameter; unbekannte werden VERWORFEN
 *     (nicht durchgereicht) und im Ergebnis gemeldet
 *   - Laengenlimits: Strings 2000 Zeichen (Medien-Base64 ausgenommen),
 *     Arrays 64 Eintraege, Verschachtelung 2 Ebenen, Gesamtgroesse 20 kB
 *
 * Die Pruefung sitzt in `McpRuntime.invoke` - damit ist JEDER Weg abgedeckt
 * (HTTP-Route, Agent-Executor, LLM-Plan).
 */

/** Harte Obergrenzen fuer Werkzeug-Argumente. */
export const TOOL_ARG_LIMITS = {
  maxKeys: 24,
  maxKeyChars: 64,
  maxStringChars: 2000,
  maxMediaChars: 20_000_000,
  maxArrayItems: 64,
  maxDepth: 2,
  maxTotalChars: 20_000,
} as const;

/** Schluessel, deren Wert Medien-Base64 ist (eigenes, hoeheres Limit). */
const MEDIA_KEYS = new Set(['audioBase64', 'imageBase64', 'videoBase64', 'dataUri']);

/** Immer erlaubt: die Rechteangabe wertet `McpRuntime.invoke` selbst aus. */
const PERMISSION_KEY = 'permission';

export interface ToolArgPolicy {
  /** Erlaubte Parameter. Unbekannte werden verworfen. */
  allow: readonly string[];
  /** Pflichtparameter (muessen nach dem Filtern vorhanden sein). */
  required?: readonly string[];
  /**
   * Freie Parameter (z. B. `plugin.command`: die Plugin-Parameter sind je
   * Kommando unterschiedlich). Unbekannte Schluessel bleiben erhalten, aber
   * typesicher und laengenbegrenzt; Pflichtfelder gelten weiter.
   */
  freeForm?: boolean;
}

const GENERATION_ARGS = [
  'model',
  'prompt',
  'text',
  'lyrics',
  'audioBase64',
  'imageBase64',
  'imageUrl',
  'durationSeconds',
  'maxDuration',
  'bpm',
  'key',
  'seed',
  'style',
  'instruct',
  'language',
  'speaker',
  'negativePrompt',
  'steps',
  'width',
  'height',
  'cfg',
  'stream',
] as const;

/** Allowlist je registriertem Werkzeug (Namen siehe mcpRuntime.ts). */
export const TOOL_ARG_POLICIES: Readonly<Record<string, ToolArgPolicy>> = {
  'session.getState': { allow: [] },
  'runtime.status': { allow: [] },
  'fleet.status': { allow: [] },
  'fleet.wake': { allow: [] },
  'models.list': { allow: [] },
  'model.load': { allow: ['model'] },
  'model.unload': { allow: ['model'] },
  'sample.search': { allow: ['query', 'limit'] },
  'audio.classify': { allow: GENERATION_ARGS },
  'audio.transcribe': { allow: GENERATION_ARGS },
  'audio.embed': { allow: GENERATION_ARGS },
  'audio.analyze': { allow: GENERATION_ARGS },
  'audio.diarize': { allow: GENERATION_ARGS },
  'audio.understand': { allow: GENERATION_ARGS },
  'audio.generate': { allow: GENERATION_ARGS },
  'stem.separate': { allow: GENERATION_ARGS },
  'music.generate': { allow: GENERATION_ARGS },
  'music.remix': { allow: GENERATION_ARGS },
  'music.drop': { allow: GENERATION_ARGS },
  'image.generate': { allow: GENERATION_ARGS },
  'image.img2img': { allow: GENERATION_ARGS },
  'image.keyframes': { allow: GENERATION_ARGS },
  'image.upscale': { allow: GENERATION_ARGS },
  'video_real.text2video': { allow: GENERATION_ARGS },
  'video_real.img2video': { allow: GENERATION_ARGS },
  'video_real.loop': { allow: GENERATION_ARGS },
  'video_abstract.text2video': { allow: GENERATION_ARGS },
  'video_abstract.img2video': { allow: GENERATION_ARGS },
  'video_abstract.glitch': { allow: GENERATION_ARGS },
  'agent.orchestrate': { allow: ['request', 'execute', 'maxSteps', 'task', 'prompt'] },
  // `music.lego|extract|complete|repaint` stehen bewusst NICHT hier: sie
  // validieren ihre Argumente bereits selbst per Zod (strikt, mit Wertebereichen
  // und Laengen - musicContextTools.ts). Eine zweite Allowlist davor wuerde
  // unbekannte Schluessel stillschweigend entfernen, statt sie wie bisher als
  // "ungueltige Argumente" abzulehnen.
  'plugin.command': { allow: ['pluginId', 'action', 'parameters'], required: ['pluginId', 'action'], freeForm: true },
};

/**
 * Werkzeuge ohne eigenen Eintrag (aus `PLUGIN_COMMAND_CATALOG` abgeleitete
 * `pluginId.aktion`): Parameter bleiben frei, aber strukturell begrenzt.
 */
const GENERIC_POLICY: ToolArgPolicy = { allow: [] };

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const SAFE_KEY = /^[A-Za-z][A-Za-z0-9_.-]*$/;

export interface ToolArgsOk {
  ok: true;
  args: Record<string, unknown>;
  /** Verworfene Schluessel (nur Namen, keine Werte). */
  dropped: string[];
}

export interface ToolArgsFailure {
  ok: false;
  error: string;
}

export type ToolArgsResult = ToolArgsOk | ToolArgsFailure;

/** Type-Guard (Narrowing an einer Stelle, statt an jedem Aufrufer). */
export function isToolArgsFailure(result: ToolArgsResult): result is ToolArgsFailure {
  return result.ok === false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function sanitizeValue(value: unknown, key: string, depth: number): { keep: boolean; value?: unknown } {
  if (typeof value === 'string') {
    const limit = MEDIA_KEYS.has(key) ? TOOL_ARG_LIMITS.maxMediaChars : TOOL_ARG_LIMITS.maxStringChars;
    return { keep: true, value: value.length > limit ? value.slice(0, limit) : value };
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? { keep: true, value } : { keep: false };
  }
  if (typeof value === 'boolean') return { keep: true, value };
  if (value === null || value === undefined) return { keep: false };
  if (Array.isArray(value)) {
    if (depth >= TOOL_ARG_LIMITS.maxDepth) return { keep: false };
    const out: unknown[] = [];
    for (const entry of value.slice(0, TOOL_ARG_LIMITS.maxArrayItems)) {
      const item = sanitizeValue(entry, key, depth + 1);
      if (item.keep) out.push(item.value);
    }
    return { keep: true, value: out };
  }
  if (isPlainObject(value)) {
    if (depth >= TOOL_ARG_LIMITS.maxDepth) return { keep: false };
    const out: Record<string, unknown> = {};
    let count = 0;
    for (const [childKey, childValue] of Object.entries(value)) {
      if (count >= TOOL_ARG_LIMITS.maxKeys) break;
      if (FORBIDDEN_KEYS.has(childKey) || !SAFE_KEY.test(childKey) || childKey.length > TOOL_ARG_LIMITS.maxKeyChars) continue;
      const child = sanitizeValue(childValue, childKey, depth + 1);
      if (child.keep) {
        out[childKey] = child.value;
        count += 1;
      }
    }
    return { keep: true, value: out };
  }
  // Funktionen, Symbole, BigInt … haben in Tool-Argumenten nichts verloren.
  return { keep: false };
}

/**
 * Prueft und normalisiert die Argumente eines Werkzeugs.
 * Liefert bei Verstoss einen generischen Fehler (kein Echo der Werte).
 */
export function validateToolArgs(tool: string, rawArgs: unknown): ToolArgsResult {
  const name = String(tool ?? '').trim();
  if (!name) return { ok: false, error: 'Werkzeugname fehlt' };
  const args = rawArgs ?? {};
  if (!isPlainObject(args)) return { ok: false, error: 'Argumente muessen ein Objekt sein' };

  const entries = Object.entries(args);
  if (entries.length > TOOL_ARG_LIMITS.maxKeys) {
    return { ok: false, error: `zu viele Argumente (max ${TOOL_ARG_LIMITS.maxKeys})` };
  }

  const policy = TOOL_ARG_POLICIES[name] ?? GENERIC_POLICY;
  const strict = TOOL_ARG_POLICIES[name] !== undefined;
  const allowed = new Set<string>([...policy.allow, PERMISSION_KEY]);
  const out: Record<string, unknown> = {};
  const dropped: string[] = [];

  for (const [key, value] of entries) {
    if (!SAFE_KEY.test(key) || key.length > TOOL_ARG_LIMITS.maxKeyChars || FORBIDDEN_KEYS.has(key)) {
      dropped.push(key.slice(0, 64));
      continue;
    }
    if (strict && !policy.freeForm && !allowed.has(key)) {
      dropped.push(key);
      continue;
    }
    const clean = sanitizeValue(value, key, 0);
    if (!clean.keep) {
      dropped.push(key);
      continue;
    }
    out[key] = clean.value;
  }

  for (const required of policy.required ?? []) {
    if (out[required] === undefined) {
      return { ok: false, error: `Pflichtargument fehlt: ${required}` };
    }
  }

  if (JSON.stringify(out).length > TOOL_ARG_LIMITS.maxTotalChars) {
    return { ok: false, error: 'Argumente zu gross' };
  }
  return { ok: true, args: out, dropped };
}
