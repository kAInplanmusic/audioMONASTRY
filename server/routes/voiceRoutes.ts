/**
 * audioMONASTRY · Voice-Routen (ARCH-P2-002, Extraktion aus server.ts)
 * ====================================================================
 * Die Familie teilt sich die AceStep-/DiffRhythm-/Voice-Runtime-Helfer,
 * deshalb liegen /api/voice, /api/sound und /api/song in EINEM Modul:
 *   POST /api/voice/tts | /api/voice/sing | /api/voice/song
 *   POST /api/sound/generate | /api/song/generate
 *
 * Bewusst als Factory ohne Dependency-Objekt: alle 19 Helfer und alle Schemas
 * werden ausschliesslich hier gebraucht und sind mitgewandert (Nachweis:
 * scripts/route-dependency-graph.py --plan /api/voice,/api/sound,/api/song).
 * Geteilt ist nur `app` - das ist der Factory-Parameter.
 *
 * Der Code wurde 1:1 verschoben; die Einrueckung ist die einzige Aenderung.
 */
import {
  SoundGenerateSchema,
  VoiceSingSchema,
  VoiceSongSchema,
  VoiceTtsSchema,
} from '../../shared/schemas.ts';
import type { Response } from 'express';
import { normalizeForSpeech } from '../../src/core/audio/speechNormalization';
import type { Express } from 'express';
import { aiOrchestrator } from '../../src/core/ai/orchestrator/aiOrchestrator';
import type { AiTask } from '../../src/core/ai/orchestrator/types';
import { audioHostAllowlist, fetchOutboundBuffer, OutboundUrlError } from '../../src/core/ai/outboundUrl';
import { resolveRuntimeToken } from '../../src/core/ai/outboundSecrets';
import { UpstreamError, sendUpstreamFailure } from '../../src/core/ai/upstreamErrors';

// ===========================================================================
// VoiceMONK / soundMONK / songMONK: serverseitige Proxy-Endpunkte
// ---------------------------------------------------------------------------
// Der Browser ruft ausschließlich /api/voice/*, /api/sound/*, /api/song/* auf.
// RT-AUDIT-P1-014 (Betreiber-Vorgabe 2026-10-07, AI nur lokal): Es gibt KEINE
// Cloud-Fallbacks mehr (gehostete HF-Inference, HF-Inference-Endpoints und
// Replicate sind entfernt). Erzeugt wird ausschließlich über eigene Backends:
//   VOICE_AI_RUNTIME_URL   eigene audiomonastry-ai-runtime (Runpod-Pod/Hetzner)
//   SONG_AI_ACE_STEP_URL   eigener ACE-Step-Wrapper (optional)
//   SONG_AI_DIFF_RHYTHM_URL eigener DiffRhythm-Wrapper (optional)
// Ist nichts konfiguriert, antworten die Routen mit 503 und einem Hinweis.
//
// RT-AUDIT-P1-014-F2: Erster Weg ist die eigene FLOTTEN-ROLLE (nicht mehr die
// feste URL). endpointRegistry.ts gibt die Zuordnung vor:
//   voiceGen -> tts, audio.generate, stem.separate
//   music    -> sing, song
// Die Rolle ist der bessere Weg, weil sie mit der Session skaliert, Preload und
// Warmup kennt und im CostTracker mitgezaehlt wird. Die feste Runtime-URL bleibt
// der dokumentierte Rueckfall - beide Wege sind eigene Backends, kein Cloud-Pfad.
// ===========================================================================

/**
 * DA-2026-10-17-013: Modell-Override des Clients - jetzt WIRKLICH benutzt.
 *
 * Entscheidung: durchreichen (statt Validierung zu entfernen). Begruendung:
 * `VoiceMonkService` und `SongGenerator` senden `model` bereits, und ein Feld
 * zu pruefen und danach zu verwerfen ist die schlechtere Loesung - der Client
 * bekaeme stillschweigend ein anderes Modell als angefordert. Die Pruefung ist
 * eine feste Allowlist (kein Regex, kein freies Routing): nur Modelle, die auf
 * der Runtime bzw. im Rollen-Manifest tatsaechlich laufen. Zusaetzliche Modelle
 * per `VOICE_AI_MODEL_ALLOWLIST` (Komma).
 */
type VoiceModelTask = 'tts' | 'sing' | 'song';

const RUNTIME_MODEL_ENV: Record<VoiceModelTask, string> = {
  tts: 'VOICE_AI_RUNTIME_TTS_MODEL',
  sing: 'VOICE_AI_RUNTIME_SING_MODEL',
  song: 'VOICE_AI_RUNTIME_SONG_MODEL',
};

const RUNTIME_MODEL_DEFAULT: Record<VoiceModelTask, string> = {
  tts: 'qwen3-tts-06b',
  sing: 'bark',
  song: 'musicgen-small',
};

