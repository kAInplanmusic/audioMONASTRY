/**
 * audioMONASTRY · JitterBufferEstimator (AM-E3-4)
 * ================================================
 * Reiner Schätzer für den adaptiven Jitter-Buffer des SFU/WebRTC-Pfads.
 * Liefert empfohlene Buffer-Tiefe (ms) auf Basis des Interarrival-Jitters.
 */

export class JitterBufferEstimator {
  private lastArrivalMs: number | null = null;
  private jitterEma = 0;
  private readonly alpha = 0.2;

  /** RTP-Ankunft melden (timestampMs = Sendezeit, nowMs = Empfangszeit). */
  report(timestampMs: number, nowMs = Date.now()): number {
    const transit = nowMs - timestampMs;
    if (this.lastArrivalMs !== null) {
      const delta = Math.abs(transit - this.lastArrivalMs);
      this.jitterEma = this.alpha * delta + (1 - this.alpha) * this.jitterEma;
    }
    this.lastArrivalMs = transit;
    return this.recommendedBufferMs();
  }

  /** Empfohlene Buffer-Tiefe: 20 ms Basis + 4× Jitter, gedeckelt 20–200 ms. */
  recommendedBufferMs(): number {
    return Math.max(20, Math.min(200, Math.round(20 + this.jitterEma * 4)));
  }

  reset(): void {
    this.lastArrivalMs = null;
    this.jitterEma = 0;
  }
}
