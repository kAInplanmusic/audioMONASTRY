/**
 * audioMONASTRY · AI Orchestrator – Musik-Kontext-Werkzeuge (LEGO-P1-001)
 * ========================================================================
 * Kontext-Layering nach dem KONZEPT von ACE-Step ("LEGO"): eine neue Spur wird
 * erzeugt, waehrend die bereits vorhandenen Spuren als Audio-Kontext mitlaufen
 * (z. B. erst Drums, dann Bass dazu). Die Reihenfolge ist frei waehlbar
 * (Betreiber 2026-10-12) und von der Plugin-Audiokette unabhaengig: hier laeuft
 * nichts im Echtzeit-Pfad, alles ist ein serverseitiger GPU-Auftrag.
 *
 * Herkunft: nur Konzept, kein Code uebernommen (docs/KONZEPT_HERKUNFT.md).
 *
 * Werkzeuge (MCP, Permission EXECUTION, Argumente per Zod validiert):
 *   music.lego      Vorspuren (Bibliotheks-IDs) + Spurtyp + Prompt → neue Spur
 *   music.extract   eine Quelle (Bibliotheks-ID) + Spurtyp → isolierte Spur
 *   music.complete  Vorspuren + fehlende Spurtypen + Prompt → vervollstaendigter Mix
 *   music.repaint   Quelle + Zeitbereich + Modus conservative|balanced|aggressive
 *
 * ACE-Step-1.5-Vertrag (verifiziert 2026-10-12 auf github.com/ace-step/ACE-Step-1.5,
 * docs/en/INFERENCE.md):
 *   - `task_type`: text2music | cover | repaint | lego | extract | complete
 *   - lego/extract/complete laufen NUR auf dem Base-Modell (nicht sft/turbo)
 *   - lego: src_audio + instruction ("Generate the {TRACK} track based on the audio context:") + caption
 *   - extract: src_audio + instruction ("Extract the {TRACK} track from the audio:")
 *   - complete: src_audio + instruction ("Complete the input track with {TRACKS}:") + caption
 *   - repaint: src_audio + repainting_start/repainting_end (-1 = Dateiende) + caption
 *   - Spurnamen: vocals, backing_vocals, drums, bass, guitar, keyboard,
 *     percussion, strings, synth, fx, brass, woodwinds
 *   - Felder: bpm (int), keyscale (z. B. "C Major"/"Am"), duration (10–600 s), seed
 * ACE-Step 1.5 kennt KEINEN Repaint-Modus. conservative|balanced|aggressive ist
 * unsere eigene Abbildung auf `audio_cover_strength` (0..1, "1.0 strong
 * adherence / 0.5 balanced / 0.1 loose"); ob repaint diesen Wert beachtet, ist
 * erst mit einem Live-GPU-Lauf belegt (Ticket PARTIAL).
 *
 * Mehrere Vorspuren: ACE-Step nimmt EIN src_audio. Die Runtime
 * (services/audiomonastry-ai-runtime/handlers_runpod.py) mischt die Kontext-
 * Spuren deshalb zu einer Quelle; die Summe ist kommutativ, die Reihenfolge der
 * IDs aendert das Ergebnis nicht.
 *
 * Grenzen (Server-Kontext-Limit + Kostenbremse):
 *   AI_MUSIC_CONTEXT_MAX_TRACKS       (Default 8)    Vorspuren je Aufruf
 *   AI_MUSIC_CONTEXT_MAX_BYTES        (Default 48 MB) Kontext-Audio gesamt
 *   AI_MUSIC_CONTEXT_MAX_SECONDS      (Default 240)   Ziel-Dauer
 *   AI_MUSIC_CONTEXT_RATE_MAX         (Default 10)    Aufrufe je Fenster und Session
 *   AI_MUSIC_CONTEXT_RATE_WINDOW_MS   (Default 60 000)
 *   AI_MUSIC_CONTEXT_SESSION_BUDGET_USD (Default 1.0) geschaetzte Kosten je Session
 *
 * Jede Ausgabe wird STILL in die Bibliothek gespeichert (bestehender
 * Upload-/Bibliothekspfad des Servers, injiziert ueber `MusicLibraryPort`).
 */
import { z } from 'zod';
import { envNumber } from '../../../config/aiInfrastructure';
import { aiLogger } from './aiLogger';
import type { CostTracker } from './costTracker';
import { fleetMode, isLegoJob } from './podRouting';
import type { AiProviderId, AiTask } from './types';

