/**
 * audioMONASTRY · 5.2.3/7.2.3 – Failover-Controller (klickfrei)
 * =============================================================
 * Health-Checks + automatische Umschaltung auf Standby. Degradationspfad:
 * Edge → Stereo-Fallback (lokale spatialMath). Nur EIN Pfad ist aktiv –
 * parallele Standby-Summen werden vermieden (Phasenstabilität).
 */
import type { EdgeNode } from './EdgeRouter';
import { edgeRouter } from './EdgeRouter';

export type FailoverState = 'edge-active' | 'switching' | 'stereo-fallback';

export class FailoverController {
  private active: EdgeNode | null = null;
  private state: FailoverState = 'stereo-fallback';
  private _onSwitch: (from: string | null, to: string, state: FailoverState) => void = () => {};
  private heartbeatMs = 2000;
  private timer: ReturnType<typeof setInterval> | null = null;

  onSwitch(cb: (from: string | null, to: string, state: FailoverState) => void): void {
    this._onSwitch = cb;
  }

  start(intervalMs = this.heartbeatMs): void {
    this.stop();
    this.timer = setInterval(() => void this.healthCheck(), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Führt Health-Check + Failover aus (Heartbeat). */
  async healthCheck(): Promise<FailoverState> {
    await edgeRouter.measureLatencies();
    const best = edgeRouter.selectActive();
    if (best && best.id !== this.active?.id) {
      const from = this.active?.id ?? null;
      this.state = 'switching';
      this.active = best;
      this.state = 'edge-active';
      this._onSwitch(from, best.id, this.state);
      return this.state;
    }
    if (!best) {
      if (this.state !== 'stereo-fallback') {
        this.state = 'stereo-fallback';
        this._onSwitch(this.active?.id ?? null, 'stereo', this.state);
      }
      this.active = null;
      return this.state;
    }
    return this.state;
  }

  get currentState(): FailoverState {
    return this.state;
  }

  get activeNode(): EdgeNode | null {
    return this.active;
  }
}

export const failoverController = new FailoverController();
