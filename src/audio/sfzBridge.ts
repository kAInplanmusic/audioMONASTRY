/**
 * audioMONASTRY · SFZ-Voice-Bridge (AUDIO-P1-002 · aus `audioEngine` ausgelagert)
 * =============================================================================
 * Verwaltet SFZ-Instrumente (Sample-Map-Voices) im Realtime-Pfad und den
 * 64-MB-Streaming-Cache für große Samples. Ohne Engine-Zustand: Sample-Rate und
 * V2-Live-Sink werden hereingereicht, die Bank-Factory ist für Tests injizierbar.
 */
import { SfzVoiceBank } from '../core/instrument/sfzVoice';
import { SfzSampleCache, planChunkRanges } from '../core/sampler/sfzStreaming';
import type { V2LiveSink } from '../core/audio/backends/V2LiveSink';
import type { TrackType } from '../types';

export interface SfzBridgeDeps {
  getSampleRate(): number;
  getSink(): V2LiveSink;
  /** Injizierbar für Tests (Default: echter `SfzVoiceBank`). */
  createBank?(sampleRate: number): SfzVoiceBank;
}

/** Zwischenspeicher-Größe des SFZ-Streaming-Caches (Bytes). */
export const SFZ_STREAM_CACHE_BYTES = 64 * 1024 * 1024;

export class SfzBridge {
  private bank: SfzVoiceBank | null = null;
  private v2Channel: TrackType = 'channel4';
  private readonly cache = new SfzSampleCache<Float32Array>(SFZ_STREAM_CACHE_BYTES);

  constructor(private readonly deps: SfzBridgeDeps) {}

  /** Kanal, auf dem das geladene SFZ-Instrument als V2-Quelle läuft. */
  get channel(): TrackType {
    return this.v2Channel;
  }

  /** SFZ-Instrument laden (Text + Sample-Buffer-Map) und als V2-Quelle registrieren. */
  load(sfzText: string, sources: Record<string, Float32Array>, channel: TrackType = 'channel4'): string[] {
    try {
      const bank = this.deps.createBank
        ? this.deps.createBank(this.deps.getSampleRate())
        : new SfzVoiceBank(this.deps.getSampleRate());
      const errors = bank.load(sfzText, sources);
      this.bank = bank;
      this.v2Channel = channel;
      // Phase 3 Rest: SFZ-Bank auch im V2-Sink als Quelle ablegen.
      this.deps.getSink().loadSfzBank(channel, sfzText, sources);
      return errors;
    } catch {
      return ['SFZ konnte nicht geladen werden'];
    }
  }

  noteOn(note: number, velocity = 100): void {
    this.bank?.noteOn(note, velocity);
    this.deps.getSink().sfzNoteOn(this.v2Channel, note, velocity);
  }

  noteOff(note: number): void {
    this.bank?.noteOff(note);
    this.deps.getSink().sfzNoteOff(this.v2Channel, note);
  }

  /** Legt dekomprimierte SFZ-Sample-Daten in den LRU-Cache. */
  cacheSample(key: string, data: Float32Array, bytes: number): void {
    this.cache.put(key, data, bytes);
  }

  /** Holt gecachte SFZ-Sample-Daten (LRU-Reihenfolge wird aufgefrischt). */
  cachedSample(key: string): Float32Array | undefined {
    return this.cache.get(key);
  }

  /** Chunk-Plan für große SFZ-Samples (HTTP-Range + Worker-Decode). */
  planChunks(totalBytes: number, chunkBytes?: number) {
    return planChunkRanges(totalBytes, chunkBytes);
  }
}
