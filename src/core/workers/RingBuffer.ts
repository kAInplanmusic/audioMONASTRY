/**
 * audioMONASTRY · 2.1.1/2.2.4 – Lock-free SPSC-RingBuffer (SharedArrayBuffer)
 * ============================================================================
 * Deterministischer Single-Producer/Single-Consumer-Ring für hochfrequente
 * Kontrollsignale zwischen Audio-Worklet und Main-Thread.
 *
 * Thread-Sicherheit:
 *   - Mit SharedArrayBuffer: head/tail liegen IN der SAB und werden mit
 *     Atomics.store/load publiziert (SeqCst) -> echter SPSC ohne Locks.
 *   - Ohne SharedArrayBuffer (Fallback): funktioniert nur innerhalb eines
 *     Threads; über Threads hinweg ist der Fallback bewusst nicht nutzbar
 *     (Browser ohne COOP/COEP liefern kein SAB).
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- bewusst beibehalten (Runde 3)
export class RingBuffer<T = number> {
  private data: Float64Array;
  /** head/tail als Int32-Sicht auf die letzten 16 Bytes des Puffers. */
  private idx: Int32Array;
  private shared: boolean;
  private readonly cap: number;

  constructor(public readonly capacity: number, shared = false) {
    const cap = Math.max(2, capacity);
    this.cap = cap;
    // Layout: [cap × Float64 Daten][Int32 head][Int32 tail]
    const byteLength = cap * Float64Array.BYTES_PER_ELEMENT + 2 * Int32Array.BYTES_PER_ELEMENT;
    const buf = shared && typeof SharedArrayBuffer !== 'undefined'
      ? new SharedArrayBuffer(byteLength)
      : new ArrayBuffer(byteLength);
    this.shared = buf instanceof SharedArrayBuffer;
    this.data = new Float64Array(buf, 0, cap);
    this.idx = new Int32Array(buf, cap * Float64Array.BYTES_PER_ELEMENT, 2);
    if (!this.shared) {
      this.idx[0] = 0; // head
      this.idx[1] = 0; // tail
    }
  }

  private loadHead(): number {
    return this.shared ? Atomics.load(this.idx, 0) : this.idx[0];
  }
  private loadTail(): number {
    return this.shared ? Atomics.load(this.idx, 1) : this.idx[1];
  }
  private storeHead(v: number): void {
    if (this.shared) Atomics.store(this.idx, 0, v);
    else this.idx[0] = v;
  }
  private storeTail(v: number): void {
    if (this.shared) Atomics.store(this.idx, 1, v);
    else this.idx[1] = v;
  }

  get size(): number {
    return (this.loadHead() - this.loadTail() + this.cap) % this.cap;
  }

  get free(): number {
    return this.cap - 1 - this.size;
  }

  /** Produzent: schreibt einen Wert (liefert false bei Voll). */
  push(value: number): boolean {
    const head = this.loadHead();
    const tail = this.loadTail();
    if ((head + 1) % this.cap === tail) return false;
    this.data[head] = value;
    this.storeHead((head + 1) % this.cap);
    return true;
  }

  /** Konsument: liest einen Wert (liefert undefined bei Leer). */
  pop(): number | undefined {
    const head = this.loadHead();
    const tail = this.loadTail();
    if (head === tail) return undefined;
    const value = this.data[tail];
    this.storeTail((tail + 1) % this.cap);
    return value;
  }

  /** Batch-Push (schneller als Einzel-Push). */
  pushMany(values: ArrayLike<number>): number {
    let written = 0;
    for (let i = 0; i < values.length; i++) {
      if (!this.push(values[i])) break;
      written++;
    }
    return written;
  }

  /** Batch-Pop in ein Ziel-Array. */
  popMany(target: number[], max: number): number {
    let read = 0;
    while (read < max) {
      const v = this.pop();
      if (v === undefined) break;
      target[read++] = v;
    }
    return read;
  }

  clear(): void {
    this.storeHead(0);
    this.storeTail(0);
  }
}
