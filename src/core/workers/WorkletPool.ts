/**
 * audioMONASTRY · 2.1.2 – Worklet-/Prozessor-Pooling (lazy)
 * ==========================================================
 * Wiederverwendbare Pool-Registry für gleichartige Prozessor-Ressourcen.
 * Die AudioWorklet-Nodes selbst leben im Audio-Thread; dieser Pool verwaltet
 * die Main-Thread-Repräsentanten (Node + Port) lazy und mit Cache.
 */
export interface PooledProcessor {
  name: string;
  node: unknown;
  port: { postMessage: (msg: unknown) => void } | null;
  lastUsed: number;
}

export class ProcessorPool {
  private pool = new Map<string, PooledProcessor[]>();
  private inUse = new Set<string>();

  /** Liefert einen freien Prozessor oder erzeugt ihn lazy via factory. */
  acquire<T extends PooledProcessor>(
    kind: string,
    factory: () => T,
  ): T {
    const bucket = this.pool.get(kind) ?? [];
    const existing = bucket.find((p) => !this.inUse.has(this.keyOf(kind, p)));
    if (existing) {
      this.inUse.add(this.keyOf(kind, existing));
      existing.lastUsed = Date.now();
      return existing as T;
    }
    const created = factory();
    bucket.push(created);
    this.pool.set(kind, bucket);
    this.inUse.add(this.keyOf(kind, created));
    return created;
  }

  /** Gibt einen Prozessor zurück in den Pool. */
  release(kind: string, processor: PooledProcessor): void {
    this.inUse.delete(this.keyOf(kind, processor));
    processor.lastUsed = Date.now();
  }

  /** Entfernt ungenutzte Prozessoren älter als `idleMs` (GC-Druck senken). */
  prune(idleMs = 60_000, now = Date.now()): number {
    let removed = 0;
    for (const [kind, bucket] of this.pool) {
      const kept = bucket.filter(
        (p) => this.inUse.has(this.keyOf(kind, p)) || now - p.lastUsed < idleMs,
      );
      removed += bucket.length - kept.length;
      this.pool.set(kind, kept);
    }
    return removed;
  }

  /** Statistik für Monitoring. */
  stats(): { kinds: number; inUse: number } {
    return { kinds: this.pool.size, inUse: this.inUse.size };
  }

  private keyOf(kind: string, p: PooledProcessor): string {
    return `${kind}:${p.name}`;
  }
}

export const processorPool = new ProcessorPool();
