/**
 * audioMONASTRY · dropMONK Audio-Drop (DROP-P1-001, AI-P2-006)
 * ============================================================
 * `POST /api/ai/drop-audio`: dropMONK erzeugt einen hoerbaren Drop/Loop mit
 * ACE-Step XL **Turbo** (8 Schritte) auf RP3 music – dieselbe Zuordnung wie das
 * MCP-Werkzeug `music.drop` (Drift-Test tests/aceStepModelRouting.test.ts).
 *
 * Ablauf (rein, alle Abhaengigkeiten injiziert, ohne Netz testbar):
 *   1. Zod-Validierung (Prompt, BPM, Tonart, Takte/Dauer, Seed).
 *   2. Lock-Regel: nur der Halter des Plugins `drop` darf erzeugen. Der Halter
 *      kommt aus dem serverautoritativen Session-Lock; der Aufrufer meldet sich
 *      mit der Kollaborations-UserId (`x-session-id`, dieselbe ID wie im Socket).
 *   3. Cache (AI-P2-006): Schluessel aus Prompt/BPM/Tonart/Dauer/Seed/Modell.
 *      Ein Treffer ruft KEIN Modell und bucht NICHTS im CostTracker.
 *   4. Modellaufruf `song` + `acestep-v15-xl-turbo`, `inferenceSteps: 8`.
 *      Bewusst OHNE `aceTask`: der Worker legt sonst den Kontext-Pfad (LEGO) an.
 *   5. Ergebnis STILL in die Bibliothek (bestehender Upload-Pfad, Server-Ablage
 *      bzw. R2) – nichts landet auf dem Geraet. Antwort traegt Bibliotheks-ID +
 *      URL; dropMONK legt daraus ein Pad an.
 *   6. Fehlerpfade mit klarer Meldung: Pod nicht bereit -> 503 POD_NOT_READY
 *      (retryable, `retryAfterMs`), AI nicht konfiguriert -> 503 AI_NOT_CONFIGURED,
 *      Ablage fehlgeschlagen -> 502 LIBRARY_SAVE_FAILED.
 *
 * Die Rate-Bremse bleibt der `expensiveLimiter` auf `/api/ai` (server.ts).
 * Nichts davon laeuft im Audio-Pfad: der Aufruf ist ein Netz-Auftrag des
 * Servers, das Abspielen passiert spaeter ueber den Drop-Adapter.
 */
import { z } from 'zod';
import type { CostTracker } from '../src/core/ai/orchestrator/costTracker';
import {
  ACE_STEP_TURBO_MODEL,
  extractAudioOutput,
  normalizeKeyscale,
  type MusicLibraryPort,
} from '../src/core/ai/orchestrator/musicContextTools';
import type { AiTask } from '../src/core/ai/orchestrator/types';
import { createDropCache, type DropCache } from './dropCache.ts';

/** dropMONK-Drops laufen auf ACE-Step XL Turbo (RP3 music). */
export const DROP_AUDIO_MODEL = ACE_STEP_TURBO_MODEL;
/** Turbo ist auf 8 Diffusionsschritte destilliert. */
export const DROP_AUDIO_STEPS = 8;
/** ACE-Step nimmt 10..600 s; ein Drop/Loop bleibt kurz. */
export const DROP_AUDIO_MIN_SECONDS = 10;
export const DROP_AUDIO_MAX_SECONDS = 60;
/** Wartezeit, die der Client bei POD_NOT_READY vor dem naechsten Versuch einhaelt. */
export const DROP_AUDIO_RETRY_AFTER_MS = 15_000;

export const DropAudioRequestSchema = z
  .object({
    prompt: z.string().trim().min(1, 'prompt fehlt').max(500),
    bpm: z.number().min(40).max(220).optional(),
    key: z
      .string()
      .max(24)
      .refine((k) => normalizeKeyscale(k) !== null, 'key erwartet z. B. "A minor", "Am", "F#"')
      .optional(),
    bars: z.union([z.literal(4), z.literal(8), z.literal(16)]).optional(),
    durationSeconds: z.number().min(DROP_AUDIO_MIN_SECONDS).max(DROP_AUDIO_MAX_SECONDS).optional(),
    seed: z.number().int().min(0).max(2 ** 32 - 1).optional(),
    name: z.string().trim().min(1).max(120).optional(),
  })
  .strict();
export type DropAudioRequest = z.infer<typeof DropAudioRequestSchema>;

