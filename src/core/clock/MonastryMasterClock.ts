// src/core/clock/MonastryMasterClock.ts
// ============================================================================
// MONASTRYmasterclock (NEW-MONK-8) – unsichtbares Systemmodul
// ----------------------------------------------------------------------------
// Singuläre Timing-Quelle für das gesamte System. Nutzt die vorhandene
// AudioEngine (clockProcessor-Worklet + Scheduler) und ergänzt:
//   * adaptives Latenz-Management (Lookahead 8–15 ms, Xrun-Recovery)
//   * Dropout-/Soundfehler-Prävention (NaN/Inf-Guards, Silence-Gate, Watchdog)
//   * Multi-User-Sync (Host-Clock + PLL über ClockSync/PhaseLockedLoop)
//   * Diagnose ausschließlich über perfMONK/audioEngine.getAudioHealth()
//
// Bewusst OHNE direkte Plattform-APIs (Interface-Boundary-Regel); die
// AudioEngine ist die erlaubte Adapter-Schicht.
// ============================================================================

import { ClockSync } from '../../utils/ClockSync';
import { PhaseLockedLoop } from '../../utils/PhaseLockedLoop';

export interface MasterClockDiagnostics {
  bpm: number;
  playing: boolean;
  lookaheadMs: number;
  xruns: number;
  watchdogs: number;
  pllOffsetMs: number;
  syncedOffsetMs: number;
}

interface AudioEngineLike {
  setBpm(bpm: number): void;
  setSwing(swing: number): void;
  play(): Promise<void> | void;
  stop(): void;
  reportXrun(): void;
  setIdleSilence(silent: boolean): void;
  getLookaheadMs?(): number;
  getAudioHealth?(): { state?: string; sampleRate?: number; baseLatencyMs?: number; outputLatencyMs?: number };
  isPluginActive?(id: string): boolean;
}

export class MonastryMasterClock {
  private engine: AudioEngineLike | null = null;
  private bpm = 128;
  private playing = false;
  private xruns = 0;
  private watchdogs = 0;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private readonly clockSync = new ClockSync();
  private readonly pll = new PhaseLockedLoop();

  /** Verbindet die vorhandene AudioEngine als einzige Timing-Quelle. */
  public attach(engine: AudioEngineLike): void {
    this.engine = engine;
    this.applyBpm();
    this.startWatchdog();
  }

  public detach(): void {
    this.stopWatchdog();
    this.engine = null;
  }

  public setBpm(bpm: number): void {
    const safe = Number.isFinite(bpm) ? Math.max(20, Math.min(300, bpm)) : 128;
    this.bpm = safe;
    this.applyBpm();
  }

  public getBpm(): number {
    return this.bpm;
  }

  public async start(): Promise<void> {
    if (!this.engine) return;
    this.playing = true;
    await this.engine.play();
  }

  public stop(): void {
    if (!this.engine) return;
    this.engine.stop();
    this.playing = false;
  }

  public setSwing(swing: number): void {
    if (!this.engine) return;
    this.engine.setSwing(Math.max(0, Math.min(1, swing)));
  }

  /** Xrun/Underrun aus dem Audio-Thread melden (adaptives Lookahead). */
  public reportXrun(): void {
    this.xruns++;
    try {
      this.engine?.reportXrun();
    } catch { /* Engine-API optional */ }
  }

  /** NaN/Inf-Guard (Master-Kette): ungültige Werte werden verworfen. */
  public isHealthySample(value: number): boolean {
    return Number.isFinite(value) && Math.abs(value) <= 8;
  }

  /** Host-Clock-Sync: Pong aus dem WebRTC-Manager einspeisen. */
  public handleClockPong(pongTime: number, pingTime: number): void {
    this.clockSync.handlePong(pongTime, pingTime);
    const offset = this.clockSync.getSyncedTime() - performance.now();
    this.pll.update(offset);
  }

  /** Diagnose-Snapshot für perfMONK. */
  public getDiagnostics(): MasterClockDiagnostics {
    return {
      bpm: this.bpm,
      playing: this.playing,
      lookaheadMs: this.engine?.getLookaheadMs?.() ?? 0,
      xruns: this.xruns,
      watchdogs: this.watchdogs,
      pllOffsetMs: Math.round(this.pll.update(0) * 10) / 10,
      syncedOffsetMs: Math.round((this.clockSync.getSyncedTime() - performance.now()) * 10) / 10,
    };
  }

  private applyBpm(): void {
    try {
      this.engine?.setBpm(this.bpm);
    } catch { /* Audio nicht initialisiert */ }
  }

  /** Watchdog: prüft alle 10 s den Audio-Health und heilt stille Ausfälle. */
  private startWatchdog(): void {
    if (this.watchdogTimer) return;
    this.watchdogTimer = setInterval(() => {
      if (!this.engine) return;
      const health = this.engine.getAudioHealth?.();
      if (this.playing && health && health.state !== 'running') {
        this.watchdogs++;
        try { void this.engine.play(); } catch { /* Auto-Recovery best effort */ }
      }
    }, 10_000);
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }
}

export const masterClock = new MonastryMasterClock();