/** Serverseitige Allowlist je Task (Runtime-Modelle + Rollen-Manifest-Modelle). */
const RUNTIME_MODEL_ALLOWLIST: Record<VoiceModelTask, readonly string[]> = {
  tts: ['qwen3-tts-06b', 'qwen3-tts-17b'],
  sing: ['bark', 'bark-small'],
  song: ['musicgen-small', 'musicgen-medium', 'acestep-v15-xl-sft', 'acestep-v15-xl-turbo'],
};

function envTrim(name: string): string {
  return String(process.env[name] ?? '').trim();
}

/** Default-Modell eines Tasks (Env gewinnt gegen die Konstante). */
function runtimeModelDefault(task: VoiceModelTask): string {
  return envTrim(RUNTIME_MODEL_ENV[task]) || RUNTIME_MODEL_DEFAULT[task];
}

/** Alle fuer einen Task erlaubten Modelle (Allowlist + Env-Default + Zusatzliste). */
export function allowedVoiceModels(task: VoiceModelTask): string[] {
  const extra = envTrim('VOICE_AI_MODEL_ALLOWLIST')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return [...new Set([...RUNTIME_MODEL_ALLOWLIST[task], runtimeModelDefault(task), ...extra])];
}

/**
 * Loest den optionalen Client-Override auf. `null` heisst: Modell nicht erlaubt
 * (die Route antwortet 400). Ohne Override gilt das Env-/Konstanten-Modell.
 */
export function resolveVoiceRuntimeModel(
  task: VoiceModelTask,
  requested?: string,
): { model: string; override: boolean } | null {
  const wanted = String(requested ?? '').trim();
  if (!wanted) return { model: runtimeModelDefault(task), override: false };
  if (!allowedVoiceModels(task).includes(wanted)) return null;
  return { model: wanted, override: true };
}

let hfEndpointWarned = false;
/** Eigene audiomonastry-ai-runtime (lokal/Runpod). HF_ENDPOINT_URL wird bewusst ignoriert. */
function voiceRuntimeUrl(): string {
  if (!hfEndpointWarned && (process.env.HF_ENDPOINT_URL ?? '').trim()) {
    hfEndpointWarned = true;
    console.warn('[voice] HF_ENDPOINT_URL wird ignoriert (AI nur lokal, RT-AUDIT-P1-014) – VOICE_AI_RUNTIME_URL auf die eigene Runtime setzen.');
  }
  return (process.env.VOICE_AI_RUNTIME_URL || '').trim();
}

const NO_RUNTIME_HINT = 'VOICE_AI_RUNTIME_URL auf die eigene audiomonastry-ai-runtime (Runpod/Hetzner) setzen';

// ---------------------------------------------------------------------------
// RT-AUDIT-P1-014-F2: Voice-Tasks zuerst ueber die Flotte, dann ueber die URL
// ---------------------------------------------------------------------------
// Das Modell der Rollen-Strecke steht hier, weil der Worker ausschliesslich IDs
// kennt, die im Manifest der Rolle liegen (roles.<rolle>.models). Die
// Runtime-Strecke behaelt ihre Env-Defaults (VOICE_AI_RUNTIME_*_MODEL).
const ROLE_TASK_MODEL: Partial<Record<AiTask, string>> = {
  tts: 'qwen3-tts-17b',
  // Betreiber-Entscheid 2026-10-12: xl-base liegt auf RP4 (LEGO), der music-Pod
  // (RP3) traegt xl-sft/xl-turbo. Track-Generierung daher wie music.generate.
  song: 'acestep-v15-xl-sft',
  // FLEET-P1-008 ist OFFEN: moss-soundeffect-v2.0 steht im Zielbild und in
  // pod-fleet `target`, hat aber noch keinen Handler - generate_dispatch leitet
  // es heute auf den Stable-Audio-Handler (fp16) um. Ein Umschalten der Route
  // vor dem Handler liesse den Pod MOSS-Gewichte in die StableAudioPipeline
  // laden (Bruch). Deshalb bleibt hier das Modell, das wirklich laeuft;
  // umgestellt wird zusammen mit dem Handler in FLEET-P1-008.
  'audio.generate': 'stable-audio-open-1.0',
  // AI-RUNPOD-SING-001: `sing` hatte KEIN Modell (der Worker legt den Task auf
  // einen Bark-Handler, im Manifest war kein sing-Modell). Seit 2026-10-11 ist
  // es vergeben - bark-small in der Rolle music, damit kein toter Pfad bleibt.
  sing: 'bark-small',
};

/**
 * Kann die Flotte diesen Task bedienen?
 *
 * Der lokale/deterministische Provider kann laut `canRun` auch `tts` und `song`
 * - er liefert aber TEXT, kein Audio. Er zaehlt hier deshalb nicht als
 * Rollen-Verfuegbarkeit, sonst wuerde ein unkonfigurierter Endpoint als
 * verfuegbar gelten und der Aufruf endete mit einem Nicht-Audio-Ergebnis.
 */
function roleCanRun(task: AiTask): boolean {
  if (!ROLE_TASK_MODEL[task]) return false;
  return aiOrchestrator.providers.candidates(task).some((p) => p.id !== 'local');
}

