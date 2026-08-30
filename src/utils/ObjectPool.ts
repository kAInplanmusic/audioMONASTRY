/**
 * audioMONASTRY · 2.2.3 – Objekt-Pool für Hot-Paths
 * ==================================================
 * Wiederverwendbare Objekte/Float32-Puffer, damit Audio-/Render-Hot-Paths
 * keine Allokationen erzeugen (GC-Pausen < 10 ms).
 */
export class ObjectPool<T> {
  private items: T[] = [];
  private factory: () => T;
  private reset: (item: T) => void;

  constructor(factory: () => T, reset: (item: T) => void, prealloc = 0) {
    this.factory = factory;
    this.reset = reset;
    for (let i = 0; i < prealloc; i++) this.items.push(factory());
  }

  acquire(): T {
    return this.items.pop() ?? this.factory();
  }

  release(item: T): void {
    this.reset(item);
    this.items.push(item);
  }

  get size(): number {
    return this.items.length;
  }
}

/** Float32Array-Pool für Puffer fester Länge. */
export function createFloat32Pool(length: number, prealloc = 4): ObjectPool<Float32Array> {
  return new ObjectPool<Float32Array>(
    () => new Float32Array(length),
    (buf) => buf.fill(0),
    prealloc,
  );
}
