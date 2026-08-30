/**
 * audioMONASTRY · Buffer-Pooling für Audio-Processing (Schritt 3 Optimierung)
 * ===========================================================================
 * Vermeidet Allokationen im Hot-Path, indem Float32Array-Buffer wiederverwendet
 * werden. Realtime und Offline nutzen denselben Pool.
 */

export interface BufferPoolStats {
  acquired: number;
  released: number;
  size: number;
}

export class BufferPool {
  private free: Float32Array[][] = [];
  private stats: BufferPoolStats = { acquired: 0, released: 0, size: 0 };

  acquire(channels: number, length: number): Float32Array[] {
    this.stats.acquired++;
    const idx = this.free.findIndex((b) => b.length === channels && b[0]?.length === length);
    if (idx >= 0) {
      const buffers = this.free.splice(idx, 1)[0];
      for (const b of buffers) b.fill(0);
      return buffers;
    }
    this.stats.size++;
    return Array.from({ length: channels }, () => new Float32Array(length));
  }

  release(buffers: Float32Array[]): void {
    if (!buffers || buffers.length === 0) return;
    this.stats.released++;
    this.free.push(buffers);
  }

  getStats(): BufferPoolStats {
    return { ...this.stats, size: this.stats.size };
  }

  clear(): void {
    this.free = [];
    this.stats = { acquired: 0, released: 0, size: 0 };
  }
}

export const audioBufferPool = new BufferPool();
