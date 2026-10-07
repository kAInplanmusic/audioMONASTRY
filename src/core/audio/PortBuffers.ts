/**
 * audioMONASTRY · Feste Port-Puffer für den Audio-Thread (RT-AUDIT-P0-002)
 * ========================================================================
 * Ersetzt den früheren `BufferPool`: dessen `release()` wurde nirgends
 * aufgerufen, jedes `acquire()` allozierte also neu (46 Arrays pro Block,
 * GC-Pausen bis 9,6 ms im Audio-Thread).
 *
 * Jetzt hält jeder Ausgangsport (bzw. jeder interne Scratch eines Nodes) EINEN
 * Puffersatz. Er wird nur angelegt, wenn sich Kanalzahl oder Blocklänge
 * ändern – im eingeschwungenen Zustand also nie. `process()` schreibt jeden
 * Block in denselben Satz; die Referenzen bleiben über alle Blöcke identisch.
 *
 * Vertrag für Nodes: Ein Puffersatz wird NICHT automatisch geleert. Jeder Node
 * schreibt jedes Sample, das er ausgibt (oder leert bewusst mit `fill(0)`).
 * Ein Node gibt nie den Eingangspuffer eines anderen Nodes als eigenen Ausgang
 * weiter (Fan-out: ein Source-Ausgang geht an Gain UND CueGain) – auch
 * Bypass-Pfade kopieren in den eigenen Port-Puffer.
 */

let allocatedChannels = 0;

/**
 * Liefert `current`, wenn Kanalzahl und Länge passen, sonst einen neuen,
 * genullten Puffersatz. Nur der Neubau alloziert (und wird gezählt).
 */
export function ensureBufferSet(
  current: Float32Array[] | null | undefined,
  channels: number,
  length: number,
): Float32Array[] {
  if (current && current.length === channels && (channels === 0 || current[0].length === length)) {
    return current;
  }
  const next: Float32Array[] = new Array<Float32Array>(channels);
  for (let ch = 0; ch < channels; ch++) next[ch] = new Float32Array(length);
  allocatedChannels += channels;
  return next;
}

/**
 * Anzahl der seit Prozessstart angelegten Port-/Scratch-Kanäle
 * (`audit:rt` RT-AUDIT-P0-002/alloc: Zuwachs pro Block muss 0 sein).
 */
export function getPortBufferAllocations(): number {
  return allocatedChannels;
}

/**
 * Kopiert höchstens `len` Samples von `src` nach `dst` (Länge ≥ `len`) und
 * leert den Rest. Ohne `subarray()` – das legt pro Aufruf eine neue
 * TypedArray-Sicht an.
 */
export function copyChannel(dst: Float32Array, src: Float32Array, len: number): void {
  const n = Math.min(len, src.length);
  if (n === src.length) dst.set(src);
  else for (let i = 0; i < n; i++) dst[i] = src[i];
  if (n < len) dst.fill(0, n);
}

/** Wiederverwendbarer, nie beschriebener Stille-Puffer je Länge (pro Besitzer). */
export class SilenceBuffer {
  private buffer = new Float32Array(0);

  /** Stille der Länge `length` (nur bei geänderter Länge neu angelegt). */
  get(length: number): Float32Array {
    if (this.buffer.length !== length) {
      this.buffer = new Float32Array(length);
      allocatedChannels += 1;
    }
    return this.buffer;
  }
}
