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
 *
 * BYPASS: ebenfalls kein Umstecken. Der Knoten rechnet immer, und das Ergebnis
 * wird mit dem TROCKENEN Eingang ueberblendet. Damit das die Phasenlage nicht
 * verschiebt, laeuft auch der trockene Weg durch die Latenz des nassen Wegs -
 * ein Bypass, der 3 ms frueher ankommt, ist ein Klick, kein Bypass.
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
  /**
   * Nass-Anteil 0..1. 1 = nur der Prozessor, 0 = nur der trockene Weg.
   * Als Zahl und nicht als bool, damit ein Umschalten ueberblenden kann statt
   * zu springen (Review 6.3: klickfrei).
   */
  private wet = 1;

  /**
   * Ausgleichsverzoegerung des trockenen Wegs. Ohne sie kaeme der Bypass
   * frueher an als das verarbeitete Signal - die Summe waere phasenverschoben.
   */
  private dryRing: Float32Array[] = [];
  private dryWrite = 0;
  private dryDelay = 0;
  private dryChannels = 2;

  constructor(id: string, public readonly pluginId: string, inputs = 1, outputs = 1) {
    super(id, `worklet:${pluginId}`, inputs, outputs);
    this.allocateDry(2);
  }

  private allocateDry(channels: number): void {
    this.dryChannels = channels;
    const size = Math.max(1, this.dryDelay);
    this.dryRing = Array.from({ length: channels }, () => new Float32Array(size));
    this.dryWrite = 0;
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

  /** Nass-Anteil 0..1. 0 ist der Bypass - ohne Umstecken, ohne Latenzaenderung. */
  setWet(amount: number): void {
    this.wet = Math.max(0, Math.min(1, amount));
  }

  getWet(): number {
    return this.wet;
  }

  /** Ist der Knoten umgangen (nur trockener Weg)? */
  isBypassed(): boolean {
    return this.wet === 0;
  }

  /**
   * Setzt die Ausgleichsverzoegerung des trockenen Wegs. MUSS der Latenz des
   * nassen Wegs entsprechen, sonst verschiebt der Bypass die Phase.
   */
  setDryDelayFrames(frames: number): void {
    const next = Math.max(0, Math.floor(frames));
    if (next === this.dryDelay) return;
    this.dryDelay = next;
    this.allocateDry(Math.max(2, this.dryChannels));
  }

  getDryDelayFrames(): number {
    return this.dryDelay;
  }

  process(ctx: IProcessingContext): void {
    const input = this.inputBuffer(ctx);
    if (!input) {
      this.outputs[0].buffer = null;
      return;
    }
    const len = input[0]?.length ?? ctx.bufferSize;
    const chans = Math.max(1, input.length);

    // 1) Nass: der Prozessor rechnet IMMER - auch im Bypass. Nur so bleibt die
    //    Latenz des Knotens konstant und ein Umschalten kann ueberblenden.
    const wetOut: Float32Array[][] = [audioBufferPool.acquire(chans, len)];
    this.processFn([input], wetOut, ctx);
    const wetBuf = wetOut[0] ?? input;

    // 2) Voll nass ohne Verzoegerung: direkt ausgeben (nichts zu mischen).
    if (this.wet >= 1 && this.dryDelay === 0) {
      this.outputs[0].buffer = wetBuf;
      return;
    }

    // 3) Trocken durch die Ausgleichsverzoegerung.
    const dry = this.delayedDry(input, len, chans);

    // 4) Ueberblenden. Rechenrisiko: bei wet=1 ist das exakt das nasse Signal.
    const out = audioBufferPool.acquire(chans, len);
    const w = this.wet;
    const d = 1 - w;
    for (let ch = 0; ch < chans; ch++) {
      const wetCh = wetBuf[ch] ?? wetBuf[0];
      const dryCh = dry[ch] ?? dry[0];
      const dst = out[ch];
      for (let i = 0; i < len; i++) {
        dst[i] = (wetCh?.[i] ?? 0) * w + (dryCh?.[i] ?? 0) * d;
      }
    }
    this.outputs[0].buffer = out;
  }

  /** Trockener Weg mit Ausgleichsverzoegerung (0 = unveraenderter Eingang). */
  private delayedDry(input: Float32Array[], len: number, chans: number): Float32Array[] {
    if (this.dryDelay === 0) return input;
    if (this.dryChannels < chans) this.allocateDry(chans);
    const out = audioBufferPool.acquire(chans, len);
    const size = Math.max(1, this.dryDelay);
    for (let ch = 0; ch < chans; ch++) {
      const ring = this.dryRing[ch];
      const src = input[ch] ?? input[0];
      const dst = out[ch];
      let w = this.dryWrite;
      for (let i = 0; i < len; i++) {
        const r = (w + size - this.dryDelay) % size;
        dst[i] = ring[r];
        ring[w] = src?.[i] ?? 0;
        w = (w + 1) % size;
      }
      if (ch === chans - 1) this.dryWrite = w;
    }
    return out;
  }

  reset(): void {
    this.outputs[0].buffer = null;
    this.processFn = PASSTHROUGH;
    this.processorName = 'passthrough';
    this.wet = 1;
    for (const r of this.dryRing) r.fill(0);
    this.dryWrite = 0;
  }
}
