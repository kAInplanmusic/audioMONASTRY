// src/utils/LatencyMonitor.ts
import { webRTCManager } from './WebRTCManager';

export class LatencyMonitor {
  private startTime: number = 0;

  public startMeasurement() {
    this.startTime = performance.now();
    webRTCManager.sendToAllPeers({ type: 'LATENCY_PING', timestamp: this.startTime } as any);
  }

  public handlePong(timestamp: number): number {
    const rtt = performance.now() - timestamp;
    // console.log(`Measured RTT Latency: ${rtt.toFixed(2)}ms`);
    return rtt / 2; // One-way latency
  }
}
