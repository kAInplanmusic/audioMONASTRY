/**
 * audioMONASTRY · PDC-Verzögerungsleitung (C0)
 * =============================================
 * Kompensiert die Laufzeit eines Pfades, damit parallele Pfade phasengleich am
 * Merge ankommen.
 *
 * Warum ein eigener Knoten und kein Bypass-Schalter: Die Kompensation muss den
 * Pfad um eine feste Sample-Zahl verzögern, ohne den Klang zu verändern. Ein
 * `disconnect()` beim Umschalten würde die Latenz ändern und damit das ganze
 * PDC-Modell brechen (Review 2026-10-07, Punkt 6.3).
 *
 * Der Knoten ist bewusst „dumm": er verzögert um `delayFrames` und sonst nichts.
 * Die REGEL, wer wie viel Verzögerung braucht, steht im Vertrag
 * (`pluginContract.ts`: pathLatencyFrames/mergeLatencyFrames/compensationFrames).
 */
import { BaseNode } from './basicNodes';
import { audioBufferPool } from '../BufferPool';
import type { IProcessingContext } from '../types';

export class PdcDelayNode extends BaseNode {
  /** Verzögerung in Samples. 0 = durchreichen (kein Ringpuffer noetig). */
  private delayFrames: number;
  /** Ringpuffer je Kanal; wird bei Aenderung der Verzögerung neu angelegt. */
  private rings: Float32Array[] = [];
  private writePos = 0;
  private channels = 0;

  constructor(id: string, delayFrames = 0) {
    super(id, 'pdc-delay', 1, 1);
    this.delayFrames = Math.max(0, Math.floor(delayFrames));
    this.allocate(2);
  }

  private allocate(channels: number): void {
    this.channels = channels;
    const size = Math.max(1, this.delayFrames);
    this.rings = Array.from({ length: channels }, () => new Float32Array(size));
    this.writePos = 0;
  }

  /**
   * Setzt die Verzögerung. Ändert sich nur die Tiefe, wird der Ringpuffer neu
   * angelegt - ein laufender Umbau würde alte Samples durchschieben und klicken.
   * Der Aufrufer wechselt deshalb an einer Blockgrenze (Plan-Transaktion).
   */
  setDelayFrames(frames: number): void {
    const next = Math.max(0, Math.floor(frames));
    if (next === this.delayFrames) return;
    this.delayFrames = next;
    this.allocate(Math.max(2, this.channels));
  }

  getDelayFrames(): number {
    return this.delayFrames;
  }

  process(ctx: IProcessingContext): void {
    const input = this.inputBuffer(ctx);
    if (!input) {
      this.outputs[0].buffer = null;
      return;
    }
    const len = input[0]?.length ?? ctx.bufferSize;

    // Keine Verzögerung: durchreichen (Kopie, damit der Pool-Vertrag gilt).
    if (this.delayFrames === 0) {
      const out = audioBufferPool.acquire(Math.max(1, input.length), len);
      for (let ch = 0; ch < input.length; ch++) out[ch].set(input[ch].subarray(0, len));
      this.outputs[0].buffer = out;
      return;
    }

    const chans = Math.max(input.length, 1);
    if (this.channels < chans) this.allocate(chans);

    const out = audioBufferPool.acquire(chans, len);
    const size = Math.max(1, this.delayFrames);
    for (let ch = 0; ch < chans; ch++) {
      const ring = this.rings[ch];
      const src = input[ch] ?? input[0];
      const dst = out[ch];
      let w = this.writePos;
      for (let i = 0; i < len; i++) {
        // Lesen einen vollen Ring vor dem Schreiben: bei size == delayFrames
        // kommt damit genau das Signal von vor `delayFrames` Samples.
        const r = (w + size - this.delayFrames) % size;
        dst[i] = ring[r];
        ring[w] = src[i] ?? 0;
        w = (w + 1) % size;
      }
      if (ch === chans - 1) this.writePos = w;
    }
    this.outputs[0].buffer = out;
  }

  reset(): void {
    for (const r of this.rings) r.fill(0);
    this.writePos = 0;
    this.outputs[0].buffer = null;
  }
}
