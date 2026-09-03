/**
 * dropMONK – Drop Template Generator (Server + Fallback)
 * =====================================================
 * Reine, plattformfreie Logik für `POST /api/ai/generate-drop`:
 *  - Prompt-Bau für den LLM-Router (Keys bleiben serverseitig)
 *  - Validierung/Clamping der LLM-Antwort
 *  - Deterministischer Fallback ohne Netz (gleicher Prompt → gleicher Drop)
 */

import type { CurveType, DropCategory, ParameterTransformation, QuantizationType } from './types/DropProfile';

export type DropStyle = 'subtle' | 'moderate' | 'extreme';

export interface DropGenerationRequest {
  userPrompt: string;
  bpm?: number;
  activePlugins?: string[];
  currentEnergy?: number;
  style?: DropStyle;
  duration?: number; // ms
}

export interface DropGenerationResult {
  name: string;
  description: string;
  category: DropCategory;
  parameterSequence: ParameterTransformation[];
  buildupTime: number;
  dropDuration: number;
  quantization: QuantizationType;
  intensity: number;
  confidence: number;
  tags: string[];
  source: 'llm' | 'local';
}

const CURVES: CurveType[] = ['linear', 'exponential', 'logarithmic', 's-curve', 'stepped'];
const CATEGORIES: DropCategory[] = ['buildup', 'breakdown', 'transition', 'fill', 'custom'];
const QUANTIZATIONS: QuantizationType[] = ['1bar', '2bar', '4bar', '1/2bar', '1/4bar', '1/8bar', 'instant'];

/** Parameter, die dropMONK sicher bedienen kann (Server-Whitelist). */
export const SUPPORTED_DROP_PARAMETERS: ReadonlyArray<{ pluginId: string; parameterId: string }> = [
  { pluginId: 'synthesizer', parameterId: 'cutoff' },
  { pluginId: 'synthesizer', parameterId: 'resonance' },
  { pluginId: 'effect', parameterId: 'mix' },
  { pluginId: 'effect', parameterId: 'size' },
  { pluginId: 'effect', parameterId: 'cutoff' },
  { pluginId: 'effect', parameterId: 'feedback' },
  { pluginId: 'drum', parameterId: 'drive' },
  { pluginId: 'drum', parameterId: 'density' },
  { pluginId: 'drum', parameterId: 'cymbal_level' },
  { pluginId: 'mixer', parameterId: 'bass_gain' },
  { pluginId: 'mixer', parameterId: 'channel_fade' },
];

const clamp01 = (v: unknown, fallback = 0.5): number => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
};

const clampMs = (v: unknown, fallback: number, min = 100, max = 32000): number => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
};

const isSupported = (pluginId: string, parameterId: string): boolean =>
  SUPPORTED_DROP_PARAMETERS.some((p) => p.pluginId === pluginId && p.parameterId === parameterId);

/** Millisekunden für n Takte bei gegebenem Tempo (4/4). */
export const barsToMs = (bars: number, bpm: number): number => (bars * 240000) / Math.max(1, bpm);

/** Style → Intensität. */
export const intensityForStyle = (style: DropStyle = 'moderate'): number =>
  style === 'subtle' ? 0.3 : style === 'extreme' ? 0.95 : 0.65;

const MAX_SEED_INPUT_LENGTH = 2000;

/** Stabiler Seed aus dem Prompt (deterministischer Fallback). */
export function promptSeed(prompt: string): number {
  let hash = 2166136261;
  // Harte Obergrenze: verhindert unbegrenzte Schleifen bei fremd gesteuerten Eingaben.
  const len = Math.min(String(prompt ?? '').length, MAX_SEED_INPUT_LENGTH);
  for (let i = 0; i < len; i++) {
    hash ^= prompt.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash);
}

/**
 * LLM-Prompt für die Drop-Generierung.
 */
export function buildDropPrompt(request: DropGenerationRequest): string {
  const bpm = request.bpm ?? 128;
  const energy = clamp01(request.currentEnergy, 0.5);
  const plugins = (request.activePlugins ?? []).join(', ') || 'synthesizer, effect, drum, mixer';
  const paramList = SUPPORTED_DROP_PARAMETERS.map((p) => `${p.pluginId}:${p.parameterId}`).join(', ');

  return [
    'Du bist der Drop-Designer von audioMONASTRY (dropMONK).',
    'Antworte NUR mit validem JSON (kein Markdown, keine Erklärung).',
    '',
    'Kontext:',
    `- BPM: ${bpm}`,
    `- Energie: ${(energy * 100).toFixed(0)}%`,
    `- Aktive Plugins: ${plugins}`,
    `- Style: ${request.style ?? 'moderate'}`,
    `- User-Prompt: "${request.userPrompt}"`,
    '',
    `Erlaubte Parameter (pluginId:parameterId): ${paramList}`,
    '',
    'JSON-Struktur:',
    '{"name":string,"description":string,"category":"buildup|breakdown|transition|fill|custom",',
    '"parameterSequence":[{"pluginId":string,"parameterId":string,"startValue":0..1,"endValue":0..1,',
    '"duration":ms,"curve":"linear|exponential|logarithmic|s-curve|stepped","delay":ms}],',
    '"buildupTime":ms,"dropDuration":ms,"quantization":"4bar","intensity":0..1,"confidence":0..1}',
    '',
    'Regeln: alle Werte normalisiert (0..1), Dauer in Millisekunden,',
    `der Drop muss in 4 Takte bei ${bpm} BPM passen (${Math.round(barsToMs(4, bpm))} ms).`,
  ].join('\n');
}

