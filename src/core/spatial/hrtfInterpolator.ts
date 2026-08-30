/**
 * audioMONASTRY · 5.1.2 – HRTF-Interpolator (bewegte Quellen)
 * ============================================================
 * Interpoliert HRTF-Parameter (ITD/ILD) zwischen zwei Positionen, damit
 * bewegte Objekte ohne Sprünge (Zipper) klingen.
 */
export interface HrtfPair {
  ildDb: number;
  azimuth: number;
}

export class HrtfInterpolator {
  private current: HrtfPair = { ildDb: 0, azimuth: 0 };
  private target: HrtfPair = { ildDb: 0, azimuth: 0 };
  private steps = 0;
  private count = 0;

  setTarget(target: HrtfPair, rampSamples: number): void {
    this.target = target;
    this.steps = Math.max(1, Math.round(rampSamples));
    this.count = 0;
  }

  /** Liefert den interpolierten Wert für den nächsten Sample-Schritt. */
  next(): HrtfPair {
    if (this.count >= this.steps) {
      this.current = this.target;
      return this.current;
    }
    this.count++;
    const k = this.count / this.steps;
    this.current = {
      ildDb: this.current.ildDb + (this.target.ildDb - this.current.ildDb) * k,
      azimuth: this.current.azimuth + (this.target.azimuth - this.current.azimuth) * k,
    };
    return this.current;
  }
}
