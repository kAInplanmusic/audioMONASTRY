/**
 * audioMONASTRY · Voice-Routen (ARCH-P2-002, Extraktion aus server.ts)
 * ====================================================================
 * Die Familie teilt sich die HF-/AceStep-/DiffRhythm-/Voice-Runtime-Helfer,
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
} from '../../src/types/zod/schemas';
import type { Response } from 'express';
import type { Express } from 'express';

// ===========================================================================
// VoiceMONK: serverseitige HF-Inference-Proxy-Endpunkte
// ---------------------------------------------------------------------------
// Der Browser ruft ausschließlich /api/voice/* auf. HF_API_KEY und die
// Modell-Auswahl bleiben im Server-Prozess; der Client erhält nur die
// fertige Audio-Datei. Konfiguration via env:
//   HF_API_KEY, HF_TTS_MODEL, HF_BARK_MODEL,
//   HF_MUSIC_MODEL, HF_MUSIC_FALLBACK_MODEL
// ===========================================================================

// Primär: neuer HF-Router-Endpoint (api-inference.huggingface.co löst in
// manchen Docker-/DNS-Umgebungen nicht auf -> Fallback unten).
const HF_API_BASE = 'https://router.huggingface.co/hf-inference/models';
const HF_API_BASE_LEGACY = 'https://api-inference.huggingface.co/models';
type HfVoiceKind = 'tts' | 'bark' | 'music' | 'musicFallback';
const HF_ENV_MODEL: Record<HfVoiceKind, string> = {
  tts: 'HF_TTS_MODEL',
  bark: 'HF_BARK_MODEL',
  music: 'HF_MUSIC_MODEL',
  musicFallback: 'HF_MUSIC_FALLBACK_MODEL',
};
const HF_DEFAULT_MODEL: Record<HfVoiceKind, string> = {
  tts: 'facebook/mms-tts-deu',
  bark: 'suno/bark',
  music: 'facebook/musicgen-medium',
  musicFallback: 'facebook/musicgen-small',
};
/** Validiert einen Modell-Override (nur sicheres HF-Modell-ID-Format). */
function hfModelFor(kind: HfVoiceKind, override?: string): string {
  const clean = (override ?? '').trim();
  if (clean) {
    return /^[A-Za-z0-9_.\/-]{3,120}$/.test(clean) ? clean : '';
  }
  const env = (process.env[HF_ENV_MODEL[kind]] ?? '').trim();
  return env || HF_DEFAULT_MODEL[kind];
}
/** Serverseitiger HF-Inference-Aufruf mit Timeout. */
async function hfInference(
  model: string,
  inputs: unknown,
  parameters?: Record<string, unknown>,
  timeoutMs = 90000,
): Promise<globalThis.Response> {
  const key = (process.env.HF_API_KEY ?? '').trim();
  if (!key) throw new Error('HF_API_KEY nicht konfiguriert');
  let lastErr: unknown;
  for (const base of [HF_API_BASE, HF_API_BASE_LEGACY]) {
    try {
      const resp = await fetch(`${base}/${model}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(parameters ? { inputs, parameters } : { inputs }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!resp.ok) throw new Error(`HF ${model} HTTP ${resp.status}`);
      return resp;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('HF fetch fehlgeschlagen');
}
/** Replicate-Audio (Serverless-GPU, Pay-per-Use): TTS/Sing/Song/Stems. */
async function replicateAudio(model: string, input: Record<string, unknown>, timeoutMs = 180000): Promise<globalThis.Response> {
  const token = (process.env.REPLICATE_API_TOKEN || '').trim();
  if (!token) throw new Error('REPLICATE_API_TOKEN nicht konfiguriert');
  const createResp = await fetch(`https://api.replicate.com/v1/models/${model}/predictions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'wait' },
    body: JSON.stringify({ input }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!createResp.ok) throw new Error(`Replicate ${model} HTTP ${createResp.status}`);
  let prediction = await createResp.json() as any;
  for (let i = 0; i < 45 && prediction?.status !== 'succeeded' && prediction?.status !== 'failed'; i++) {
    await new Promise((r) => setTimeout(r, 4000));
    const pollResp = await fetch(`https://api.replicate.com/v1/predictions/${prediction.id}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30000),
    });
    prediction = await pollResp.json();
  }
  if (prediction?.status !== 'succeeded') throw new Error('Replicate-Audio-Job fehlgeschlagen');
  const out = prediction.output;
  const url: string | undefined = typeof out === 'string' ? out : Array.isArray(out) ? out[0] : (out?.audio ?? out?.url);
  if (!url) throw new Error('Replicate-Audio ohne Download-URL');
  const audioResp = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!audioResp.ok) throw new Error(`Audio-Download HTTP ${audioResp.status}`);
  return audioResp;
}
/** Schickt eine HF-Audio-Antwort als Binär-Audio an den Client. */
async function sendHfBlob(res: Response, upstream: globalThis.Response): Promise<void> {
  const buf = Buffer.from(await upstream.arrayBuffer());
  res.setHeader('Content-Type', upstream.headers.get('content-type') ?? 'audio/wav');
  res.setHeader('Cache-Control', 'no-store');
  res.send(buf);
}
/** Eigenen samplemonk-ai-runtime-Endpoint bevorzugen, falls konfiguriert. */
function voiceRuntimeUrl(): string {
  return (process.env.VOICE_AI_RUNTIME_URL || process.env.HF_ENDPOINT_URL || '').trim();
}
/**
 * Ruft den eigenen Custom-Container (samplemonk-ai-runtime) über POST /infer auf.
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
  if (!base) throw new Error('VOICE_AI_RUNTIME_URL/HF_ENDPOINT_URL fehlt');
  const token = (process.env.HF_TOKEN || process.env.HF_API_KEY || '').trim();
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
    const detail = await resp.text().catch(() => '');
    throw new Error(`AI-Runtime ${model} HTTP ${resp.status}: ${detail.slice(0, 300)}`);
  }
  const data = (await resp.json()) as { result?: { audioBase64?: string; sampleRate?: number } };
  if (!data.result?.audioBase64) throw new Error(`AI-Runtime ${model}: audioBase64 fehlt`);
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
  while (Date.now() < deadline) {
    const queryResp = await fetch(`${base}/query_result`, {
      method: 'POST',
      headers: aceStepHeaders(),
      body: JSON.stringify({ task_id_list: [taskId] }),
      signal: AbortSignal.timeout(30_000),
    });
    if (queryResp.ok) {
      const queryData = (await queryResp.json()) as {
        data?: Array<{ task_id?: string; status?: number; result?: string }>;
      };
      const entry = (queryData.data ?? []).find((x) => x.task_id === taskId);
      if (entry?.status === 1 && entry.result) {
        const parsed = JSON.parse(entry.result) as Array<{ file?: string }>;
        const fileUrl = parsed?.[0]?.file;
        if (!fileUrl) throw new Error('ACE-Step Ergebnis ohne Audio-URL');
        const audioResp = await fetch(fileUrl.startsWith('http') ? fileUrl : `${base}${fileUrl}`, {
          signal: AbortSignal.timeout(60_000),
        });
        if (!audioResp.ok) throw new Error(`ACE-Step Audio-Download HTTP ${audioResp.status}`);
        return Buffer.from(await audioResp.arrayBuffer());
      }
      if (entry?.status === 2) throw new Error(`ACE-Step Task ${taskId} fehlgeschlagen`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`ACE-Step Task ${taskId} Timeout nach ${timeoutMs} ms`);
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

  while (Date.now() < deadline) {
    const queryResp = await fetch(`${base}/query_result`, {
      method: 'POST',
      headers: diffRhythmHeaders(),
      body: JSON.stringify({ task_id_list: [taskId] }),
      signal: AbortSignal.timeout(30_000),
    });
    if (queryResp.ok) {
      const queryData = (await queryResp.json()) as {
        data?: Array<{ task_id?: string; status?: number; result?: string }>;
      };
      const entry = (queryData.data ?? []).find((x) => x.task_id === taskId);
      if (entry?.status === 1 && entry.result) {
        const parsed = JSON.parse(entry.result) as Array<{ file?: string }>;
        const fileUrl = parsed?.[0]?.file;
        if (!fileUrl) throw new Error('DiffRhythm Ergebnis ohne Audio-URL');
        const audioResp = await fetch(fileUrl.startsWith('http') ? fileUrl : `${base}${fileUrl}`, {
          signal: AbortSignal.timeout(60_000),
        });
        if (!audioResp.ok) throw new Error(`DiffRhythm Audio-Download HTTP ${audioResp.status}`);
        return Buffer.from(await audioResp.arrayBuffer());
      }
      if (entry?.status === 2) throw new Error(`DiffRhythm Task ${taskId} fehlgeschlagen`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`DiffRhythm Task ${taskId} Timeout nach ${timeoutMs} ms`);
}
/** Sanitisiert Text/Prompts (kein Prompt-Injection-Rauschen, Länge begrenzt). */
function cleanVoiceText(raw: unknown, max = 500): string {
  return String(raw ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
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
  // --- POST /api/voice/tts  → Text → Stimme (Qwen3-TTS/MMS via eigener Runtime oder HF) ---
  app.post('/api/voice/tts', async (req, res) => {
    const parsedTts = VoiceTtsSchema.safeParse(req.body ?? {});
    if (!parsedTts.success) {
      return res.status(400).json({ error: parsedTts.error.issues[0]?.message ?? 'invalid payload' });
    }
    const { text, model, language, speaker, instruct } = parsedTts.data;
    const clean = cleanVoiceText(text);
    if (!clean) return res.status(400).json({ error: 'text fehlt' });
    const selected = hfModelFor('tts', model);
    if (!selected) return res.status(400).json({ error: 'Ungültiges Modell' });
    try {
      const voiceProvider = (process.env.VOICE_PROVIDER || 'hf').trim();
      if (voiceProvider === 'replicate') {
        const ttsModel = (process.env.REPLICATE_TTS_MODEL || 'suno-ai/bark').trim();
        const upstream = await replicateAudio(ttsModel, { prompt: clean });
        await sendHfBlob(res, upstream);
      } else {
        // Eigene Runtime (samplemonk-ai, Qwen3-TTS) zuerst – HF-Serverless nur Fallback.
        if (voiceRuntimeUrl()) {
          const runtimeModel = (process.env.VOICE_AI_RUNTIME_TTS_MODEL || 'qwen3-tts-06b').trim();
          try {
            const runtimeBuf = await voiceRuntimeInference('tts', runtimeModel, {
              text: clean,
              language: cleanVoiceText(language, 50) || 'German',
              speaker: cleanVoiceText(speaker, 64) || 'Ryan',
              instruct: cleanVoiceText(instruct, 500),
            });
            return sendWavBuffer(res, runtimeBuf);
          } catch (runtimeErr) {
            console.warn(`[voice] Runtime-TTS (${runtimeModel}) fehlgeschlagen, Fallback auf HF:`, runtimeErr instanceof Error ? runtimeErr.message : runtimeErr);
          }
        }
        const upstream = await hfInference(selected, clean);
        await sendHfBlob(res, upstream);
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'Unbekannter Fehler';
      res.status(502).json({ error: 'tts fehlgeschlagen', detail });
    }
  });

  // --- POST /api/voice/sing  → Text → Gesang (Suno Bark) ---
  app.post('/api/voice/sing', async (req, res) => {
    const parsedSing = VoiceSingSchema.safeParse(req.body ?? {});
    if (!parsedSing.success) {
      return res.status(400).json({ error: parsedSing.error.issues[0]?.message ?? 'invalid payload' });
    }
    const { text, model } = parsedSing.data;
    const clean = cleanVoiceText(text);
    if (!clean) return res.status(400).json({ error: 'text fehlt' });
    const selected = hfModelFor('bark', model);
    if (!selected) return res.status(400).json({ error: 'Ungültiges Modell' });
    try {
      const voiceProvider = (process.env.VOICE_PROVIDER || 'hf').trim();
      if (voiceProvider === 'replicate') {
        const singModel = (process.env.REPLICATE_BARK_MODEL || 'suno-ai/bark').trim();
        const upstream = await replicateAudio(singModel, { prompt: `♪ ${clean} ♪` });
        await sendHfBlob(res, upstream);
      } else {
        // Eigene Runtime (Bark) zuerst – HF-Serverless nur Fallback.
        if (voiceRuntimeUrl()) {
          const runtimeModel = (process.env.VOICE_AI_RUNTIME_SING_MODEL || 'bark').trim();
          try {
            const runtimeBuf = await voiceRuntimeInference('sing', runtimeModel, { text: `♪ ${clean} ♪` });
            return sendWavBuffer(res, runtimeBuf);
          } catch (runtimeErr) {
            console.warn(`[voice] Runtime-Sing (${runtimeModel}) fehlgeschlagen, Fallback auf HF:`, runtimeErr instanceof Error ? runtimeErr.message : runtimeErr);
          }
        }
        // Bark singt am zuverlässigsten mit ♪-Noten-Prompt.
        const upstream = await hfInference(selected, `♪ ${clean} ♪`);
        await sendHfBlob(res, upstream);
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'Unbekannter Fehler';
      res.status(502).json({ error: 'sing fehlgeschlagen', detail });
    }
  });

  // --- POST /api/voice/song  → Prompt → Song (MusicGen medium → small) ---
  app.post('/api/voice/song', async (req, res) => {
    const parsedSong = VoiceSongSchema.safeParse(req.body ?? {});
    if (!parsedSong.success) {
      return res.status(400).json({ error: parsedSong.error.issues[0]?.message ?? 'invalid payload' });
    }
    const { prompt, model, durationSeconds, style, bpm } = parsedSong.data;
    const clean = cleanVoiceText(prompt);
    if (!clean) return res.status(400).json({ error: 'prompt fehlt' });

    const duration = Math.max(1, Math.min(30, Number(durationSeconds) || 8));
    const maxTokens = Math.max(64, Math.round(duration * 50 / 8));
    const parameters = { max_new_tokens: maxTokens };

    // Prompt für MusicGen: Stil/BPM sauber anhängen (kein Freitext-Injection-Risiko).
    const styleClean = String(style ?? '').replace(/[^\p{L}\p{N}\s\-]/gu, '').trim().slice(0, 80);
    const bpmClean = Number.isFinite(Number(bpm)) && Number(bpm) > 0 ? Math.round(Number(bpm)) : 0;
    const inputs = [
      clean,
      styleClean ? `Style: ${styleClean}` : '',
      bpmClean ? `BPM: ${bpmClean}` : '',
    ].filter(Boolean).join(', ');

    const primary = hfModelFor('music', model);
    const fallback = model ? '' : hfModelFor('musicFallback');
    const candidates = [primary, fallback].filter((m) => m.length > 0);
    let lastError = '';

    // Eigene Runtime (MusicGen im samplemonk-ai) zuerst – HF-Serverless Fallback.
    if (voiceRuntimeUrl()) {
      const runtimeModel = (process.env.VOICE_AI_RUNTIME_SONG_MODEL || 'musicgen-small').trim();
      try {
        const runtimeBuf = await voiceRuntimeInference(
          'song',
          runtimeModel,
          { prompt: inputs, maxDuration: duration },
          240_000,
        );
        return sendWavBuffer(res, runtimeBuf);
      } catch (runtimeErr) {
        lastError = runtimeErr instanceof Error ? runtimeErr.message : 'Unbekannter Fehler';
        console.warn(`[voice] Runtime-Song (${runtimeModel}) fehlgeschlagen, Fallback auf HF:`, lastError);
      }
    }

    for (const candidate of candidates) {
      try {
        const upstream = await hfInference(candidate, inputs, parameters, 120000);
        return await sendHfBlob(res, upstream);
      } catch (err) {
        lastError = err instanceof Error ? err.message : 'Unbekannter Fehler';
        console.warn(`[voice] ${candidate} fehlgeschlagen:`, lastError);
      }
    }
    return res.status(502).json({ error: 'song fehlgeschlagen', detail: lastError || 'Kein Modell verfügbar' });
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

    if (!voiceRuntimeUrl()) {
      return res.status(503).json({ error: 'soundMONK: keine AI-Runtime konfiguriert', hint: 'VOICE_AI_RUNTIME_URL/HF_ENDPOINT_URL oder SONG_AI_ACE_STEP_URL setzen' });
    }
    try {
      const runtimeModel = (process.env.SOUND_AI_RUNTIME_MODEL || 'musicgen-small').trim();
      const runtimeBuf = await voiceRuntimeInference('song', runtimeModel, { prompt: inputs, maxDuration: duration }, 240_000);
      return sendWavBuffer(res, runtimeBuf);
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'Unbekannter Fehler';
      console.warn('[sound] AI-Generierung fehlgeschlagen:', detail);
      return res.status(502).json({ error: 'sound generation fehlgeschlagen', detail });
    }
  });

  // ===========================================================================
  // songMONK: eigener Song-Endpoint (aus VoiceMONK entkoppelt)
  // Backend-Reihenfolge: ACE-Step 1.5 (optional, Vocal-Songs) → eigene
  // Runtime (MusicGen) → HF-Serverless.
  // ===========================================================================
  app.post('/api/song/generate', async (req, res) => {
    // Gleiches Feld-Set wie /api/voice/song -> dasselbe Schema (kein Duplikat).
    const parsedSongGen = VoiceSongSchema.safeParse(req.body ?? {});
    if (!parsedSongGen.success) {
      return res.status(400).json({ error: parsedSongGen.error.issues[0]?.message ?? 'invalid payload' });
    }
    const { prompt, model, durationSeconds, style, bpm } = parsedSongGen.data;
    const clean = cleanVoiceText(prompt);
    if (!clean) return res.status(400).json({ error: 'prompt fehlt' });

    const duration = Math.max(1, Math.min(30, Number(durationSeconds) || 8));
    const maxTokens = Math.max(64, Math.round(duration * 50 / 8));
    const parameters = { max_new_tokens: maxTokens };

    const styleClean = String(style ?? '').replace(/[^\p{L}\p{N}\s\-]/gu, '').trim().slice(0, 80);
    const bpmClean = Number.isFinite(Number(bpm)) && Number(bpm) > 0 ? Math.round(Number(bpm)) : 0;
    const inputs = [
      clean,
      styleClean ? `Style: ${styleClean}` : '',
      bpmClean ? `BPM: ${bpmClean}` : '',
    ].filter(Boolean).join(', ');
    const acePrompt = [clean, styleClean].filter(Boolean).join(', ');

    const primary = hfModelFor('music', model);
    const fallback = model ? '' : hfModelFor('musicFallback');
    const candidates = [primary, fallback].filter((m) => m.length > 0);
    let lastError = '';

    // ACE-Step 1.5 (MIT, komplette Vocal-Songs) – optional per Env aktivierbar.
    if (aceStepBaseUrl()) {
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
        console.warn('[song] ACE-Step fehlgeschlagen, Fallback auf Runtime/HF:', lastError);
      }
    }

    // DiffRhythm 2 (Apache-2.0) – optionaler zweiter Vocal-Song-Backend.
    if (diffRhythmBaseUrl()) {
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
        console.warn('[song] DiffRhythm fehlgeschlagen, Fallback auf Runtime/HF:', lastError);
      }
    }

    // Eigene Runtime zuerst (MusicGen small als Default, Medium später per Env).
    if (voiceRuntimeUrl()) {
      const runtimeModel = (process.env.SONG_AI_RUNTIME_MODEL || 'musicgen-small').trim();
      try {
        const runtimeBuf = await voiceRuntimeInference('song', runtimeModel, { prompt: inputs, maxDuration: duration }, 240_000);
        return sendWavBuffer(res, runtimeBuf);
      } catch (runtimeErr) {
        lastError = runtimeErr instanceof Error ? runtimeErr.message : 'Unbekannter Fehler';
        console.warn(`[song] Runtime-Song (${runtimeModel}) fehlgeschlagen, Fallback auf HF:`, lastError);
      }
    }

    for (const candidate of candidates) {
      try {
        const upstream = await hfInference(candidate, inputs, parameters, 120000);
        return await sendHfBlob(res, upstream);
      } catch (err) {
        lastError = err instanceof Error ? err.message : 'Unbekannter Fehler';
        console.warn(`[song] ${candidate} fehlgeschlagen:`, lastError);
      }
    }
    return res.status(502).json({ error: 'songMONK fehlgeschlagen', detail: lastError || 'Kein Modell verfügbar' });
  });

}