/** ```json-Fences entfernen und den JSON-Block extrahieren. */
export function extractJsonBlock(raw: string): string {
  let s = raw.trim();
  if (s.startsWith('```')) {
    s = s.replace(/^```[a-zA-Z]*\s*/, '');
    if (s.endsWith('```')) s = s.slice(0, -3);
    s = s.trim();
  }
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first >= 0 && last > first) return s.slice(first, last + 1);
  return s;
}

/**
 * LLM-Antwort validieren/clampen. Wirft, wenn keine nutzbare Sequenz enthalten ist.
 */
export function sanitizeAiDropResponse(
  raw: string,
  request: DropGenerationRequest
): DropGenerationResult {
  const parsed = JSON.parse(extractJsonBlock(raw)) as Record<string, unknown>;
  const bpm = request.bpm ?? 128;
  const maxDuration = Math.round(barsToMs(4, bpm));

  const sequenceInput = Array.isArray(parsed.parameterSequence) ? parsed.parameterSequence : [];
  const parameterSequence: ParameterTransformation[] = [];

  for (const entry of sequenceInput as Record<string, unknown>[]) {
    const pluginId = String(entry?.pluginId ?? '').trim();
    const parameterId = String(entry?.parameterId ?? '').trim();
    if (!isSupported(pluginId, parameterId)) continue;

    const curve = CURVES.includes(entry?.curve as CurveType) ? (entry.curve as CurveType) : 'linear';

    parameterSequence.push({
      pluginId,
      parameterId,
      startValue: clamp01(entry?.startValue, 0),
      endValue: clamp01(entry?.endValue, 1),
      duration: clampMs(entry?.duration, Math.min(4000, maxDuration), 100, maxDuration),
      curve,
      delay: clampMs(entry?.delay, 0, 0, maxDuration),
    });
  }

  if (parameterSequence.length === 0) {
    throw new Error('AI response contains no supported parameters');
  }

  const category = CATEGORIES.includes(parsed.category as DropCategory)
    ? (parsed.category as DropCategory)
    : 'custom';
  const quantization = QUANTIZATIONS.includes(parsed.quantization as QuantizationType)
    ? (parsed.quantization as QuantizationType)
    : '4bar';

  return {
    name: String(parsed.name ?? `AI ${request.style ?? 'moderate'} Drop`).slice(0, 80),
    description: String(parsed.description ?? request.userPrompt).slice(0, 400),
    category,
    parameterSequence: parameterSequence.slice(0, 8),
    buildupTime: clampMs(parsed.buildupTime, Math.round(barsToMs(2, bpm)), 0, maxDuration * 2),
    dropDuration: clampMs(parsed.dropDuration, request.duration ?? Math.round(barsToMs(1, bpm)), 100, maxDuration * 2),
    quantization,
    intensity: clamp01(parsed.intensity, intensityForStyle(request.style)),
    confidence: clamp01(parsed.confidence, 0.75),
    tags: ['ai-generated', request.style ?? 'moderate'],
    source: 'llm',
  };
}

/**
 * Deterministischer Fallback ohne Netz.
 * Gleicher Prompt + BPM + Style → identischer Drop (cachefreundlich, testbar).
 */
export function generateDeterministicDrop(request: DropGenerationRequest): DropGenerationResult {
  const prompt = request.userPrompt.trim();
  const bpm = request.bpm ?? 128;
  const style: DropStyle = request.style ?? 'moderate';
  const intensity = intensityForStyle(style);
  const seed = promptSeed(`${prompt}|${bpm}|${style}`);

  const lower = prompt.toLowerCase();
  const isBreakdown = /break|ambient|space|calm|ruhig|down/.test(lower);
  const isTransition = /transition|übergang|mix|blend|wechsel/.test(lower);
  const category: DropCategory = isBreakdown ? 'breakdown' : isTransition ? 'transition' : 'buildup';

  const barDuration = Math.round(barsToMs(1, bpm));
  const sweepDuration = Math.round(barsToMs(4, bpm));
  const curve: CurveType = CURVES[seed % CURVES.length];

  const parameterSequence: ParameterTransformation[] = [
    {
      pluginId: 'synthesizer',
      parameterId: 'cutoff',
      startValue: isBreakdown ? 0.7 : 0.2,
      endValue: isBreakdown ? 0.2 : Math.min(1, 0.6 + intensity * 0.4),
      duration: sweepDuration,
      curve: isBreakdown ? 'logarithmic' : 'exponential',
    },
    {
      pluginId: 'effect',
      parameterId: 'mix',
      startValue: 0.1,
      endValue: Math.min(1, 0.3 + intensity * 0.5),
      duration: sweepDuration,
      curve,
    },
    {
      pluginId: 'drum',
      parameterId: isBreakdown ? 'density' : 'drive',
      startValue: isBreakdown ? 0.8 : 0,
      endValue: isBreakdown ? 0.2 : intensity,
      duration: sweepDuration - barDuration,
      curve: 's-curve',
      delay: barDuration,
    },
  ];

  if (isTransition) {
    parameterSequence.push({
      pluginId: 'mixer',
      parameterId: 'channel_fade',
      startValue: 1,
      endValue: 0,
      duration: sweepDuration,
      curve: 'linear',
    });
  }

  const styleLabel = style.charAt(0).toUpperCase() + style.slice(1);
  const categoryLabel = category.charAt(0).toUpperCase() + category.slice(1);

  return {
    name: `${styleLabel} ${categoryLabel} @ ${Math.round(bpm)} BPM`,
    description: `Lokal generierter Drop für "${prompt.slice(0, 120)}"`,
    category,
    parameterSequence,
    buildupTime: sweepDuration,
    dropDuration: request.duration ?? Math.round(barsToMs(2, bpm)),
    quantization: '4bar',
    intensity,
    confidence: 0.45,
    tags: ['ai-generated', style, 'local-fallback'],
    source: 'local',
  };
}
