/**
 * audioMONASTRY · VoiceMONK Service (TTS + Gesang + Song)
 * ========================================================
 * Generiert aus Text künstliche Sprache, künstlichen Gesang oder komplette
 * Songs (Suno-artig) und legt die Audio-Datei in der Session-Medien-Datenbank
 * ab (für DJ/Plugins abrufbar). Songs werden zusätzlich über die
 * V2-Ausgabe-Bridge in der SpatialScene veröffentlicht.
 */

import { sessionMediaStore, type SessionMediaItem, type ISessionMediaStore } from '../session/SessionMediaStore';
import { random } from '../../utils/random';
import { WebSpeechTtsProvider, type ILiveSpeechProvider } from './WebSpeechTtsProvider';
import { renderMelodyWav, renderVocalWav } from './melody';
import { SongGeneratorService, type ISongGenerator, type SongOptions } from './SongGenerator';
import { type ISongOutputSink, songItemToAudioSource, V2EngineSongSink } from './SongOutputBridge';
import { hfVoiceRequest, isBrowser } from './hfApi';

export interface VoiceOptions {
  gender?: 'male' | 'female';
  character?: 'dark' | 'bright' | 'neutral';
  loudness?: 'soft' | 'normal' | 'loud';
  /** Sprache (z.B. 'de', 'en') für TTS-Provider. */
  language?: string;
  /** Erzwungenes HF-Modell (überschreibt HF_TTS_MODEL). */
  model?: string;
}

export interface ITtsProvider {
  readonly id: string;
  readonly available: boolean;
  synth(text: string, options: VoiceOptions): Promise<Blob>;
}

function baseFrequency(text: string, options: VoiceOptions): number {
  let f = options.gender === 'female' ? 220 : 140;
  if (options.character === 'dark') f *= 0.85;
  if (options.character === 'bright') f *= 1.15;
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  f += (h % 20) - 10;
  return f;
}

/** WAV/PCM-Encoder ohne externe Abhängigkeiten. */
export function encodeWav(samples: Float32Array, sampleRate = 22050): Blob {
  const n = samples.length;
  const buffer = new ArrayBuffer(44 + n * 2);
  const view = new DataView(buffer);
  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + n * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s * 32767, true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

/**
 * Deterministischer Free-Fallback: erzeugt eine echte WAV-Datei (Tonhöhe aus
 * Text + Voice-Optionen). Immer verfügbar, offline, kostenlos.
 */
export class DeterministicTtsProvider implements ITtsProvider {
  readonly id = 'deterministic';
  readonly available = true;

  async synth(text: string, options: VoiceOptions): Promise<Blob> {
    const sr = 22050;
    const seconds = Math.min(6, 0.35 + text.length * 0.05);
    const n = Math.floor(sr * seconds);
    const f = baseFrequency(text, options);
    const loud = options.loudness === 'soft' ? 0.25 : options.loudness === 'loud' ? 0.8 : 0.5;
    const samples = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const env = Math.min(1, t * 20) * Math.min(1, (seconds - t) * 8);
      samples[i] = Math.sin(2 * Math.PI * f * t) * env * loud;
    }
    return encodeWav(samples, sr);
  }
}

/** Hugging Face TTS über den Server-Proxy (Key bleibt serverseitig). */
export class HfTtsProvider implements ITtsProvider {
  readonly id = 'hf';
  get available(): boolean { return isBrowser(); }

  async synth(text: string, options: VoiceOptions): Promise<Blob> {
    return hfVoiceRequest('tts', { text, model: options.model?.trim() || undefined });
  }
}

export interface ISingingProvider {
  readonly id: string;
  readonly available: boolean;
  render(text: string, notes: { lyric: string; midi: number }[], bpm: number): Promise<Blob>;
}

/**
 * Hugging Face Bark (Suno) über den Server-Proxy: beste kostenlose
 * Gesangs-/Stimmen-Synthese. Der Server baut den ♪-Prompt serverseitig.
 */
export class HfBarkSingingProvider implements ISingingProvider {
  readonly id = 'hf-bark';
  get available(): boolean { return isBrowser(); }

  async render(text: string, _notes: { lyric: string; midi: number }[], _bpm: number): Promise<Blob> {
    return hfVoiceRequest('sing', { text });
  }
}

/** Lokaler Gesangs-Fallback: deterministischer Formant-Synth (offline). */
export class LocalFormantSingingProvider implements ISingingProvider {
  readonly id = 'vocal-formant';
  readonly available = true;

  async render(_text: string, notes: { lyric: string; midi: number }[], bpm: number): Promise<Blob> {
    return renderVocalWav(notes, bpm);
  }
}

export interface SpeakResult extends SessionMediaItem {
  provider: string;
}

export class VoiceMonkService {
  private providers: ITtsProvider[] = [];
  private singingProviders: ISingingProvider[] = [];
  private liveProviders: ILiveSpeechProvider[] = [];
  private store: ISessionMediaStore;
  private songService: SongGeneratorService;
  private songOutputSink?: ISongOutputSink;

