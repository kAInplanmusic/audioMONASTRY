/**
 * audioMONASTRY · V2 Terminal Bridge (Phase 7 – UI-Umstellung)
 * ============================================================
 * Zentrale Brücke für Plugin-Terminals/UI auf den Audio-Pfad.
 *
 * Ziel: Terminals sprechen EINE stabile API an. Läuft die Engine im V2-Modus,
 * sorgt die Bridge vor jeder hörbaren Aktion dafür, dass der V1-Zustand in den
 * V2-Graph gespiegelt ist (`syncV2FromV1`). Damit können bestehende Terminals
 * schrittweise auf die V2-Bridge umgestellt werden, ohne jedes Terminal einzeln
 * auf V2-Details zu verdrahten.
 */
import type { TrackType } from '../../../types';
import type { MonitorRoutingPlan, MonitorSource, MonitorUser } from '../monitorRouting';
import type { AudioPlaybackMode } from '../../../utils/v2FeatureFlags';

export interface V2TerminalEngine {
  playbackMode: AudioPlaybackMode;
  setPlaybackMode(mode: AudioPlaybackMode): void;
  syncV2FromV1?(): void;
  play(): Promise<void>;
  stop(): void;
  triggerEvent(track: TrackType, velocity?: number): void;
  setStep(track: TrackType, step: number, on: boolean): void;
  setPattern(track: TrackType, steps: boolean[]): void;
  setBpm(bpm: number): void;
  setSwing(swing: number): void;
  setChannelGain(track: TrackType, gain01: number): void;
  setChannelPan(track: TrackType, pan: number): void;
  setMasterVolume(gain01: number): void;
  setMonitorSource(mode: MonitorSource, mon: MonitorUser, track?: TrackType): void;
}

export class V2TerminalBridge {
  constructor(private readonly engine: V2TerminalEngine) {}

  get mode(): AudioPlaybackMode {
    return this.engine.playbackMode;
  }

  /** Stellt den Pfad um und synchronisiert im V2-Modus den aktuellen Zustand. */
  setMode(mode: AudioPlaybackMode): void {
    this.engine.setPlaybackMode(mode);
    this.ensureV2Sync();
  }

  async play(): Promise<void> {
    this.ensureV2Sync();
    return this.engine.play();
  }

  stop(): void {
    this.engine.stop();
  }

  triggerEvent(track: TrackType, velocity = 1): void {
    this.ensureV2Sync();
    this.engine.triggerEvent(track, velocity);
  }

  setStep(track: TrackType, step: number, on: boolean): void {
    this.ensureV2Sync();
    this.engine.setStep(track, step, on);
  }

  setPattern(track: TrackType, steps: boolean[]): void {
    this.ensureV2Sync();
    this.engine.setPattern(track, steps);
  }

  setBpm(bpm: number): void {
    this.ensureV2Sync();
    this.engine.setBpm(bpm);
  }

  setSwing(swing: number): void {
    this.ensureV2Sync();
    this.engine.setSwing(swing);
  }

  setChannelGain(track: TrackType, gain01: number): void {
    this.ensureV2Sync();
    this.engine.setChannelGain(track, gain01);
  }

  setChannelPan(track: TrackType, pan: number): void {
    this.ensureV2Sync();
    this.engine.setChannelPan(track, pan);
  }

  setMasterVolume(gain01: number): void {
    this.ensureV2Sync();
    this.engine.setMasterVolume(gain01);
  }

  /** Überträgt einen MonitorRoutingPlan (Cue/Main/Monitor) an die Engine. */
  setMonitorRouting(plan: MonitorRoutingPlan): void {
    this.ensureV2Sync();
    this.engine.setMonitorSource(plan.source, plan.mon, plan.soloTrack ?? undefined);
  }

  private ensureV2Sync(): void {
    if (this.engine.playbackMode === 'v2') this.engine.syncV2FromV1?.();
  }
}