/** ACE-Step-1.5-Spurnamen (Available Tracks, INFERENCE.md). */
export const MUSIC_TRACK_TYPES = [
  'vocals',
  'backing_vocals',
  'drums',
  'bass',
  'guitar',
  'keyboard',
  'percussion',
  'strings',
  'synth',
  'fx',
  'brass',
  'woodwinds',
] as const;
export type MusicTrackType = (typeof MUSIC_TRACK_TYPES)[number];

/** Unsere Kontext-Tasks → ACE-Step-1.5-`task_type`. */
export const ACE_STEP_TASK_TYPES = {
  lego: 'lego',
  extract: 'extract',
  complete: 'complete',
  repaint: 'repaint',
} as const;
export type MusicContextTask = keyof typeof ACE_STEP_TASK_TYPES;

/** lego/extract/complete laufen laut ACE-Step-Doku nur auf dem Base-Modell. */
export const ACE_STEP_BASE_MODEL = 'acestep-v15-xl-base';
export const ACE_STEP_REPAINT_MODELS = ['acestep-v15-xl-base', 'acestep-v15-xl-sft', 'acestep-v15-xl-turbo'] as const;
/** LM-Planer, den music.repaint bisher als Modell trug – jetzt als Planer-Hinweis. */
export const ACE_STEP_LM_PLANNER = 'acestep-5hz-lm-4b';

export const REPAINT_MODES = ['conservative', 'balanced', 'aggressive'] as const;
export type RepaintMode = (typeof REPAINT_MODES)[number];

/** Eigene Abbildung Modus → audio_cover_strength (Naehe zur Quelle). */
export const REPAINT_MODE_COVER_STRENGTH: Record<RepaintMode, number> = {
  conservative: 0.8,
  balanced: 0.5,
  aggressive: 0.2,
};

export interface MusicContextLimits {
  maxContextTracks: number;
  maxContextBytes: number;
  maxDurationSeconds: number;
  maxPromptChars: number;
  rateMax: number;
  rateWindowMs: number;
  sessionBudgetUsd: number;
}

