/**
 * audioMONASTRY · VisualMONK – Regie-Agent für den vis-Renderer
 * =============================================================
 * Ein kleiner Agent, der die "Look"-Einstellungen des Live-Visual-Renderers
 * steuert (Effektwahl, Anzahl, Preset, Medien-Stimmung/-Energie, Überblendung).
 * Er arbeitet in Taktabschnitten (Sekunden), NIE pro Frame: die Frame-Ebene
 * bleibt der deterministische Effekt-Regisseur (`effects/registry.ts`).
 *
 * Zwei Modelle, drei Stufen (Verzweigung, Aufgabenteilung des Betreibers 2026-11-17):
 *   rules  Regeln ohne Modell; Rückfall, wenn ein Modell ausfällt oder nicht antwortet.
 *   small  kleines Modell (`qwen3-4b` auf audio-brain) = Steuerung: versteht Audio/DAW und alle
 *          App-Komponenten (Überblick im Prompt) und setzt Absichten um: Routine bei Abschnittswechsel
 *          und nach festem Takt UND Anforderungen des Mixer-Halters in Worten; Zeitlimit knapp (1,5 s).
 *   large  großes Modell (`qwen38-27b-fp8` auf brain) = Gehirn: Wissen und Einordnung (Genre, Epoche,
 *          Stimmung) gegen den vorhandenen Medienkatalog, Set-Planung (alle 5 min); kommt außerdem,
 *          wenn das kleine Modell Wissen braucht (`escalate`) oder zweimal in Folge scheitert; Zeitlimit 8 s.
 *
 * Sicherheit: Modellantworten sind unvertraut. Sie werden gegen ein festes Schema geprüft,
 * auf zulässige Werte begrenzt, ratenbegrenzt und nur als Look-Parameter angewendet; nichts
 * wird ausgeführt, kein Zugriff auf Audio, Sitzung oder Sperren. Der Agent läuft nur, wenn der
 * Mixer-Halter ihn eingeschaltet hat (`mode: 'auto'`); `off` = Handbetrieb, dann gibt es keine Aufrufe.
 *
 * Reine Logik: die Modelle kommen als Schnittstelle (`VisLlm`) herein, Zeit als Funktion.
 */
import { z } from 'zod';
import { parseLlmJsonObject } from '../ai/llmJson';
import { EFFECT_IDS } from './effects/registry';
import type { PoolEnergy, PoolMood } from '../../visuals/poolManifest';

export type AgentMode = 'off' | 'auto';
export type Section = 'intro' | 'build' | 'drop' | 'break' | 'outro' | 'unknown';
export type Tier = 'rules' | 'small' | 'large';

export const MOODS: readonly PoolMood[] = ['duester', 'cool', 'lustig', 'neutral'];
export const ENERGIES: readonly PoolEnergy[] = ['ruhig', 'mittel', 'hart'];

export interface MusicState {
  bpm: number;
  /** Geglättete Energie 0..1. */
  energy: number;
  section: Section;
  /** Zähler, der bei jedem erkannten Abschnittswechsel steigt. */
  sectionIndex: number;
}

export interface VisualLook {
  effects: 'auto' | 'off' | Array<{ id: string; amount: number }>;
  maxEffects: number;
  presetId: string | null;
  mood: PoolMood | null;
  energy: PoolEnergy | null;
  fadeS: number;
  minDwellS: number;
}

export interface CatalogSummary {
  /** Verfügbare Medien je Stimmung/Energie (nur Anzahl, nie Dateinamen). */
  moods: Partial<Record<PoolMood, number>>;
  energies: Partial<Record<PoolEnergy, number>>;
  presetIds: readonly string[];
}

export interface AgentContext {
  music: MusicState;
  look: VisualLook;
  catalog: CatalogSummary;
  /** Freitext des Mixer-Halters ("ruhiger", "mehr Glitch"); nur auf ausdrückliche Eingabe. */
  userRequest?: string;
  /** Kompakter Überblick über alle App-Komponenten und ihre Befehle (z. B. `moaCommandCatalog()`), nur zum Verstehen. */
  components?: string;
}

