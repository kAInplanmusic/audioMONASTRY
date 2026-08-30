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

  public getSyncedTime(): number {
    return performance.now() + this.offset;
  }
}
