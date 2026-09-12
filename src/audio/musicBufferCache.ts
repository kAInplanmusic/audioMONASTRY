/**
 * audioMONASTRY · Musik-Buffer-Decode-Cache (AUDIO-P1-002, aus `audioEngine`)
 * ==========================================================================
 * WF-2: Lädt/decodiert eine Audio-URL genau **einmal** und cached den Buffer
 * (verhindert Decode-Spikes beim erneuten Laden derselben Datei). Bewusst ohne
 * Tone-/DOM-Import: die Decode-Factory wird hereingereicht und ist damit
 * testbar; `audioEngine` liefert die `Tone.ToneAudioBuffer`-Erzeugung.
 */
export interface MusicBufferCacheDeps<TBuffer> {
  /** Muss `onload(buffer)` ODER `onerror(error)` aufrufen. */
  create(url: string, onload: (buffer: TBuffer) => void, onerror: (error?: unknown) => void): void;
}

export class MusicBufferCache<TBuffer> {
  private readonly cache = new Map<string, TBuffer>();

  constructor(private readonly deps: MusicBufferCacheDeps<TBuffer>) {}

  /** Gecachten oder neu dekodierten Buffer für `url`. */
  async get(url: string): Promise<TBuffer> {
    const cached = this.cache.get(url);
    if (cached) return cached;
    const buffer = await new Promise<TBuffer>((resolve, reject) => {
      this.deps.create(
        url,
        (b) => resolve(b),
        (e) => reject(e ?? new Error(`Audio-Decode fehlgeschlagen: ${url}`)),
      );
    });
    this.cache.set(url, buffer);
    return buffer;
  }

  /** Anzahl gecachter Buffers (Diagnose/Tests). */
  get size(): number {
    return this.cache.size;
  }

  clear(): void {
    this.cache.clear();
  }
}
