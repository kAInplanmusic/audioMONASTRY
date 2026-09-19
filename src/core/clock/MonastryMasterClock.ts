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
  /** Umlaufzeit der letzten Clock-Messung (ms) - Netz + Serververarbeitung. */
  serverRttMs: number;
  /** Aenderung des Offsets seit der letzten Messung (ms) - Drift, die die PLL glattet. */
  offsetDriftMs: number;
  /** Anzahl erfolgreicher Messungen. */
  syncCount: number;
}

interface AudioEngineLike {
  setBpm(bpm: number): void;
  setSwing(swing: number): void;
  play(): Promise<void> | void;
  stop(): void;
  reportXrun(): void;
  reportStableWindow?(): void;
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
  private serverRttMs = 0;
  private offsetDriftMs = 0;
  private syncCount = 0;
  private lastOffset = 0;
  private lastSyncAt = 0;
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

  /**
   * Wendet eine Clock-Messung an (NTP-Formel, siehe ClockSync.handleServerPong).
   *
   * BEFUND 2026-09-19: die Sync-Kette war vollstaendig vorhanden, aber NIEMAND
   * sendete je einen Ping - `syncCount` blieb 0 und der Offset damit wirkungslos.
   * Jetzt speist der Client jede Serverantwort hier ein; die PLL bekommt die
   * DRIFT (Aenderung seit der letzten Messung), nicht den Absolutwert.
   *
   * @returns den neuen Offset (Serverzeit - Clientzeit, ms)
   */
  public applyServerClock(payload: { t0?: unknown; t1?: unknown; t2?: unknown; t3?: unknown }): number {
    const t0 = Number(payload?.t0);
    const t1 = Number(payload?.t1);
    const t2 = Number(payload?.t2);
    const t3 = Number(payload?.t3);
    if (![t0, t1, t2, t3].every((v) => Number.isFinite(v))) return this.lastOffset;
    const previous = this.lastOffset;
    const offset = this.clockSync.handleServerPong(t0, t1, t2, t3);
    this.lastOffset = offset;
    this.offsetDriftMs = Math.round((offset - previous) * 10) / 10;
    this.serverRttMs = Math.round(this.clockSync.getRtt() * 10) / 10;
    this.syncCount += 1;
    this.lastSyncAt = performance.now();
    if (this.syncCount > 1) {
      this.pll.update(this.offsetDriftMs);
    }
    return offset;
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
      serverRttMs: this.serverRttMs,
      offsetDriftMs: this.offsetDriftMs,
      syncCount: this.syncCount,
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
      } else if (this.playing && health && health.state === 'running') {
        // AM-E6-2: stabile Fenster bauen Xrun-Eskalation langsam wieder ab.
        try { this.engine.reportStableWindow?.(); } catch { /* optional */ }
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