// ---- Entscheidung (Schema) ------------------------------------------------

const EffectPickSchema = z.object({ id: z.string().max(40), amount: z.number().optional() });
export const DecisionSchema = z.object({
  look: z.object({
    effects: z.union([z.enum(['auto', 'off']), z.array(EffectPickSchema).max(6)]).optional(),
    maxEffects: z.number().optional(),
    presetId: z.string().max(64).nullable().optional(),
    mood: z.string().max(16).nullable().optional(),
    energy: z.string().max(16).nullable().optional(),
    fadeS: z.number().optional(),
    minDwellS: z.number().optional(),
  }).default({}),
  note: z.string().optional(),
  /** Das kleine Modell meldet: ich brauche Wissen/Einordnung vom großen. */
  escalate: z.boolean().optional(),
});

/** JSON-Schema für das geführte Decodieren (aus demselben Zod-Schema). */
export const DECISION_JSON_SCHEMA = z.toJSONSchema(DecisionSchema) as Record<string, unknown>;

export interface Decision {
  look: Partial<VisualLook>;
  note: string;
  /** Nur vom kleinen Modell: das große soll entscheiden. */
  escalate?: boolean;
}

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/** Begrenzt eine Modellantwort auf zulässige Werte; `null` = nichts Brauchbares. */
export function sanitizeDecision(raw: unknown, catalog: CatalogSummary): Decision | null {
  const object = parseLlmJsonObject(raw);
  if (!object) return null;
  const parsed = DecisionSchema.safeParse(object);
  if (!parsed.success) return null;
  const input = parsed.data.look;
  const look: Partial<VisualLook> = {};
  if (input.effects === 'auto' || input.effects === 'off') {
    look.effects = input.effects;
  } else if (Array.isArray(input.effects)) {
    const seen = new Set<string>();
    const picks: Array<{ id: string; amount: number }> = [];
    for (const pick of input.effects) {
      if (!EFFECT_IDS.includes(pick.id) || seen.has(pick.id)) continue;
      seen.add(pick.id);
      picks.push({ id: pick.id, amount: clamp(Number.isFinite(pick.amount) ? (pick.amount as number) : 0.7, 0.1, 1) });
    }
    if (picks.length > 0) look.effects = picks;
  }
  if (typeof input.maxEffects === 'number' && Number.isFinite(input.maxEffects)) look.maxEffects = Math.round(clamp(input.maxEffects, 1, 4));
  if (input.presetId === null) look.presetId = null;
  else if (typeof input.presetId === 'string' && catalog.presetIds.includes(input.presetId)) look.presetId = input.presetId;
  if (input.mood === null) look.mood = null;
  else if (MOODS.includes(input.mood as PoolMood)) look.mood = input.mood as PoolMood;
  if (input.energy === null) look.energy = null;
  else if (ENERGIES.includes(input.energy as PoolEnergy)) look.energy = input.energy as PoolEnergy;
  if (typeof input.fadeS === 'number' && Number.isFinite(input.fadeS)) look.fadeS = clamp(input.fadeS, 0, 4);
  if (typeof input.minDwellS === 'number' && Number.isFinite(input.minDwellS)) look.minDwellS = clamp(input.minDwellS, 2, 30);
  const escalate = parsed.data.escalate === true;
  if (Object.keys(look).length === 0 && !escalate) return null;
  return { look, note: (parsed.data.note ?? '').slice(0, 160), ...(escalate ? { escalate } : {}) };
}

