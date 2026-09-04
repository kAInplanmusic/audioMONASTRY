/**
 * audioMONASTRY · SFZ/OPFS-Streaming (Task #3)
 * =============================================
 * Reiner, plattformfreier Kern für große SFZ-Samples:
 *   - `planChunkRanges` teilt eine Dateigröße in chunked Byte-Ranges (für
 *     HTTP-Range-Requests + Worker-Decode).
 *   - `SfzSampleCache` ist ein LRU-Cache mit Byte-Budget (Default 64 MB),
 *     der dekomprimierte Sample-Daten hält und bei Überschreitung die
 *     am längsten unbenutzten Einträge evictiert.
 *
 * Die eigentliche OPFS-Persistenz/`decodeAudioData` bleibt im Adapter
 * (`src/utils/opfs.ts`); dieser Kern ist ohne Browser-APIs testbar.
 */

export interface SfzStreamChunk {
  index: number;
  start: number;
  end: number;
  bytes: number;
}

/** Teilt `totalBytes` in Chunks von max. `chunkBytes` (letzter Chunk kürzer). */
export function planChunkRanges(totalBytes: number, chunkBytes = 1_048_576): SfzStreamChunk[] {
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) return [];
  const size = Math.max(1, Math.floor(chunkBytes));
  const count = Math.ceil(totalBytes / size);
  return Array.from({ length: count }, (_, i) => ({
    index: i,
    start: i * size,
    end: Math.min(totalBytes, (i + 1) * size) - 1,
    bytes: Math.min(size, totalBytes - i * size),
  }));
}

export interface CachedSampleEntry<T = ArrayBuffer> {
  key: string;
  data: T;
  bytes: number;
  lastUsed: number;
}

/** LRU-Cache mit Byte-Budget für dekomprimierte Sample-Daten. */
export class SfzSampleCache<T = ArrayBuffer> {
  private entries = new Map<string, CachedSampleEntry<T>>();
  private totalBytes = 0;

  constructor(public readonly budgetBytes = 64 * 1024 * 1024) {}

  get size(): number { return this.entries.size; }
  get usedBytes(): number { return this.totalBytes; }

  get(key: string): T | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    e.lastUsed = Date.now();
    // LRU-Reihenfolge auffrischen.
    this.entries.delete(key);
    this.entries.set(key, e);
    return e.data;
  }

  put(key: string, data: T, bytes: number): void {
    if (bytes > this.budgetBytes) return; // einzelner Eintrag passt nie → nicht cachen.
    const existing = this.entries.get(key);
    if (existing) {
      this.totalBytes -= existing.bytes;
      this.entries.delete(key);
    }
    const entry: CachedSampleEntry<T> = { key, data, bytes, lastUsed: Date.now() };
    this.entries.set(key, entry);
    this.totalBytes += bytes;
    this.evict();
  }

  /** Entfernt die am längsten unbenutzten Einträge bis ins Budget. */
  evict(): string[] {
    const evicted: string[] = [];
    const ordered = [...this.entries.values()].sort((a, b) => a.lastUsed - b.lastUsed);
    for (const e of ordered) {
      if (this.totalBytes <= this.budgetBytes) break;
      this.entries.delete(e.key);
      this.totalBytes -= e.bytes;
      evicted.push(e.key);
    }
    return evicted;
  }

  clear(): void {
    this.entries.clear();
    this.totalBytes = 0;
  }
}
