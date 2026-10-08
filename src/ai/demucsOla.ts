/**
 * audioMONASTRY · Overlap-Add für die Demucs-Stem-Trennung (RT-AUDIT-P2-018)
 * =========================================================================
 * Vorher wurde jedes Segment mit einer linearen Ein-/Ausblende gewichtet – auch
 * am Anfang des ERSTEN und am Ende des LETZTEN Segments, wo kein Nachbar die
 * Rampe ergänzt. Folge: die ersten und letzten ~1,95 s jedes Stems waren
 * ein- bzw. ausgeblendet. Zusätzlich summierten sich die Gewichte im letzten,
 * unregelmäßig überlappenden Segment nicht zu 1.
 *
 * Jetzt:
 *  - Randsegmente haben an der Außenkante Gewicht 1 (keine Rampe ohne Nachbar).
 *  - Jede Probe wird durch die Summe ihrer Gewichte geteilt (exakte Normierung,
 *    unabhängig von Hop/Länge).
 * Rein, ohne Browser-/ONNX-Abhängigkeit – testbar und in einem Worker nutzbar.
 */

/** Gewicht der Probe `i` eines Segments (lineare Rampen nur zu echten Nachbarn). */
export function olaWeight(i: number, segLen: number, ramp: number, isFirst: boolean, isLast: boolean): number {
  if (ramp <= 0) return 1;
  if (!isFirst && i < ramp) return i / ramp;
  if (!isLast && i >= segLen - ramp) return (segLen - i) / ramp;
  return 1;
}

export class DemucsOlaAccumulator {
  /** stems[s][ch] – gewichtete Summen; nach `finalize()` die fertigen Stems. */
  readonly stems: Float32Array[][];
  private readonly weightSum: Float32Array;

  constructor(
    readonly total: number,
    readonly segLen: number,
    readonly ramp: number,
    readonly stemCount = 4,
    readonly channels = 2,
  ) {
    this.stems = Array.from({ length: stemCount }, () => Array.from({ length: channels }, () => new Float32Array(total)));
    this.weightSum = new Float32Array(total);
  }

  /** Anzahl Segmente bei gegebener Hop-Größe (seg − ramp). */
  static chunkCount(total: number, segLen: number, ramp: number): number {
    const hop = Math.max(1, segLen - ramp);
    return Math.max(1, Math.ceil((total - ramp) / hop));
  }

  /**
   * Addiert ein Modell-Ausgabesegment. `outData` hat das Layout
   * `[stem][channel][sample]` (Demucs: `[1, S, 2, seg]`).
   */
  add(offset: number, outData: Float32Array, stemsInOutput: number, isFirst: boolean, isLast: boolean): void {
    const seg = this.segLen;
    const n = Math.min(seg, this.total - offset);
    if (n <= 0) return;
    for (let i = 0; i < n; i++) this.weightSum[offset + i] += olaWeight(i, seg, this.ramp, isFirst, isLast);
    const usable = Math.min(stemsInOutput, this.stemCount);
    for (let s = 0; s < usable; s++) {
      for (let ch = 0; ch < this.channels; ch++) {
        const stem = this.stems[s][ch];
        const base = (s * this.channels + ch) * seg;
        for (let i = 0; i < n; i++) {
          const v = outData[base + i];
          stem[offset + i] += (Number.isFinite(v) ? v : 0) * olaWeight(i, seg, this.ramp, isFirst, isLast);
        }
      }
    }
  }

  /** Teilt jede Probe durch ihr Gesamtgewicht; liefert `stems`. */
  finalize(): Float32Array[][] {
    for (let i = 0; i < this.total; i++) {
      const w = this.weightSum[i];
      const inv = w > 1e-6 ? 1 / w : 0;
      for (const stem of this.stems) for (const ch of stem) ch[i] *= inv;
    }
    return this.stems;
  }
}