/** Audio-Buffer aus einer Worker-Antwort der Rolle ({audioBase64, sampleRate}). */
function audioBufferFromWorkerResult(result: unknown, label: string): Buffer {
  const envelope = (result ?? {}) as { audioBase64?: unknown; audio?: unknown };
  const base64 =
    typeof envelope.audioBase64 === 'string'
      ? envelope.audioBase64
      : typeof envelope.audio === 'string'
        ? envelope.audio
        : '';
  if (!base64) throw new Error(`${label}: Worker-Antwort ohne audioBase64`);
  return Buffer.from(base64, 'base64');
}

/**
 * Audio ueber die Flotten-Rolle erzeugen.
 *
 * `null` heisst "diese Strecke kann den Task nicht" - dann greift die feste
 * Runtime-URL. Ein Fehler der Rolle bricht NICHT ab: die URL ist der
 * dokumentierte Rueckfall, der Grund wird aber laut geloggt (kein stiller
 * Wechsel). Ein `local`-Ergebnis zaehlt ebenfalls als nicht bedient.
 */
async function voiceRoleBuffer(task: AiTask, input: Record<string, unknown>): Promise<Buffer | null> {
  const model = ROLE_TASK_MODEL[task];
  if (!model || !roleCanRun(task)) return null;
  try {
    const { provider, result } = await aiOrchestrator.providers.run(task, model, input);
    if (provider === 'local') return null;
    return audioBufferFromWorkerResult(result, `Rolle ${task} (${model})`);
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'Unbekannter Fehler';
    console.warn(`[voice] Rolle ${task} (${model}) fehlgeschlagen, Fallback auf die Runtime-URL:`, detail);
    return null;
  }
}

/**
 * Voice-Task: erst die Rolle, dann die feste Runtime-URL.
 *
 * Zwei Eingaben, weil die Wege unterschiedliche Schluesselnamen lesen:
 * ACE-Step auf der Rolle nimmt `durationSeconds` (handlers_runpod.acestep_generate),
 * MusicGen auf der URL nimmt `maxDuration` (handlers.hf_generate).
 */
async function voiceTaskBuffer(
  task: AiTask,
  runtimeModel: string,
  runtimeInput: Record<string, unknown>,
  roleInput: Record<string, unknown>,
  timeoutMs = 180_000,
  /** DA-2026-10-17-013: bei einem Client-Override nur den Weg nehmen, der das Modell wirklich kennt. */
  allowRole = true,
): Promise<Buffer> {
  const viaRole = allowRole ? await voiceRoleBuffer(task, roleInput) : null;
  if (viaRole) return viaRole;
  return voiceRuntimeInference(task, runtimeModel, runtimeInput, timeoutMs);
}

/**
 * Ruft den eigenen Custom-Container (audiomonastry-ai-runtime) über POST /infer auf.
 * Liefert das fertige WAV als Buffer zurück. Der Runtime-Handler muss
 * `{ audioBase64, sampleRate }` zurückgeben.
 */
async function voiceRuntimeInference(
  task: string,
  model: string,
  input: Record<string, unknown>,
  timeoutMs = 180_000,
): Promise<Buffer> {
  const base = voiceRuntimeUrl();
  if (!base) throw new Error('VOICE_AI_RUNTIME_URL fehlt');
  // DA-2026-10-17-009: Der Runtime-Token gehoert zur Runtime. HF_TOKEN ist nur
  // noch ein dokumentierter Uebergang und geht AUSSCHLIESSLICH an Hosts der
  // Allowlist (Runtime-Hosts aus der Env bzw. `AI_SECRET_HOSTS`) - nie an eine
  // beliebige URL aus der Env.
  const token = resolveRuntimeToken(base, {
    runtimeToken: process.env.VOICE_AI_RUNTIME_TOKEN,
    hfToken: process.env.HF_TOKEN,
  });
  const resp = await fetch(`${base.replace(/\/+$/, '')}/infer`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ task, model, input }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!resp.ok) {
    // DA-2026-10-17-014: Body nur ins Log, nicht in die Antwort.
    const detail = await resp.text().catch(() => '');
    throw new UpstreamError(
      'UPSTREAM_HTTP',
      `AI-Runtime ${model} HTTP ${resp.status}`,
      `${model} HTTP ${resp.status}: ${detail.slice(0, 300)}`,
      resp.status,
    );
  }
  const data = (await resp.json()) as { result?: { audioBase64?: string; sampleRate?: number } };
  if (!data.result?.audioBase64) {
    throw new UpstreamError('NO_AUDIO', `AI-Runtime ${model}: audioBase64 fehlt`, `${model}: Antwort ohne result.audioBase64`);
  }
  return Buffer.from(data.result.audioBase64, 'base64');
}
function sendWavBuffer(res: Response, buf: Buffer): void {
  res.setHeader('Content-Type', 'audio/wav');
  res.setHeader('Cache-Control', 'no-store');
  res.send(buf);
}
// ---------------------------------------------------------------------------
// ACE-Step 1.5 (MIT, Vocal-Songs) – optionaler externer SongMONK-Backend
// ---------------------------------------------------------------------------
function aceStepBaseUrl(): string {
  return (process.env.SONG_AI_ACE_STEP_URL || '').trim();
}
function aceStepHeaders(): Record<string, string> {
  const token = (process.env.SONG_AI_ACE_STEP_TOKEN || process.env.ACESTEP_API_KEY || '').trim();
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}
/**
 * Pollt eine ACE-Step-kompatible `query_result`-Route bis Status 1 (ok) oder
 * 2 (failed) und laedt die fertige Audiodatei.
 *
 * ACE-Step und der DiffRhythm-Wrapper sprechen dasselbe Protokoll (release_task
 * → query_result → Audiodatei); der Ablauf liegt deshalb genau einmal hier.
 * Unterschiedlich sind nur die Kopfzeilen-Quelle und die Fehlerbezeichnung -
 * beides kommt als Parameter herein, damit die Meldungen wortgleich bleiben.
 */