export function resolveMusicContextLimits(): MusicContextLimits {
  return {
    maxContextTracks: Math.max(1, Math.floor(envNumber('AI_MUSIC_CONTEXT_MAX_TRACKS', 8))),
    maxContextBytes: Math.max(1, envNumber('AI_MUSIC_CONTEXT_MAX_BYTES', 48 * 1024 * 1024)),
    maxDurationSeconds: Math.min(600, Math.max(10, envNumber('AI_MUSIC_CONTEXT_MAX_SECONDS', 240))),
    maxPromptChars: 2000,
    rateMax: Math.max(1, Math.floor(envNumber('AI_MUSIC_CONTEXT_RATE_MAX', 10))),
    rateWindowMs: Math.max(1000, envNumber('AI_MUSIC_CONTEXT_RATE_WINDOW_MS', 60_000)),
    sessionBudgetUsd: Math.max(0, envNumber('AI_MUSIC_CONTEXT_SESSION_BUDGET_USD', 1.0)),
  };
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const LIBRARY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const KEY_PATTERN = /^([A-Ga-g])([#b]?)\s*(major|minor|maj|min|m)?$/i;

const libraryIdSchema = z.string().trim().regex(LIBRARY_ID, 'ungueltige Bibliotheks-ID');
const trackSchema = z.enum(MUSIC_TRACK_TYPES);

/** "c# minor" / "Am" / "F" → ACE-Step-keyscale ("C# Minor" / "A Minor" / "F Major"). */
export function normalizeKeyscale(raw: string): string | null {
  const match = KEY_PATTERN.exec(raw.trim());
  if (!match) return null;
  const note = match[1].toUpperCase() + match[2];
  const quality = (match[3] ?? '').toLowerCase();
  const minor = quality === 'm' || quality === 'min' || quality === 'minor';
  return `${note} ${minor ? 'Minor' : 'Major'}`;
}

function buildSchemas(limits: MusicContextLimits) {
  const prompt = z.string().trim().min(1, 'prompt fehlt').max(limits.maxPromptChars);
  const common = {
    bpm: z.number().int().min(30).max(300).optional(),
    key: z
      .string()
      .refine((k) => normalizeKeyscale(k) !== null, 'key erwartet z. B. "C major", "Am", "F# minor"')
      .optional(),
    durationSeconds: z.number().min(10).max(limits.maxDurationSeconds).optional(),
    seed: z.number().int().min(0).max(2 ** 32 - 1).optional(),
    name: z.string().trim().min(1).max(120).optional(),
  };
  const contextIds = z
    .array(libraryIdSchema)
    .min(1, 'mindestens eine Vorspur (Bibliotheks-ID) noetig')
    .max(limits.maxContextTracks, `hoechstens ${limits.maxContextTracks} Vorspuren`)
    .refine((ids) => new Set(ids).size === ids.length, 'Vorspuren doppelt angegeben');

  return {
    lego: z
      .object({
        contextIds,
        track: trackSchema,
        prompt,
        model: z.literal(ACE_STEP_BASE_MODEL).optional(),
        ...common,
      })
      .strict(),
    extract: z
      .object({
        sourceId: libraryIdSchema,
        track: trackSchema,
        model: z.literal(ACE_STEP_BASE_MODEL).optional(),
        ...common,
      })
      .strict(),
    complete: z
      .object({
        contextIds,
        tracks: z
          .array(trackSchema)
          .min(1)
          .max(MUSIC_TRACK_TYPES.length)
          .refine((t) => new Set(t).size === t.length, 'Spurtypen doppelt angegeben'),
        prompt,
        model: z.literal(ACE_STEP_BASE_MODEL).optional(),
        ...common,
      })
      .strict(),
    repaint: z
      .object({
        sourceId: libraryIdSchema,
        start: z.number().min(0),
        end: z.number(),
        mode: z.enum(REPAINT_MODES).default('balanced'),
        prompt,
        model: z.enum(ACE_STEP_REPAINT_MODELS).optional(),
        ...common,
      })
      .strict()
      .refine((a) => a.end === -1 || a.end > a.start, { message: 'end muss > start sein (oder -1 = Dateiende)', path: ['end'] })
      .refine((a) => a.end === -1 || a.end - a.start <= limits.maxDurationSeconds, {
        message: `Repaint-Bereich hoechstens ${limits.maxDurationSeconds} s`,
        path: ['end'],
      }),
  };
}

export type MusicLegoArgs = z.infer<ReturnType<typeof buildSchemas>['lego']>;
export type MusicExtractArgs = z.infer<ReturnType<typeof buildSchemas>['extract']>;
export type MusicCompleteArgs = z.infer<ReturnType<typeof buildSchemas>['complete']>;
export type MusicRepaintArgs = z.infer<ReturnType<typeof buildSchemas>['repaint']>;
type ParsedArgs = MusicLegoArgs | MusicExtractArgs | MusicCompleteArgs | MusicRepaintArgs;

/** Validiert die Werkzeug-Argumente (ohne `permission`). Wirft mit lesbarer Meldung. */
export function parseMusicContextArgs(task: MusicContextTask, payload: Record<string, unknown>, limits = resolveMusicContextLimits()): ParsedArgs {
  const { permission: _permission, ...args } = payload;
  const result = buildSchemas(limits)[task].safeParse(args);
  if (!result.success) {
    const detail = result.error.issues.map((i) => `${i.path.join('.') || '(args)'}: ${i.message}`).join('; ');
    throw new Error(`music.${task}: ungueltige Argumente – ${detail}`);
  }
  return result.data as ParsedArgs;
}

/** ACE-Step-1.5-`instruction` (Wortlaut aus INFERENCE.md). */
export function aceInstruction(task: MusicContextTask, args: { track?: MusicTrackType; tracks?: readonly MusicTrackType[] }): string | undefined {
  if (task === 'lego') return `Generate the ${args.track} track based on the audio context:`;
  if (task === 'extract') return `Extract the ${args.track} track from the audio:`;
  if (task === 'complete') return `Complete the input track with ${(args.tracks ?? []).join(', ')}:`;
  return undefined;
}

// ---------------------------------------------------------------------------
// Bibliothek + Kostenbremse
// ---------------------------------------------------------------------------

export interface LibraryAudio {
  id: string;
  name: string;
  /** Rohes Base64 (kein data:-Praefix). */
  audioBase64: string;
  bytes: number;
}

export interface LibrarySaveEntry {
  name: string;
  audioBase64: string;
  format: 'wav' | 'mp3' | 'flac' | 'ogg';
  kind: 'stem' | 'sound';
  tags: string[];
  bpm?: number;
  key?: string;
}

/** Server-Bibliothek (Implementierung: server/musicLibraryAdapter.ts). */
export interface MusicLibraryPort {
  resolveAudio(id: string): Promise<LibraryAudio | null>;
  save(entry: LibrarySaveEntry): Promise<{ id: string; url?: string }>;
}

/** Ratenbremse je Session (gleitendes Fenster) + Kostenbudget je Session. */
export class MusicContextGuard {
  private readonly calls = new Map<string, number[]>();

  constructor(private readonly limits: MusicContextLimits, private readonly now: () => number = Date.now) {}

  check(sessionId: string, spentUsd: number, estimateUsd: number): void {
    const t = this.now();
    const recent = (this.calls.get(sessionId) ?? []).filter((ts) => t - ts < this.limits.rateWindowMs);
    if (recent.length >= this.limits.rateMax) {
      this.calls.set(sessionId, recent);
      throw new Error(
        `MUSIC_CONTEXT_RATE_LIMIT: hoechstens ${this.limits.rateMax} Kontext-Auftraege je ${Math.round(this.limits.rateWindowMs / 1000)} s`,
      );
    }
    if (spentUsd + estimateUsd > this.limits.sessionBudgetUsd) {
      throw new Error(
        `MUSIC_CONTEXT_BUDGET: Session-Budget ${this.limits.sessionBudgetUsd.toFixed(2)} USD wuerde ueberschritten ` +
          `(bisher ${spentUsd.toFixed(4)} + ${estimateUsd.toFixed(4)} USD)`,
      );
    }
    recent.push(t);
    this.calls.set(sessionId, recent);
  }
}

export interface MusicContextDeps {
  runTask: (task: AiTask, model: string, input: unknown) => Promise<unknown>;
  getLibrary: () => MusicLibraryPort | null;
  costs: Pick<CostTracker, 'estimateJobCostUsd' | 'costForSession' | 'record' | 'summary'>;
  getSessionId: () => string;
  limits?: MusicContextLimits;
  guard?: MusicContextGuard;
}

export interface MusicContextResult {
  task: MusicContextTask;
  aceTaskType: string;
  model: string;
  contextIds: string[];
  /** ID der still gespeicherten Bibliotheks-Ausgabe (null: nichts gespeichert). */
  libraryId: string | null;
  libraryUrl?: string;
  libraryWarning?: string;
  costUsd: number;
  output: unknown;
}

/** Sucht im Runtime-Ergebnis das erzeugte Audio (Pod-Handler oder normierte Worker-Antwort). */
export function extractAudioOutput(output: unknown): { audioBase64: string; format: LibrarySaveEntry['format'] } | null {
  const visit = (value: unknown, depth: number): { audioBase64: string; format: LibrarySaveEntry['format'] } | null => {
    if (depth > 4 || value === null || value === undefined) return null;
    if (typeof value === 'string') {
      const m = /^data:audio\/([a-z0-9.+-]+);base64,(.+)$/i.exec(value);
      if (m) return { audioBase64: m[2], format: formatFromMime(m[1]) };
      return null;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        const hit = visit(item, depth + 1);
        if (hit) return hit;
      }
      return null;
    }
    if (typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      if (typeof obj.audioBase64 === 'string' && obj.audioBase64) {
        return { audioBase64: obj.audioBase64, format: formatFromMime(String(obj.format ?? 'wav')) };
      }
      for (const key of ['audio', 'output', 'result', 'items', 'files', 'data']) {
        const hit = visit(obj[key], depth + 1);
        if (hit) return hit;
      }
    }
    return null;
  };
  return visit(output, 0);
}

function formatFromMime(sub: string): LibrarySaveEntry['format'] {
  const s = sub.toLowerCase();
  if (s.includes('mp3') || s.includes('mpeg')) return 'mp3';
  if (s.includes('flac')) return 'flac';
  if (s.includes('ogg')) return 'ogg';
  return 'wav';
}

/**
 * Fuehrt ein Kontext-Werkzeug aus: validieren → Bremse → Vorspuren aus der
 * Bibliothek holen → Musik-Rolle (`song`) → Ausgabe still in die Bibliothek.
 */
export async function runMusicContextTool(
  task: MusicContextTask,
  payload: Record<string, unknown>,
  deps: MusicContextDeps,
): Promise<MusicContextResult> {
  const limits = deps.limits ?? resolveMusicContextLimits();
  const args = parseMusicContextArgs(task, payload, limits);

  const library = deps.getLibrary();
  if (!library) throw new Error(`music.${task}: Bibliothek nicht angebunden (Server-Adapter fehlt)`);

  const model = String(args.model ?? ACE_STEP_BASE_MODEL);
  const sessionId = deps.getSessionId();
  const estimateUsd = deps.costs.estimateJobCostUsd('song', 'runpod-music', model);
  const guard = deps.guard ?? new MusicContextGuard(limits);
  guard.check(sessionId, deps.costs.costForSession(sessionId), estimateUsd);

  const ids = 'contextIds' in args ? args.contextIds : [args.sourceId];
  const contextAudio: LibraryAudio[] = [];
  let totalBytes = 0;
  for (const id of ids) {
    const audio = await library.resolveAudio(id);
    if (!audio) throw new Error(`music.${task}: Bibliotheks-ID ${id} nicht gefunden oder ohne Audio`);
    totalBytes += audio.bytes;
    if (totalBytes > limits.maxContextBytes) {
      throw new Error(`music.${task}: Kontext-Audio > ${Math.round(limits.maxContextBytes / 1048576)} MB (Server-Kontext-Limit)`);
    }
    contextAudio.push(audio);
  }

  const track = 'track' in args ? args.track : undefined;
  const tracks = 'tracks' in args ? args.tracks : undefined;
  const keyscale = args.key ? normalizeKeyscale(args.key) ?? undefined : undefined;
  const prompt = 'prompt' in args ? args.prompt : undefined;
  const input: Record<string, unknown> = {
    aceTask: task,
    taskType: ACE_STEP_TASK_TYPES[task],
    instruction: aceInstruction(task, { track, tracks }),
    prompt,
    track,
    tracks,
    bpm: args.bpm,
    keyscale,
    durationSeconds: args.durationSeconds,
    seed: args.seed,
    contextIds: ids,
    contextAudio: contextAudio.map((a) => ({ id: a.id, name: a.name, audioBase64: a.audioBase64 })),
  };
  if (task === 'repaint') {
    const r = args as MusicRepaintArgs;
    input.repaintStart = r.start;
    input.repaintEnd = r.end;
    input.repaintMode = r.mode;
    input.audioCoverStrength = REPAINT_MODE_COVER_STRENGTH[r.mode];
    input.lmModel = ACE_STEP_LM_PLANNER;
  }

  // FLEET-P1-009: LEGO/extract/complete laufen im Pod-Modus auf RP4 voice.
  const provider: AiProviderId = fleetMode() === 'pods' && isLegoJob('song', model, input) ? 'runpod-voice' : 'runpod-music';
  const started = Date.now();
  // Gebucht wird NUR ein abgeschlossener Lauf: wirft runTask (z. B.
  // PREEMPTED_BY_TTS, Unterbrechung zugunsten von TTS), entsteht kein
  // Kosteneintrag – die Wiederholung bucht genau einmal.
  const output = await deps.runTask('song', model, input);
  const elapsed = Date.now() - started;
  deps.costs.record({
    jobId: `mcp-music-${task}-${started.toString(36)}`,
    sessionId,
    provider,
    task: 'song',
    model,
    gpuType: deps.costs.summary().gpuType,
    gpuRuntimeMs: elapsed,
    inferenceMs: elapsed,
    estimatedCostUsd: estimateUsd,
  });

  const result: MusicContextResult = {
    task,
    aceTaskType: ACE_STEP_TASK_TYPES[task],
    model,
    contextIds: ids,
    libraryId: null,
    costUsd: estimateUsd,
    output,
  };

  // Still in die Bibliothek: kein Dialog, Fehler werden geloggt, nicht geworfen –
  // die erzeugte Spur geht dem Aufrufer nicht verloren.
  const audio = extractAudioOutput(output);
  if (!audio) {
    result.libraryWarning = 'Runtime lieferte kein Audio – nichts gespeichert';
    aiLogger.warn('music context: kein Audio im Ergebnis', { model, task: 'song' });
    return result;
  }
  const label = track ?? (tracks ? tracks.join('+') : task);
  try {
    const saved = await library.save({
      name: args.name ?? `AI ${task} ${label}`,
      audioBase64: audio.audioBase64,
      format: audio.format,
      kind: task === 'lego' || task === 'extract' ? 'stem' : 'sound',
      tags: ['ai', `ai-${task}`, ...(track ? [track] : []), ...(tracks ?? []), ...ids.map((id) => `ctx:${id}`)],
      bpm: args.bpm,
      key: keyscale,
    });
    result.libraryId = saved.id;
    result.libraryUrl = saved.url;
    // Bei einer erfolgreichen Ablage reicht die ID; das Audio nicht doppelt zurueckschicken.
    result.output = { savedToLibrary: true, format: audio.format };
  } catch (error) {
    result.libraryWarning = `Bibliotheks-Ablage fehlgeschlagen: ${(error as Error).message}`;
    aiLogger.warn('music context: Bibliotheks-Ablage fehlgeschlagen', { model, error: (error as Error).message });
  }
  return result;
}
