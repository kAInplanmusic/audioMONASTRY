/**
 * audioMONASTRY · Worklet-Knoten mit austauschbarem Prozessor (C1)
 * ===============================================================
 * Ein Kettenglied, das entweder mit einem Referenz-Prozessor (Tests/Offline,
 * `workletSpecs.ts`) oder mit dem echten AudioWorklet-Prozessor laeuft - ohne
 * dass die Verdrahtung sich aendert.
 *
 * Warum ueberhaupt austauschbar: `workletSpecs.ts` liefert bewusst NEUTRALE
 * Referenzen (eq reicht durch, mastering macht nur Soft-Clip). Sie halten die
 * Struktur stabil, klingen aber nicht wie die echten Worklets. Damit beide
 * denselben Graph benutzen, sitzt der Prozessor hinter einer Setter-Methode.
 *
 * Wichtig (Review 6.3): Ein Prozessorwechsel darf NICHT umstecken. Die Ports
 * bleiben, nur die Rechenfunktion wechselt - ein disconnect() wuerde die Latenz
 * aendern und das PDC-Modell brechen.
 */
import { BaseNode } from './basicNodes';
import { audioBufferPool } from '../BufferPool';
import type { IProcessingContext } from '../types';
import type { WorkletProcessFn } from '../backends/WorkletAdapter';

/** Durchreichen: der neutrale Zustand, wenn kein Prozessor gesetzt ist. */
const PASSTHROUGH: WorkletProcessFn = (input, output, ctx) => {
  const src = input[0] ?? [];
  const len = src[0]?.length ?? ctx.bufferSize;
  const chans = Math.max(1, src.length);
  const out = audioBufferPool.acquire(chans, len);
  for (let ch = 0; ch < chans; ch++) {
    if (src[ch]) out[ch].set(src[ch].subarray(0, len));
    else out[ch].fill(0);
  }
  output[0] = out;
};

export class WorkletChainNode extends BaseNode {
  /** Name des gebundenen Prozessors - Beleg der Anbindung. */
  processorName = 'passthrough';
  private processFn: WorkletProcessFn = PASSTHROUGH;

  constructor(id: string, public readonly pluginId: string, inputs = 1, outputs = 1) {
    super(id, `worklet:${pluginId}`, inputs, outputs);
  }

  /**
   * Haengt den Prozessor ein. Die Verkabelung bleibt unveraendert - es wechselt
   * nur die Rechenfunktion. Ein Setter statt eines Konstruktor-Arguments, weil
   * der echte Worklet-Prozessor erst nach dem Laden des AudioWorklet-Moduls
   * verfuegbar ist.
   */
  setProcessFn(fn: WorkletProcessFn, name?: string): void {
    this.processFn = fn;
    this.processorName = name ?? fn.name ?? 'inline';
  }

  process(ctx: IProcessingContext): void {
    const input = this.inputBuffer(ctx);
    if (!input) {
      this.outputs[0].buffer = null;
      return;
    }
    const len = input[0]?.length ?? ctx.bufferSize;
    const out: Float32Array[][] = [audioBufferPool.acquire(2, len)];
    this.processFn([input], out, ctx);
    // Der Prozessor liefert den gepoolten Puffer; ein fehlender Rueckgabewert
    // darf die Kette nicht mit `undefined` vergiften.
    this.outputs[0].buffer = out[0] ?? null;
  }

  reset(): void {
    this.outputs[0].buffer = null;
    this.processFn = PASSTHROUGH;
    this.processorName = 'passthrough';
  }
}