/** Dauer aus Takten (4/4) und BPM, auf ACE-Steps Bereich begrenzt. */
export function dropDurationSeconds(bpm: number, bars = 8, explicit?: number): number {
  const raw = explicit ?? (bars * 4 * 60) / bpm;
  const clamped = Math.min(DROP_AUDIO_MAX_SECONDS, Math.max(DROP_AUDIO_MIN_SECONDS, raw));
  return Number(clamped.toFixed(2));
}

export interface DropAudioCacheInput {
  prompt: string;
  bpm: number;
  keyscale: string | null;
  durationSeconds: number;
  seed: number | null;
  model: string;
}

/** Stabiler Cache-Schluessel (AI-P2-006): Prompt/BPM/Tonart/Dauer/Seed/Modell. */
export function dropAudioCacheKey(input: DropAudioCacheInput, keyVersion = 'audio-v1'): string {
  return JSON.stringify({
    v: keyVersion,
    prompt: input.prompt.trim().replace(/\s+/g, ' ').toLowerCase(),
    bpm: Number(input.bpm.toFixed(2)),
    key: input.keyscale,
    duration: Number(input.durationSeconds.toFixed(2)),
    seed: input.seed,
    model: input.model,
  });
}

function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

/**
 * Prozessweiter Cache der Audio-Drops. Gespeichert wird nur die REFERENZ in
 * der Bibliothek (ID/URL/Metadaten), nicht das Audio selbst – der Speicher
 * waechst also nicht mit der Audiogroesse. TTL/Obergrenze per Env.
 */
export const dropAudioCache: DropCache = createDropCache({
  ttlMs: envInt('AI_DROP_AUDIO_CACHE_TTL_MS', 30 * 60 * 1000),
  maxEntries: envInt('AI_DROP_AUDIO_CACHE_MAX_ENTRIES', 100),
  keyVersion: 'audio-v1',
});

export interface DropAudioDeps {
  runTask: (task: AiTask, model: string, input: unknown) => Promise<unknown>;
  getLibrary: () => MusicLibraryPort | null;
  costs: Pick<CostTracker, 'estimateJobCostUsd' | 'record' | 'summary'>;
  /** Halter eines Plugins laut serverautoritativem Lock (null = frei). */
  lockOwner: (pluginId: string) => string | null;
  getSessionId: () => string;
  cache?: DropCache;
  now?: () => number;
  /** Zaehler fuer Metriken (aiCacheHits/aiCacheMisses). */
  onCache?: (hit: boolean) => void;
}

export interface DropAudioResult {
  status: number;
  body: Record<string, unknown>;
}

const CONFIG_ERROR_CODES = new Set(['POD_NOT_CONFIGURED', 'NO_PROVIDER', 'NO_POD_FOR_ROLE', 'NO_POD_TOKEN', 'NO_KEY']);

function errorCode(error: unknown): { code: string; retryable: boolean; message: string } {
  const e = error as { code?: unknown; retryable?: unknown; message?: unknown };
  return {
    code: typeof e?.code === 'string' ? e.code : 'UNKNOWN',
    retryable: e?.retryable === true,
    message: typeof e?.message === 'string' ? e.message : String(error),
  };
}

/** Prompt mit Tempo/Tonart anreichern (der Turbo-Pfad liest beides aus den Tags). */
function dropPrompt(prompt: string, bpm: number, keyscale: string | null): string {
  return [prompt.trim(), `${Math.round(bpm)} BPM`, keyscale ?? '', 'drop, loopable'].filter(Boolean).join(', ');
}

/**
 * Erzeugt einen Audio-Drop. `requesterId` = Kollaborations-UserId des Aufrufers
 * (Header `x-session-id`); sie muss den Lock auf `drop` halten.
 */