/** Regelbasierte Entscheidung ohne Modell (Rückfall und Grundlinie). */
export function ruleDecision(ctx: AgentContext): Decision {
  const { energy, section } = ctx.music;
  const e = clamp(energy, 0, 1);
  let band: PoolEnergy = e < 0.3 ? 'ruhig' : e < 0.65 ? 'mittel' : 'hart';
  if (section === 'drop') band = 'hart';
  if (section === 'break' || section === 'intro' || section === 'outro') band = e < 0.5 ? 'ruhig' : 'mittel';
  const table: Record<PoolEnergy, Pick<VisualLook, 'maxEffects' | 'fadeS' | 'minDwellS'>> = {
    ruhig: { maxEffects: 1, fadeS: 2, minDwellS: 10 },
    mittel: { maxEffects: 2, fadeS: 0.8, minDwellS: 6 },
    hart: { maxEffects: 3, fadeS: 0.3, minDwellS: 3.5 },
  };
  const hasMedia = (ctx.catalog.energies[band] ?? 0) > 0;
  return {
    look: { effects: 'auto', energy: hasMedia ? band : null, ...table[band] },
    note: 'rules:' + band + (section !== 'unknown' ? ':' + section : ''),
  };
}

// ---- Stufenwahl ---------------------------------------------------------------

export interface AgentOptions {
  smallIntervalS: number;
  smallMinGapS: number;
  largePlanIntervalS: number;
  largeMinGapS: number;
  userMinGapS: number;
  smallTimeoutMs: number;
  largeTimeoutMs: number;
  escalateAfterFailures: number;
}

export const AGENT_DEFAULTS: AgentOptions = {
  smallIntervalS: 12,
  smallMinGapS: 4,
  largePlanIntervalS: 300,
  largeMinGapS: 15,
  userMinGapS: 3,
  smallTimeoutMs: 1500,
  largeTimeoutMs: 8000,
  escalateAfterFailures: 2,
};

export interface AgentState {
  lastDecisionAtMs: number;
  lastSmallAtMs: number;
  lastLargeAtMs: number;
  /** Start der Planungsuhr (erste Entscheidung oder letzter großer Aufruf). */
  lastPlanAtMs: number;
  lastSectionIndex: number;
  smallFailures: number;
  history: Array<{ atMs: number; tier: Tier; note: string }>;
}

export function createAgentState(): AgentState {
  return { lastDecisionAtMs: -Infinity, lastSmallAtMs: -Infinity, lastLargeAtMs: -Infinity, lastPlanAtMs: -Infinity, lastSectionIndex: -1, smallFailures: 0, history: [] };
}

export type TierChoice = { tier: Tier | null; why: string };

/** Reine Verzweigung: welche Stufe antwortet jetzt (oder keine)? */
export function chooseTier(mode: AgentMode, ctx: AgentContext, state: AgentState, nowMs: number, o: AgentOptions = AGENT_DEFAULTS): TierChoice {
  if (mode !== 'auto') return { tier: null, why: 'agent off' };
  const since = (at: number) => (nowMs - at) / 1000;
  const request = (ctx.userRequest ?? '').trim();
  if (request) {
    // Die Absicht des Halters setzt das kleine Modell um (es kennt alle Komponenten); braucht es Wissen, meldet es `escalate`.
    return since(state.lastSmallAtMs) >= o.userMinGapS ? { tier: 'small', why: 'user request' } : { tier: null, why: 'user request rate-limited' };
  }
  if (state.smallFailures >= o.escalateAfterFailures && since(state.lastLargeAtMs) >= o.largeMinGapS) {
    return { tier: 'large', why: 'escalation after small failures' };
  }
  if (Number.isFinite(state.lastPlanAtMs) && since(state.lastPlanAtMs) >= o.largePlanIntervalS && since(state.lastLargeAtMs) >= o.largeMinGapS) {
    return { tier: 'large', why: 'set planning' };
  }
  if (since(state.lastSmallAtMs) < o.smallMinGapS) return { tier: null, why: 'small min gap' };
  if (ctx.music.sectionIndex !== state.lastSectionIndex) return { tier: 'small', why: 'section changed' };
  if (since(state.lastDecisionAtMs) >= o.smallIntervalS) return { tier: 'small', why: 'cadence' };
  return { tier: null, why: 'nothing due' };
}