async function pollCompatibleTaskAudio(opts: {
  base: string;
  headers: Record<string, string>;
  taskId: string;
  deadline: number;
  timeoutMs: number;
  label: string;
}): Promise<Buffer> {
  const { base, headers, taskId, deadline, timeoutMs, label } = opts;
  while (Date.now() < deadline) {
    const queryResp = await fetch(`${base}/query_result`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ task_id_list: [taskId] }),
      signal: AbortSignal.timeout(30_000),
    });
    if (queryResp.ok) {
      const queryData = (await queryResp.json()) as {
        data?: Array<{ task_id?: string; status?: number; result?: string }>;
      };
      const entry = (queryData.data ?? []).find((x) => x.task_id === taskId);
      if (entry?.status === 1 && entry.result) {
        // DA-2026-10-17-017: Die `result`-Spalte ist Freitext des Wrappers -
        // ohne Typ-Pruefung wuerde ein Objekt/eine Zahl als Liste gelesen.
        const parsed: unknown = JSON.parse(entry.result);
        const fileUrl = Array.isArray(parsed)
          ? (parsed[0] as { file?: unknown } | undefined)?.file
          : undefined;
        if (typeof fileUrl !== 'string' || !fileUrl) {
          throw new UpstreamError('NO_AUDIO_URL', `${label} Ergebnis ohne Audio-URL`, `${label}: result ohne file`);
        }
        // DA-2026-10-17-011: Die URL kommt vom Backend und wird deshalb
        // geprueft: nur http/https, keine privaten/loopback-Ziele, Host nur
        // aus der Allowlist, kein automatisches Folgen von Redirects.
        try {
          return await fetchOutboundBuffer(fileUrl, {
            baseUrl: base,
            allowedHosts: audioHostAllowlist(base),
            timeoutMs: 60_000,
          });
        } catch (error) {
          if (error instanceof OutboundUrlError) {
            throw new UpstreamError(
              'BLOCKED_AUDIO_URL',
              `${label}: Audio-URL abgelehnt (${error.code})`,
              `${label}: ${error.code} (${error.message})`,
            );
          }
          throw error;
        }
      }
      if (entry?.status === 2) throw new Error(`${label} Task ${taskId} fehlgeschlagen`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`${label} Task ${taskId} Timeout nach ${timeoutMs} ms`);
}