export async function generateDropAudio(rawBody: unknown, requesterId: string, deps: DropAudioDeps): Promise<DropAudioResult> {
  const parsed = DropAudioRequestSchema.safeParse(rawBody ?? {});
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`).join('; ');
    return { status: 400, body: { code: 'INVALID_REQUEST', error: detail } };
  }
  const req = parsed.data;

  // Lock-Regel: nur der Halter von dropMONK.
  const owner = deps.lockOwner('drop');
  if (!owner) {
    return { status: 423, body: { code: 'DROP_NOT_HELD', error: 'dropMONK ist frei – erst holen (OFF → STBY/ON), dann erzeugen.' } };
  }
  if (!requesterId || owner !== requesterId) {
    return { status: 423, body: { code: 'DROP_LOCKED', error: `dropMONK wird von ${owner} gehalten – nur der Halter erzeugt Drops.`, lockedBy: owner } };
  }

  const bpm = req.bpm ?? 128;
  const keyscale = req.key ? normalizeKeyscale(req.key) : null;
  const durationSeconds = dropDurationSeconds(bpm, req.bars ?? 8, req.durationSeconds);
  const seed = req.seed ?? null;
  const cache = deps.cache ?? dropAudioCache;
  const cacheKey = dropAudioCacheKey({ prompt: req.prompt, bpm, keyscale, durationSeconds, seed, model: DROP_AUDIO_MODEL });

  // AI-P2-006: Treffer VOR dem Modellaufruf – kostet nichts, wird nicht gebucht.
  const hit = cache.get<Record<string, unknown>>(cacheKey);
  if (hit) {
    deps.onCache?.(true);
    return { status: 200, body: { ...hit, cached: true, costUsd: 0 } };
  }
  deps.onCache?.(false);

  const library = deps.getLibrary();
  if (!library) {
    return { status: 503, body: { code: 'LIBRARY_UNAVAILABLE', error: 'Bibliothek nicht angebunden – Drop kann nicht abgelegt werden.', retryable: false } };
  }

  const input = {
    prompt: dropPrompt(req.prompt, bpm, keyscale),
    bpm,
    keyscale: keyscale ?? undefined,
    durationSeconds,
    inferenceSteps: DROP_AUDIO_STEPS,
    seed: seed ?? undefined,
  };

  const now = deps.now ?? Date.now;
  const started = now();
  let output: unknown;
  try {
    output = await deps.runTask('song', DROP_AUDIO_MODEL, input);
  } catch (error) {
    const { code, retryable, message } = errorCode(error);
    if (CONFIG_ERROR_CODES.has(code)) {
      return { status: 503, body: { code: 'AI_NOT_CONFIGURED', error: `Musik-Pod (RP3) nicht konfiguriert: ${message}`, retryable: false, cause: code } };
    }
    return {
      status: 503,
      body: {
        code: 'POD_NOT_READY',
        error: `Musik-Pod (RP3) nicht bereit: ${message}`,
        retryable: true,
        retryAfterMs: DROP_AUDIO_RETRY_AFTER_MS,
        cause: code,
        causeRetryable: retryable,
      },
    };
  }

  const audio = extractAudioOutput(output);
  if (!audio) {
    // Ohne GPU-Provider antwortet der lokale Fallback mit Text – das ist kein Drop.
    return {
      status: 503,
      body: { code: 'POD_NOT_READY', error: 'Musik-Pod (RP3) lieferte kein Audio (nicht bereit oder nur lokaler Fallback).', retryable: true, retryAfterMs: DROP_AUDIO_RETRY_AFTER_MS },
    };
  }

  const elapsed = now() - started;
  const sessionId = deps.getSessionId();
  const costUsd = deps.costs.estimateJobCostUsd('song', 'runpod-music', DROP_AUDIO_MODEL);
  // Gebucht wird genau der eine echte Modelllauf (Cache-Treffer oben nie).
  deps.costs.record({
    jobId: `drop-audio-${started.toString(36)}`,
    sessionId,
    provider: 'runpod-music',
    task: 'song',
    model: DROP_AUDIO_MODEL,
    gpuType: deps.costs.summary().gpuType,
    gpuRuntimeMs: elapsed,
    inferenceMs: elapsed,
    estimatedCostUsd: costUsd,
  });

  const name = req.name ?? `AI Drop ${req.prompt.slice(0, 40)}`;
  let saved: { id: string; url?: string };
  try {
    saved = await library.save({
      name,
      audioBase64: audio.audioBase64,
      format: audio.format,
      kind: 'sound',
      tags: ['ai', 'ai-drop', 'drop', 'loop', `model:${DROP_AUDIO_MODEL}`],
      bpm: Math.round(bpm),
      key: keyscale ?? undefined,
    });
  } catch (error) {
    return { status: 502, body: { code: 'LIBRARY_SAVE_FAILED', error: `Drop erzeugt, Ablage fehlgeschlagen: ${(error as Error).message}`, retryable: true, costUsd } };
  }

  const payload: Record<string, unknown> = {
    libraryId: saved.id,
    url: saved.url ?? null,
    name,
    format: audio.format,
    bpm,
    key: keyscale,
    durationSeconds,
    seed,
    model: DROP_AUDIO_MODEL,
    steps: DROP_AUDIO_STEPS,
  };
  cache.set(cacheKey, payload);
  return { status: 200, body: { ...payload, cached: false, costUsd } };
}