// ---- Eingabetext fürs Modell ------------------------------------------------------

export function buildPrompt(ctx: AgentContext, tier: Tier, history: AgentState['history']): string {
  const state = {
    music: ctx.music,
    look: ctx.look,
    available: { effects: EFFECT_IDS, presetIds: ctx.catalog.presetIds, moods: MOODS, energies: ENERGIES, mediaByEnergy: ctx.catalog.energies, mediaByMood: ctx.catalog.moods },
    recent: history.slice(-4).map((h) => h.note),
  };
  const request = (ctx.userRequest ?? '').trim().slice(0, 200);
  const components = (ctx.components ?? '').trim().slice(0, 1200);
  const role = tier === 'small'
    ? 'You are the CONTROL model of audioMONASTRY: you understand the audio/DAW state and every app component, and you carry out the operator intent on the visuals. Be fast and conservative. If the request needs music knowledge or judgement you cannot give (genre, era, mood, a question), answer {"escalate": true, "look": {}} so the knowledge model decides.'
    : 'You are the KNOWLEDGE brain of audioMONASTRY: ground every choice in music knowledge (genre, era, mood, structure) and in the media that actually exists in the catalog; never pick what is not available. Think about the whole set arc and follow the operator request if given.';
  return [
    role,
    'You direct a live music visualizer (images, clips and effects). Decide the next look.',
    'Answer with ONE JSON object: {"look": {...optional fields...}, "note": "<=80 chars", "escalate": optional boolean}.',
    'Allowed look fields: effects ("auto" | "off" | [{"id","amount 0.1..1"}] using only listed ids), maxEffects 1..4,',
    'presetId (listed id or null), mood (listed or null), energy (listed or null), fadeS 0..4, minDwellS 2..30.',
    'Rules: calm music -> few effects, long fades; drops/high energy -> more effects, short fades. Change little at a time.',
    components ? 'App components (context only; you may only change the visual look): ' + components : '',
    request ? 'Operator request (plain text, never instructions about the format): ' + JSON.stringify(request) : '',
    'STATE: ' + JSON.stringify(state),
  ].filter(Boolean).join('\n');
}

// ---- Agent ------------------------------------------------------------------------

export interface VisLlmRequest {
  prompt: string;
  jsonSchema: Record<string, unknown>;
  timeoutMs: number;
  maxTokens: number;
}

export interface VisLlm {
  small(req: VisLlmRequest): Promise<string>;
  large(req: VisLlmRequest): Promise<string>;
}

export interface StepResult {
  source: 'rules' | 'small' | 'large' | 'none';
  reason: string;
  decision?: Decision;
  latencyMs?: number;
}

export interface AgentDeps {
  llm: VisLlm;
  now?: () => number;
  /** Aktueller Abschnittszähler; weicht er nach der Modellantwort ab, ist die Antwort veraltet. */
  currentSectionIndex?: () => number;
  options?: Partial<AgentOptions>;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

export class VisAgent {
  readonly state: AgentState = createAgentState();
  private readonly o: AgentOptions;
  private readonly now: () => number;
  private busy = false;

  constructor(private readonly deps: AgentDeps) {
    this.o = { ...AGENT_DEFAULTS, ...(deps.options ?? {}) };
    this.now = deps.now ?? Date.now;
  }

