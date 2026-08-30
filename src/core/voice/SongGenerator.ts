/**
 * audioMONASTRY · VoiceMONK Song Generator (Suno-artig)
 * =====================================================
 * Text → Musik/Song. Provider-Kette:
 *   1. Hugging Face MusicGen (Server-Proxy /api/voice/song, Key serverseitig)
 *   2. Lokaler Formant-Song-Synth (offline, deterministisch)
 */
import { hfVoiceRequest, isBrowser } from './hfApi';

export interface SongOptions {
  durationSeconds?: number;
  style?: string;
  bpm?: number;
  /** Optionaler HF-Modell-Override (wird serverseitig validiert). */
  model?: string;
}

export interface ISongGenerator {
  readonly id: string;
  readonly available: boolean;
  generate(prompt: string, options?: SongOptions): Promise<Blob>;
}

/** Hugging Face MusicGen über den Server-Proxy (Medium → Small serverseitig). */
export class HfMusicGenProvider implements ISongGenerator {
  readonly id = 'hf-musicgen';

  get available(): boolean {
    return isBrowser();
  }

  async generate(prompt: string, options?: SongOptions): Promise<Blob> {
    return hfVoiceRequest('song', {
      prompt,
      durationSeconds: options?.durationSeconds,
      style: options?.style,
      bpm: options?.bpm,
      model: options?.model,
    });
  }
}

/** Lokaler Fallback: generiert eine Melodie aus dem Prompt-Text. */
export class LocalFormantSongProvider implements ISongGenerator {
  readonly id = 'local-formant-song';

  get available(): boolean {
    return true;
  }

  async generate(prompt: string, options?: SongOptions): Promise<Blob> {
    const { renderVocalWav } = await import('./melody');
    const bpm = options?.bpm ?? 120;
    const words = prompt.split(/\s+/).filter(Boolean).slice(0, 16);
    const notes = words.map((word, i) => ({
      lyric: word,
      midi: 60 + ((i * 7) % 12),
      durationBeats: 1,
    }));
    return renderVocalWav(notes, bpm);
  }
}

export class SongGeneratorService {
  private providers: ISongGenerator[] = [];

  constructor() {
    // Server-Proxy (HF MusicGen) zuerst, dann offline.
    this.register(new HfMusicGenProvider());
    this.register(new LocalFormantSongProvider());
  }

  register(provider: ISongGenerator): void {
    this.providers.push(provider);
  }

  async generate(prompt: string, options?: SongOptions): Promise<{ blob: Blob; provider: string }> {
    for (const provider of this.providers) {
      if (!provider.available) continue;
      try {
        return { blob: await provider.generate(prompt, options), provider: provider.id };
      } catch {
        // Nächster Provider.
      }
    }
    throw new Error('Kein Song-Generator verfügbar.');
  }
}