  constructor(
    store: ISessionMediaStore = sessionMediaStore,
    providers?: ITtsProvider[],
    songService?: SongGeneratorService,
    songOutputSink?: ISongOutputSink,
  ) {
    this.store = store;
    this.songService = songService ?? new SongGeneratorService();
    this.songOutputSink = songOutputSink;
    if (providers && providers.length > 0) {
      for (const provider of providers) this.register(provider);
    } else {
      this.register(new HfTtsProvider());
      this.register(new DeterministicTtsProvider());
    }
    this.registerSingingProvider(new HfBarkSingingProvider());
    this.registerSingingProvider(new LocalFormantSingingProvider());
    this.registerLive(new WebSpeechTtsProvider());
  }

  register(provider: ITtsProvider): void {
    this.providers.push(provider);
  }

  registerSongProvider(provider: ISongGenerator): void {
    this.songService.register(provider);
  }

  registerSingingProvider(provider: ISingingProvider): void {
    this.singingProviders.push(provider);
  }

  registerLive(provider: ILiveSpeechProvider): void {
    this.liveProviders.push(provider);
  }

  /** Live-Vorschau (kein Datei-Export): spricht direkt über das Browser-Device. */
  preview(text: string, options: VoiceOptions = {}): boolean {
    for (const provider of this.liveProviders) {
      if (!provider.available) continue;
      provider.speak(text, options);
      return true;
    }
    return false;
  }

  private async synth(text: string, options: VoiceOptions): Promise<{ blob: Blob; provider: string }> {
    for (const provider of this.providers) {
      if (!provider.available) continue;
      try {
        return { blob: await provider.synth(text, options), provider: provider.id };
      } catch {
        // Nächster Provider.
      }
    }
    throw new Error('Kein TTS-Provider verfügbar.');
  }

  private toAudioUrl(blob: Blob, id: string): string {
    if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
      return URL.createObjectURL(blob);
    }
    return `blob:${id}`;
  }

  /** Text → gesprochene Audio-Datei → Session-Datenbank. */
  async speak(userId: string, text: string, options: VoiceOptions = {}): Promise<SpeakResult> {
    const { blob, provider } = await this.synth(text, options);
    const item: SessionMediaItem = {
      id: `voice-${Date.now().toString(36)}-${random().toString(36).slice(2, 7)}`,
      userId,
      kind: 'tts',
      text,
      audioUrl: this.toAudioUrl(blob, 'tts'),
      mimeType: blob.type || 'audio/wav',
      createdAt: Date.now(),
      metadata: { provider, options },
    };
    this.store.add(item);
    return { ...item, provider };
  }

  /** Lyrics/Melodie → künstlicher Gesang (HF Bark, sonst lokaler Formant-Synth). */
  async sing(userId: string, phrase: { notes: { lyric: string; midi: number }[]; bpm: number }): Promise<SpeakResult> {
    const text = phrase.notes.map((n) => n.lyric).join(' ');
    let blob: Blob | undefined;
    let provider = '';
    for (const p of this.singingProviders) {
      if (!p.available) continue;
      try {
        blob = await p.render(text, phrase.notes, phrase.bpm);
        provider = p.id;
        break;
      } catch {
        // Nächster Provider.
      }
    }
    if (!blob) throw new Error('Kein Gesangs-Provider verfügbar.');
    const item: SessionMediaItem = {
      id: `sing-${Date.now().toString(36)}-${random().toString(36).slice(2, 7)}`,
      userId,
      kind: 'singing',
      text,
      audioUrl: this.toAudioUrl(blob, 'sing'),
      mimeType: blob.type || 'audio/wav',
      createdAt: Date.now(),
      metadata: { provider, phrase },
    };
    this.store.add(item);
    return { ...item, provider };
  }

  /** Text/Prompt → kompletter Song (Suno-artig) → Session-DB + V2-Ausgabe. */
  async generateSong(userId: string, prompt: string, options: SongOptions = {}): Promise<SpeakResult> {
    const { blob, provider } = await this.songService.generate(prompt, options);
    const item: SessionMediaItem = {
      id: `song-${Date.now().toString(36)}-${random().toString(36).slice(2, 7)}`,
      userId,
      kind: 'song',
      text: prompt,
      audioUrl: this.toAudioUrl(blob, 'song'),
      mimeType: blob.type || 'audio/wav',
      createdAt: Date.now(),
      metadata: { provider, options },
    };
    this.store.add(item);
    this.songOutputSink?.publish(songItemToAudioSource(item));
    return { ...item, provider };
  }

  listForUser(userId: string): SessionMediaItem[] {
    return this.store.listByUser(userId);
  }
}

export const voiceMonkService = new VoiceMonkService(
  sessionMediaStore,
  undefined,
  new SongGeneratorService(),
  new V2EngineSongSink(),
);