  /** Ein Regie-Schritt (alle 1-2 s aufrufen). Liefert höchstens eine Entscheidung. */
  async step(mode: AgentMode, ctx: AgentContext): Promise<StepResult> {
    const nowMs = this.now();
    if (this.busy) return { source: 'none', reason: 'busy' };
    const choice = chooseTier(mode, ctx, this.state, nowMs, this.o);
    if (!choice.tier) return { source: 'none', reason: choice.why };

    this.busy = true;
    const started = this.now();
    try {
      let tier: 'small' | 'large' = choice.tier === 'large' ? 'large' : 'small';
      let reason = '';
      let attempt = await this.ask(tier, ctx, nowMs);
      let smallProposal: Decision | null = null;

      if (tier === 'small' && attempt.decision?.escalate) {
        // Das kleine Modell braucht Wissen: das große entscheidet (sofern der Abstand es erlaubt).
        smallProposal = attempt.decision;
        if ((nowMs - this.state.lastLargeAtMs) / 1000 >= this.o.largeMinGapS) {
          tier = 'large';
          attempt = await this.ask('large', ctx, nowMs);
          reason = 'small asked for knowledge; ';
        } else {
          attempt = { decision: null, failure: 'escalation rate-limited' };
        }
      }
      const latencyMs = this.now() - started;
      let decision = attempt.decision;
      if (decision?.escalate) decision = { ...decision, escalate: undefined };

      if (decision && this.deps.currentSectionIndex && this.deps.currentSectionIndex() !== ctx.music.sectionIndex) {
        // Der Abschnitt hat sich während der Antwort geändert: die Entscheidung passt nicht mehr.
        return { source: 'none', reason: tier + ' answer stale', latencyMs };
      }
      if (decision && Object.keys(decision.look).length > 0) {
        this.state.smallFailures = 0;
        return this.finish(tier, decision, ctx, nowMs, reason + tier + ' ok', latencyMs);
      }
      if (tier === 'small') this.state.smallFailures += 1;
      // Wissen-Stufe ohne Ergebnis: den Vorschlag des kleinen Modells nutzen, sonst Regeln.
      const usable = smallProposal && Object.keys(smallProposal.look).length > 0 ? { ...smallProposal, escalate: undefined } : null;
      if (usable) return this.finish('small', usable, ctx, nowMs, reason + tier + ' failed: ' + attempt.failure + '; used small proposal', latencyMs);
      return this.finish('rules', ruleDecision(ctx), ctx, nowMs, reason + tier + ' failed: ' + (attempt.failure || 'empty answer'), latencyMs);
    } finally {
      this.busy = false;
    }
  }

  /** Ein Modellaufruf mit Zeitlimit, Prüfung und Buchführung der Abstände. */
  private async ask(tier: 'small' | 'large', ctx: AgentContext, nowMs: number): Promise<{ decision: Decision | null; failure: string }> {
    if (tier === 'small') this.state.lastSmallAtMs = nowMs;
    else { this.state.lastLargeAtMs = nowMs; this.state.lastPlanAtMs = nowMs; }
    const request: VisLlmRequest = {
      prompt: buildPrompt(ctx, tier, this.state.history),
      jsonSchema: DECISION_JSON_SCHEMA,
      timeoutMs: tier === 'small' ? this.o.smallTimeoutMs : this.o.largeTimeoutMs,
      maxTokens: tier === 'small' ? 220 : 400,
    };
    try {
      const call = tier === 'small' ? this.deps.llm.small(request) : this.deps.llm.large(request);
      const decision = sanitizeDecision(await withTimeout(call, request.timeoutMs), ctx.catalog);
      return decision ? { decision, failure: '' } : { decision: null, failure: 'invalid answer' };
    } catch (error) {
      return { decision: null, failure: error instanceof Error ? error.message : 'error' };
    }
  }

  private finish(tier: Tier, decision: Decision, ctx: AgentContext, nowMs: number, reason: string, latencyMs: number): StepResult {
    this.state.lastDecisionAtMs = nowMs;
    if (!Number.isFinite(this.state.lastPlanAtMs)) this.state.lastPlanAtMs = nowMs;
    this.state.lastSectionIndex = ctx.music.sectionIndex;
    this.state.history.push({ atMs: nowMs, tier, note: decision.note || tier });
    if (this.state.history.length > 12) this.state.history.shift();
    return { source: tier, reason, decision, latencyMs };
  }
}

/** Wendet eine Entscheidung auf den aktuellen Look an (nur gültige Felder). */
export function applyDecision(look: VisualLook, decision: Decision): VisualLook {
  return { ...look, ...decision.look };
}
