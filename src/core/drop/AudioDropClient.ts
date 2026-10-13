/**
 * dropMONK – Audio-Drop-Client (DROP-P1-001)
 * ==========================================
 * Client-Seite von `POST /api/ai/drop-audio` (server/dropAudio.ts): der Server
 * erzeugt mit ACE-Step XL Turbo (RP3) einen hoerbaren Drop, legt ihn still in
 * die Bibliothek und liefert ID + URL. Hier:
 *
 *   - `requestAudioDrop`: Aufruf mit Kollaborations-UserId (Lock-Pruefung am
 *     Server), Wiederholung bei `POD_NOT_READY` (Pod startet gerade) mit der
 *     vom Server genannten Wartezeit, klare Fehlermeldung sonst.
 *   - `audioDropProfile`: macht aus dem Ergebnis ein Drop-Profil (Pad unter
 *     „KI & Presets"); das Audio bleibt auf dem Server, das Profil traegt nur
 *     die URL.
 *   - `playAudioDrop`: spielt den Drop ueber den bestehenden Einspiel-Weg des
 *     Drop-Adapters (Sample laden → Event → auf MAIN einblenden), auf Wunsch
 *     an der naechsten vollen Bar (Master-Clock).
 *
 * Kein Browser-Speicher, kein Audio auf dem Geraet (AGENTS.md 2.2).
 */
import { getDropAudioAdapter } from './DropAudioAdapter';
import type { DropProfile, GeneratedDropProfile } from './types/DropProfile';
import { sessionIdentityHeaders } from '../session/sessionIdentity';

export const AUDIO_DROP_ENDPOINT = '/api/ai/drop-audio';

export interface AudioDropRequest {
  prompt: string;
  bpm?: number;
  key?: string;
  bars?: 4 | 8 | 16;
  seed?: number;
  name?: string;
}

export interface AudioDropResult {
  libraryId: string;
  url: string | null;
  name: string;
  format: string;
  bpm: number;
  key: string | null;
  durationSeconds: number;
  seed: number | null;
  model: string;
  steps: number;
  cached: boolean;
  costUsd: number;
}

export class AudioDropError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable: boolean,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'AudioDropError';
  }
}

export interface AudioDropRequestOptions {
  fetchImpl?: typeof fetch;
  /** Wiederholungen bei POD_NOT_READY (Default 2 → hoechstens 3 Versuche). */
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Statusmeldung fuer die UI (z. B. „Pod startet …"). */
  onStatus?: (text: string) => void;
  signal?: AbortSignal;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Tonart fuer den Server. Der Mixer-Stand fuehrt deutsche Namen ("A-Moll",
 * "C#-Dur", "H-Dur"); daraus wird "A minor"/"C# major"/"B major". "Am"/"A minor"
 * bleiben, "–"/leer faellt weg.
 */
export function projectKeyForDrop(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const k = raw.trim();
  const german = /^([A-Ha-h])([#b]?)-(Dur|Moll)$/i.exec(k);
  if (german) {
    const note = german[1].toUpperCase() === 'H' ? 'B' : german[1].toUpperCase();
    return `${note}${german[2]} ${german[3].toLowerCase() === 'moll' ? 'minor' : 'major'}`;
  }
  return /^[A-Ga-g][#b]?\s*(m|min|minor|maj|major)?$/i.test(k) ? k : undefined;
}

export async function requestAudioDrop(req: AudioDropRequest, opts: AudioDropRequestOptions = {}): Promise<AudioDropResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const maxRetries = Math.max(0, opts.maxRetries ?? 2);
  const body: Record<string, unknown> = { prompt: req.prompt };
  if (Number.isFinite(req.bpm)) body.bpm = Math.max(40, Math.min(220, Number(req.bpm)));
  if (req.key) body.key = req.key;
  if (req.bars) body.bars = req.bars;
  if (req.seed !== undefined) body.seed = req.seed;
  if (req.name) body.name = req.name;

  for (let attempt = 0; ; attempt += 1) {
    const res = await doFetch(AUDIO_DROP_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...sessionIdentityHeaders() },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.ok) return data as unknown as AudioDropResult;

    const code = String(data.code ?? `HTTP_${res.status}`);
    const message = String(data.error ?? res.statusText ?? 'Drop-Erzeugung fehlgeschlagen');
    const retryable = data.retryable === true;
    if (code === 'POD_NOT_READY' && retryable && attempt < maxRetries) {
      const waitMs = Math.max(1000, Number(data.retryAfterMs) || 15_000);
      opts.onStatus?.(`Musik-Pod startet – neuer Versuch in ${Math.round(waitMs / 1000)} s (${attempt + 1}/${maxRetries})`);
      await sleep(waitMs);
      if (opts.signal?.aborted) throw new AudioDropError('CANCELLED', 'abgebrochen', false, 0);
      continue;
    }
    throw new AudioDropError(code, message, retryable, res.status);
  }
}

/** Profil mit Audio-Referenz (Pad). Das Audio selbst bleibt auf dem Server. */
export interface AudioDropProfile extends GeneratedDropProfile {
  audio: { url: string; libraryId: string; durationSeconds: number; cached: boolean };
}

export function isAudioDropProfile(profile: DropProfile | null | undefined): profile is AudioDropProfile {
  return !!profile && typeof (profile as Partial<AudioDropProfile>).audio?.url === 'string';
}

export function audioDropProfile(result: AudioDropResult, prompt: string): AudioDropProfile {
  return {
    id: `audio_${result.libraryId}`,
    name: result.name,
    description: `KI-Audio-Drop · ${Math.round(result.bpm)} BPM${result.key ? ` · ${result.key}` : ''} · ${result.durationSeconds} s · ${result.model}`,
    category: 'custom',
    parameterSequence: [],
    buildupTime: 0,
    dropDuration: Math.round(result.durationSeconds * 1000),
    quantization: '1bar',
    tags: ['ai-audio', 'ai-generated', ...(result.cached ? ['cached'] : [])],
    generatedAt: Date.now(),
    aiModel: 'local',
    confidence: 1,
    userPrompt: prompt,
    audio: { url: result.url ?? '', libraryId: result.libraryId, durationSeconds: result.durationSeconds, cached: result.cached },
  };
}

/**
 * Spielt einen Audio-Drop auf einen Mixer-Kanal. `quantized` wartet auf die
 * naechste volle Bar der Master-Clock. Liefert `false`, wenn kein Einspiel-Weg
 * vorhanden ist (Tests/SSR/kein Audio) oder der Kanal ungueltig ist.
 */
export async function playAudioDrop(profile: AudioDropProfile, channelId = 'channel1', quantized = false): Promise<boolean> {
  const adapter = getDropAudioAdapter();
  if (!adapter?.loadTrackSample || !adapter.triggerEvent || !profile.audio.url) return false;
  const loaded = await adapter.loadTrackSample(channelId, profile.audio.url);
  if (!loaded) return false;
  const fire = () => {
    adapter.triggerEvent?.(channelId, 0.9);
    adapter.fadeChannelToMain?.(channelId, 0.05, 0);
  };
  if (quantized && adapter.scheduleAtNextBar) adapter.scheduleAtNextBar(fire);
  else fire();
  return true;
}