/** ACE-Step REST (uv run acestep-api): async release_task → query_result → download. */
async function aceStepGenerateSong(input: {
  prompt: string;
  bpm?: number;
  durationSeconds: number;
  timeoutMs?: number;
}): Promise<Buffer> {
  const base = aceStepBaseUrl().replace(/\/+$/, '');
  if (!base) throw new Error('SONG_AI_ACE_STEP_URL fehlt');
  const timeoutMs = input.timeoutMs ?? 300_000;
  const deadline = Date.now() + timeoutMs;

  const releaseBody: Record<string, unknown> = {
    prompt: input.prompt.slice(0, 2000),
    thinking: true,
    audio_format: 'wav',
    // ACE-Step unterstützt 10–600 s; kürzere Wünsche werden auf 10 s angehoben.
    audio_duration: Math.max(10, Math.min(600, Math.round(input.durationSeconds || 30))),
  };
  if (input.bpm && Number.isFinite(input.bpm)) releaseBody.bpm = Math.max(30, Math.min(300, Math.round(input.bpm)));

  const releaseResp = await fetch(`${base}/release_task`, {
    method: 'POST',
    headers: aceStepHeaders(),
    body: JSON.stringify(releaseBody),
    signal: AbortSignal.timeout(60_000),
  });
  if (!releaseResp.ok) throw new Error(`ACE-Step release_task HTTP ${releaseResp.status}`);
  const releaseData = (await releaseResp.json()) as { data?: unknown; code?: number; error?: string | null };
  if (releaseData.code !== undefined && releaseData.code !== 200) {
    throw new Error(`ACE-Step release_task code ${releaseData.code}: ${releaseData.error ?? ''}`);
  }
  const data = releaseData.data as { task_id?: string; taskId?: string } | string | undefined;
  const taskId = typeof data === 'string' ? data : (data?.task_id ?? data?.taskId ?? '');
  if (!taskId) throw new Error('ACE-Step release_task ohne task_id');

  // Poll bis Status 1 (ok) oder 2 (failed).
  return pollCompatibleTaskAudio({
    base, headers: aceStepHeaders(), taskId, deadline, timeoutMs, label: 'ACE-Step',
  });
}
// ---------------------------------------------------------------------------
// DiffRhythm 2 (Apache-2.0) – optionaler zweiter SongMONK-Backend
// Offiziell gibt es noch keine REST-API; der Anschluss erfolgt über einen
// kleinen ACE-Step-kompatiblen Wrapper (release_task/query_result/audio).
// ---------------------------------------------------------------------------
function diffRhythmBaseUrl(): string {
  return (process.env.SONG_AI_DIFF_RHYTHM_URL || '').trim();
}
function diffRhythmHeaders(): Record<string, string> {
  const token = (process.env.SONG_AI_DIFF_RHYTHM_TOKEN || '').trim();
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}
async function diffRhythmGenerateSong(input: {
  prompt: string;
  lyrics?: string;
  bpm?: number;
  durationSeconds: number;
  timeoutMs?: number;
}): Promise<Buffer> {
  const base = diffRhythmBaseUrl().replace(/\/+$/, '');
  if (!base) throw new Error('SONG_AI_DIFF_RHYTHM_URL fehlt');
  const timeoutMs = input.timeoutMs ?? 300_000;
  const deadline = Date.now() + timeoutMs;

  const releaseBody: Record<string, unknown> = {
    prompt: input.prompt.slice(0, 2000),
    lyrics: input.lyrics?.slice(0, 2000) ?? '',
    audio_format: 'wav',
    audio_duration: Math.max(10, Math.min(600, Math.round(input.durationSeconds || 30))),
  };
  if (input.bpm && Number.isFinite(input.bpm)) releaseBody.bpm = Math.max(30, Math.min(300, Math.round(input.bpm)));

  const releaseResp = await fetch(`${base}/release_task`, {
    method: 'POST',
    headers: diffRhythmHeaders(),
    body: JSON.stringify(releaseBody),
    signal: AbortSignal.timeout(60_000),
  });
  if (!releaseResp.ok) throw new Error(`DiffRhythm release_task HTTP ${releaseResp.status}`);
  const releaseData = (await releaseResp.json()) as { data?: unknown; code?: number; error?: string | null };
  const data = releaseData.data as { task_id?: string; taskId?: string } | string | undefined;
  const taskId = typeof data === 'string' ? data : (data?.task_id ?? data?.taskId ?? '');
  if (!taskId) throw new Error('DiffRhythm release_task ohne task_id');

  // Poll bis Status 1 (ok) oder 2 (failed) - derselbe Ablauf wie bei ACE-Step.
  return pollCompatibleTaskAudio({
    base, headers: diffRhythmHeaders(), taskId, deadline, timeoutMs, label: 'DiffRhythm',
  });
}
/** Sanitisiert Text/Prompts (kein Prompt-Injection-Rauschen, Länge begrenzt). */
function cleanVoiceText(raw: unknown, max = 500): string {
  return String(raw ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

/**
 * MusicGen-Eingabe aus dem VoiceSong-Schema bauen: Dauer begrenzen, Stil/BPM
 * sanft bereinigen, Token-Budget ableiten. `/api/voice/song` und
 * `/api/song/generate` nutzen denselben Aufbau (gleiches Feld-Set, gleiches
 * Schema) - er liegt deshalb genau einmal hier.
 */
function buildMusicGenRequest(data: {
  prompt: string;
  durationSeconds: number;
  style?: string;
  bpm?: number;
}) {
  const clean = cleanVoiceText(data.prompt);
  const duration = Math.max(1, Math.min(30, Number(data.durationSeconds) || 8));
  const maxTokens = Math.max(64, Math.round(duration * 50 / 8));
  // Prompt für MusicGen: Stil/BPM sauber anhängen (kein Freitext-Injection-Risiko).
  const styleClean = String(data.style ?? '').replace(/[^\p{L}\p{N}\s\-]/gu, '').trim().slice(0, 80);
  const bpmClean = Number.isFinite(Number(data.bpm)) && Number(data.bpm) > 0 ? Math.round(Number(data.bpm)) : 0;
  const inputs = [
    clean,
    styleClean ? `Style: ${styleClean}` : '',
    bpmClean ? `BPM: ${bpmClean}` : '',
  ].filter(Boolean).join(', ');
  return { clean, duration, parameters: { max_new_tokens: maxTokens }, styleClean, bpmClean, inputs };
}

// ===========================================================================
// soundMONK: Server-AI-Generierung (MusicGen/Runtime) – Browser-Fallback lokal
// ===========================================================================
const SOUND_DEFAULT_PROMPTS: Record<string, string> = {
  beat: 'electronic techno beat, 128 BPM, driving drums, acid bassline',
  bass: 'deep electronic bass one-shot, sub-heavy, punchy, short decay',
  atmosphere: 'dark ambient pad, wide reverb, evolving textures, cinematic',
  oneshot: 'electronic percussion one-shot, tight, clean transient, studio quality',
};

export function registerVoiceRoutes(app: Express): void {
  // --- POST /api/voice/tts  → Text → Stimme (Qwen3-TTS über die eigene Runtime) ---
  app.post('/api/voice/tts', async (req, res) => {
    const parsedTts = VoiceTtsSchema.safeParse(req.body ?? {});
    if (!parsedTts.success) {
      return res.status(400).json({ error: parsedTts.error.issues[0]?.message ?? 'invalid payload' });
    }
    const { text, model, language, speaker, instruct } = parsedTts.data;
    const clean = cleanVoiceText(text);
    if (!clean) return res.status(400).json({ error: 'text fehlt' });
    // VOICE-P1-001: Sprach-Normalisierung fuer die Flotte. Qwen3-TTS bekommt ausgeschriebene Zahlwoerter, aufgeloeste Abkuerzungen
    // und gesprochene Einheiten - sonst liest das Modell "17.09.2026", "19,99 €"
    // oder "z.B." als Zeichenkette vor. Der normalisierte Text steht als Header
    // in der Antwort, damit im Betrieb nachvollziehbar ist, WAS gesprochen wurde.
    const speech = normalizeForSpeech(clean);
    res.setHeader('X-Voice-Speech-Text', encodeURIComponent(speech.slice(0, 400)));
    // DA-2026-10-17-013: Override wird benutzt (Allowlist), nicht verworfen.
    // Die Pruefung steht VOR der Konfigurationspruefung: ein ungueltiges Modell
    // ist ein Client-Fehler (400), keine fehlende Runtime (503).
    const modelChoice = resolveVoiceRuntimeModel('tts', model);
    if (!modelChoice) return res.status(400).json({ error: 'Modell nicht erlaubt', code: 'MODEL_NOT_ALLOWED' });
    if (!voiceRuntimeUrl() && !roleCanRun('tts')) {
      return res.status(503).json({ error: 'tts: keine Voice-Runtime konfiguriert', hint: NO_RUNTIME_HINT });
    }
    const runtimeModel = modelChoice.model;
    // Der Rollen-Worker kennt nur Modelle seines Manifests - bei einem fremden
    // Override deshalb direkt die Runtime nehmen (kein stiller Modelltausch).
    const allowRole = !modelChoice.override || modelChoice.model === ROLE_TASK_MODEL.tts;
    // Der Worker-Vertrag ist hier identisch (text/language/speaker/instruct ->
    // {audioBase64, sampleRate}), deshalb EINE Eingabe fuer beide Wege.
    const ttsInput = {
      text: speech,
      language: cleanVoiceText(language, 50) || 'German',
      speaker: cleanVoiceText(speaker, 64) || 'Ryan',
      instruct: cleanVoiceText(instruct, 500),
    };
    try {
      const runtimeBuf = await voiceTaskBuffer('tts', runtimeModel, ttsInput, ttsInput, 180_000, allowRole);
      return sendWavBuffer(res, runtimeBuf);
    } catch (err) {
      // DA-2026-10-17-014: generische Meldung + Correlation-ID, Detail im Log.
      return sendUpstreamFailure(res, 'tts', err);
    }
  });

  // --- POST /api/voice/sing  → Text → Gesang (Bark über die eigene Runtime) ---
  app.post('/api/voice/sing', async (req, res) => {
    const parsedSing = VoiceSingSchema.safeParse(req.body ?? {});
    if (!parsedSing.success) {
      return res.status(400).json({ error: parsedSing.error.issues[0]?.message ?? 'invalid payload' });
    }
    const { text, model } = parsedSing.data;
    const clean = cleanVoiceText(text);
    if (!clean) return res.status(400).json({ error: 'text fehlt' });
    // RT-AUDIT-P1-014-F2 + AI-RUNPOD-SING-001: `sing` laeuft ueber die Rolle
    // music (Manifest-Modell bark-small, Task `sing` -> handlers.hf_bark_sing);
    // die feste Runtime-URL bleibt der Rueckfall. Vorher war der Rollen-Weg hier
    // unbedienbar, weil kein Modell task `sing` hatte.
    // DA-2026-10-17-013: Override gilt (Allowlist); fremdes Modell -> Runtime-Weg.
    // Zuerst pruefen: ungueltiges Modell = 400, nicht 503.
    const modelChoice = resolveVoiceRuntimeModel('sing', model);
    if (!modelChoice) return res.status(400).json({ error: 'Modell nicht erlaubt', code: 'MODEL_NOT_ALLOWED' });
    if (!voiceRuntimeUrl() && !roleCanRun('sing')) {
      return res.status(503).json({ error: 'sing: keine Voice-Runtime konfiguriert', hint: NO_RUNTIME_HINT });
    }
    const runtimeModel = modelChoice.model;
    const allowRole = !modelChoice.override || modelChoice.model === ROLE_TASK_MODEL.sing;
    try {
      // VOICE-P1-001: auch der Singtext wird normalisiert (gleiche Aussprache-Regeln).
      // Bark singt am zuverlässigsten mit ♪-Noten-Prompt - auf beiden Wegen.
      const singText = `♪ ${normalizeForSpeech(clean)} ♪`;
      const runtimeBuf = await voiceTaskBuffer('sing', runtimeModel, { text: singText }, { text: singText }, 180_000, allowRole);
      return sendWavBuffer(res, runtimeBuf);
    } catch (err) {
      // DA-2026-10-17-014
      return sendUpstreamFailure(res, 'sing', err);
    }
  });

  // --- POST /api/voice/song  → Prompt → Song (MusicGen über die eigene Runtime) ---
  app.post('/api/voice/song', async (req, res) => {
    const parsedSong = VoiceSongSchema.safeParse(req.body ?? {});
    if (!parsedSong.success) {
      return res.status(400).json({ error: parsedSong.error.issues[0]?.message ?? 'invalid payload' });
    }
    const { prompt, model, durationSeconds, style, bpm } = parsedSong.data;
    const { clean, duration, inputs } = buildMusicGenRequest({ prompt, durationSeconds, style, bpm });
    if (!clean) return res.status(400).json({ error: 'prompt fehlt' });
    // DA-2026-10-17-013: Override gilt (Allowlist); fremdes Modell -> Runtime-Weg.
    // Zuerst pruefen: ungueltiges Modell = 400, nicht 503.
    const modelChoice = resolveVoiceRuntimeModel('song', model);
    if (!modelChoice) return res.status(400).json({ error: 'Modell nicht erlaubt', code: 'MODEL_NOT_ALLOWED' });
    if (!voiceRuntimeUrl() && !roleCanRun('song')) {
      return res.status(503).json({ error: 'song: keine Voice-Runtime konfiguriert', hint: NO_RUNTIME_HINT });
    }
    const runtimeModel = modelChoice.model;
    const allowRole = !modelChoice.override || modelChoice.model === ROLE_TASK_MODEL.song;
    try {
      const runtimeBuf = await voiceTaskBuffer(
        'song',
        runtimeModel,
        { prompt: inputs, maxDuration: duration },
        { prompt: inputs, durationSeconds: duration },
        240_000,
        allowRole,
      );
      return sendWavBuffer(res, runtimeBuf);
    } catch (err) {
      // DA-2026-10-17-014
      return sendUpstreamFailure(res, 'song', err);
    }
  });

  app.post('/api/sound/generate', async (req, res) => {
    const parsedSound = SoundGenerateSchema.safeParse(req.body ?? {});
    if (!parsedSound.success) {
      return res.status(400).json({ error: parsedSound.error.issues[0]?.message ?? 'invalid payload' });
    }
    const { kind, prompt, durationSeconds } = parsedSound.data;
    const kindClean = String(kind ?? 'beat').replace(/[^a-z]/gi, '').toLowerCase().slice(0, 20);
    const promptClean = cleanVoiceText(prompt, 300);
    const inputs = promptClean || SOUND_DEFAULT_PROMPTS[kindClean] || SOUND_DEFAULT_PROMPTS.beat;
    const duration = Math.max(2, Math.min(20, Number(durationSeconds) || 6));
    let lastError = '';

    // soundMONK-Upgrade: ACE-Step 1.5 (MIT) kann Beats/Loops/Atmo/One-Shots erzeugen.
    if (aceStepBaseUrl()) {
      try {
        const aceBuf = await aceStepGenerateSong({
          prompt: inputs,
          durationSeconds: duration,
          timeoutMs: 300_000,
        });
        return sendWavBuffer(res, aceBuf);
      } catch (aceErr) {
        lastError = aceErr instanceof Error ? aceErr.message : 'Unbekannter Fehler';
        console.warn('[sound] ACE-Step fehlgeschlagen, Fallback auf Runtime:', lastError);
      }
    }

    if (!voiceRuntimeUrl() && !roleCanRun('audio.generate')) {
      return res.status(503).json({ error: 'soundMONK: keine AI-Runtime konfiguriert', hint: 'VOICE_AI_RUNTIME_URL (eigene Runtime) oder SONG_AI_ACE_STEP_URL setzen' });
    }
    try {
      // RT-AUDIT-P1-014-F2: erst die Rolle voiceGen (Task audio.generate ->
      // Manifest-Modell stable-audio-open-1.0, der SFX-Handler des Workers).
      const roleBuf = await voiceRoleBuffer('audio.generate', { prompt: inputs, maxDuration: duration });
      if (roleBuf) return sendWavBuffer(res, roleBuf);
    } catch (roleErr) {
      console.warn('[sound] Rolle audio.generate fehlgeschlagen, Fallback auf Runtime:', roleErr instanceof Error ? roleErr.message : roleErr);
    }
    try {
      const runtimeModel = (process.env.SOUND_AI_RUNTIME_MODEL || 'musicgen-small').trim();
      const runtimeBuf = await voiceRuntimeInference('song', runtimeModel, { prompt: inputs, maxDuration: duration }, 240_000);
      return sendWavBuffer(res, runtimeBuf);
    } catch (err) {
      // DA-2026-10-17-014: kein `detail` mehr an den Client; Grund im Log.
      console.warn('[sound] AI-Generierung fehlgeschlagen:', err instanceof Error ? err.message : err);
      return sendUpstreamFailure(res, 'sound generation', err);
    }
  });

  // ===========================================================================
  // songMONK: eigener Song-Endpoint (aus VoiceMONK entkoppelt)
  // Backend-Reihenfolge: ACE-Step 1.5 (optional, Vocal-Songs) → DiffRhythm
  // (optional) → eigene Runtime (MusicGen). Kein Cloud-Fallback.
  // ===========================================================================
  app.post('/api/song/generate', async (req, res) => {
    // Gleiches Feld-Set wie /api/voice/song -> dasselbe Schema (kein Duplikat).
    const parsedSongGen = VoiceSongSchema.safeParse(req.body ?? {});
    if (!parsedSongGen.success) {
      return res.status(400).json({ error: parsedSongGen.error.issues[0]?.message ?? 'invalid payload' });
    }
    const { prompt, model, durationSeconds, style, bpm } = parsedSongGen.data;
    const { clean, duration, styleClean, bpmClean, inputs } =
      buildMusicGenRequest({ prompt, durationSeconds, style, bpm });
    if (!clean) return res.status(400).json({ error: 'prompt fehlt' });

    const acePrompt = [clean, styleClean].filter(Boolean).join(', ');

    // DA-2026-10-17-013: Der Client-Override wird benutzt. ACE-Step/DiffRhythm
    // sind Wrapper mit festem Modell - wer ein Modell vorgibt, laeuft deshalb
    // direkt ueber Rolle/Runtime, statt still ein anderes Modell zu bekommen.
    const modelChoice = resolveVoiceRuntimeModel('song', model);
    if (!modelChoice) return res.status(400).json({ error: 'Modell nicht erlaubt', code: 'MODEL_NOT_ALLOWED' });
    const preferRuntime = modelChoice.override;
    let lastError = '';

    // ACE-Step 1.5 (MIT, komplette Vocal-Songs) – optional per Env aktivierbar.
    if (!preferRuntime && aceStepBaseUrl()) {
      try {
        const aceBuf = await aceStepGenerateSong({
          prompt: acePrompt,
          bpm: bpmClean || undefined,
          durationSeconds: duration,
          timeoutMs: 300_000,
        });
        return sendWavBuffer(res, aceBuf);
      } catch (aceErr) {
        lastError = aceErr instanceof Error ? aceErr.message : 'Unbekannter Fehler';
        console.warn('[song] ACE-Step fehlgeschlagen, Fallback auf DiffRhythm/Runtime:', lastError);
      }
    }

    // DiffRhythm 2 (Apache-2.0) – optionaler zweiter Vocal-Song-Backend.
    if (!preferRuntime && diffRhythmBaseUrl()) {
      try {
        const diffBuf = await diffRhythmGenerateSong({
          prompt: acePrompt,
          lyrics: clean,
          bpm: bpmClean || undefined,
          durationSeconds: duration,
          timeoutMs: 300_000,
        });
        return sendWavBuffer(res, diffBuf);
      } catch (diffErr) {
        lastError = diffErr instanceof Error ? diffErr.message : 'Unbekannter Fehler';
        console.warn('[song] DiffRhythm fehlgeschlagen, Fallback auf Runtime:', lastError);
      }
    }

    // Eigene Backends zuletzt: erst die Rolle music (ACE-Step), dann die feste
    // Runtime (MusicGen small als Default, Medium spaeter per Env).
    if (voiceRuntimeUrl() || roleCanRun('song')) {
      const runtimeModel = modelChoice.model;
      const allowRole = !modelChoice.override || modelChoice.model === ROLE_TASK_MODEL.song;
      try {
        const runtimeBuf = await voiceTaskBuffer(
          'song',
          runtimeModel,
          { prompt: inputs, maxDuration: duration },
          { prompt: inputs, durationSeconds: duration },
          240_000,
          allowRole,
        );
        return sendWavBuffer(res, runtimeBuf);
      } catch (runtimeErr) {
        lastError = runtimeErr instanceof Error ? runtimeErr.message : 'Unbekannter Fehler';
        console.warn(`[song] Runtime-Song (${runtimeModel}) fehlgeschlagen:`, lastError);
      }
    }

    if (!aceStepBaseUrl() && !diffRhythmBaseUrl() && !voiceRuntimeUrl() && !roleCanRun('song')) {
      return res.status(503).json({ error: 'songMONK: kein Song-Backend konfiguriert', hint: `${NO_RUNTIME_HINT} oder SONG_AI_ACE_STEP_URL/SONG_AI_DIFF_RHYTHM_URL` });
    }
    // DA-2026-10-17-014: `lastError` bleibt im Log (oben), nicht in der Antwort.
    return sendUpstreamFailure(res, 'songMONK', new UpstreamError('SONG_FAILED', lastError || 'kein Modell'));
  });

}
