// src/utils/ClockSync.ts
export class ClockSync {
  private offset: number = 0;
  private rtt: number = 0;

  // Perform NTP handshake to measure latency and offset
  public async measureHandshake(sendPing: (payload: any) => void) {
    const start = performance.now();
    sendPing({ type: 'CLOCK_PING', timestamp: start });
  }

  public handlePong(pongTime: number, pingTime: number) {
    const now = performance.now();
    this.rtt = now - pingTime;
    // Estimated offset
    this.offset = (pongTime - pingTime) - (this.rtt / 2);
  }

  /**
   * NTP-artige Auswertung der Serverantwort (Live-Befund 2026-09-19).
   *
   * WARUM NEU: `handlePong` oben mischt zwei Zeitbasen (Peer-Zeit und lokale
   * `performance.now()`) und liefert damit keinen belastbaren Offset. Der
   * Server spiegelt deshalb beide Zeitstempel zurueck, und hier wird die
   * Standardformel gerechnet:
   *
   *   t0 = Sendezeit Client · t1 = Ankunft Server · t2 = Antwort Server ·
   *   t3 = Ankunft Client
   *   rtt    = (t3 - t0) - (t2 - t1)
   *   offset = ((t1 - t0) + (t2 - t3)) / 2   (Serverzeit minus Clientzeit)
   *
   * @returns den neu berechneten Offset (Serverzeit - Clientzeit, in ms)
   */
  public handleServerPong(t0: number, t1: number, t2: number, t3: number): number {
    const rtt = (t3 - t0) - (t2 - t1);
    if (rtt < 0) {
      // Unmoegliche Werte (z. B. Uhr zurueckgesprungen) nicht einrechnen.
      return this.offset;
    }
    this.rtt = rtt;
    this.offset = ((t1 - t0) + (t2 - t3)) / 2;
    return this.offset;
  }

  /** Zuletzt gemessene Umlaufzeit (ms) - Netz + Serververarbeitung. */
  public getRtt(): number {
    return this.rtt;
  }

  public getSyncedTime(): number {
    return performance.now() + this.offset;
  }
}
