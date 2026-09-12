/**
 * audioMONASTRY · Monitor-Routing-Zustand (AUDIO-P1-002 · aus `audioEngine` ausgelagert)
 * ==================================================================================
 * Bündelt den kompletten Cue-/Monitor-Zustand und die Abhör-Policy:
 * Monitor-Pegel, Track-Cue-Matrix, Quelle (MAIN/MON/PLUGIN), DJ-PFL,
 * MAIN-Berechtigung/Freigaben. Nur die Senke (V2-Live-Sink), die
 * Initialisierung und die Monitor-Anzahl werden hereingereicht – kein
 * Engine-Zustand. `audioEngine` delegiert nur noch.
 */
import {
  defaultMonitorPlan,
  planMonitorRouting,
  type MonitorRoutingPlan,
  type MonitorSource,
  type MonitorUser,
} from '../core/audio/monitorRouting';
import type { V2LiveSink } from '../core/audio/backends/V2LiveSink';
import type { TrackType } from '../types';

export interface MonitorRoutingDeps {
  getSink(): V2LiveSink;
  ensureInitialized(): void;
  getCount(): number;
}

const CUE_TRACKS: TrackType[] = [
  'channel1', 'channel2', 'channel3', 'channel4',
  'channel5', 'channel6', 'channel7', 'channel8',
];

/**
 * Standard-Cue-Matrix: jeder Monitor hört alle 8 Spuren; MON2 (Producer) und
 * MON4 (Stem-Host) haben die dokumentierten Rollen-Voreinstellungen.
 */
export function createDefaultMonitorTrackGain(): Record<string, Record<string, number>> {
  const matrix: Record<string, Record<string, number>> = {};
  for (const mon of ['MON1', 'MON2', 'MON3', 'MON4']) {
    const gains: Record<string, number> = {};
    for (const track of CUE_TRACKS) gains[track] = 1;
    if (mon === 'MON2') { gains.channel2 = 0.5; gains.channel6 = 1.2; }
    if (mon === 'MON4') { gains.channel1 = 1.2; gains.channel8 = 1.2; }
    matrix[mon] = gains;
  }
  return matrix;
}

export class MonitorRoutingState {
  private plan: MonitorRoutingPlan = defaultMonitorPlan('MON1');
  private request: { source: MonitorSource; mon: MonitorUser; track?: TrackType } = { source: 'MAIN', mon: 'MON1' };
  private levels: Record<string, number> = { MON1: 1, MON2: 1, MON3: 1, MON4: 1 };
  private trackGain: Record<string, Record<string, number>> = createDefaultMonitorTrackGain();
  private pfl = new Set<TrackType>();
  private mainHolderActive = true;
  private released = new Set<TrackType>();

  constructor(private readonly deps: MonitorRoutingDeps) {}

  /** Gesamtpegel eines Monitors (0..1, 0 = stumm). */
  setMonitorGain(mon: MonitorUser, gain: number): void {
    const v = Number.isFinite(gain) ? Math.max(0, Math.min(1, gain)) : 0;
    this.levels[mon] = v;
    // P0-6: Läuft der lokale User gerade auf diesem Cue-Bus, wirkt der Pegel sofort.
    if (mon === this.plan.mon) this.applyPlan();
  }

  /** Individueller Spur-Pegel (0..2) eines Tracks in einem Monitor-Cue. */
  setMonitorTrackGain(mon: MonitorUser, track: TrackType, gain: number): void {
    const v = Number.isFinite(gain) ? Math.max(0, Math.min(2, gain)) : 0;
    if (this.trackGain[mon]) this.trackGain[mon][track] = v;
    // P0-6: Rollen-/Cue-Änderungen des eigenen Busses sofort hörbar machen.
    if (mon === this.plan.mon) this.applyPlan();
  }

  getMonitorTrackGain(mon: MonitorUser): Record<TrackType, number> {
    return this.trackGain[mon] ?? ({} as Record<TrackType, number>);
  }

  getMonitorConfig(): { count: number; gains: Record<string, number>; tracks: Record<string, Record<string, number>> } {
    return {
      count: this.deps.getCount(),
      gains: { ...this.levels },
      tracks: Object.fromEntries(Object.entries(this.trackGain)),
    };
  }

  getMonitorSource(): MonitorSource {
    return this.plan.source;
  }

  getMonitorRouting(): MonitorRoutingPlan & { wired: boolean; nodeGains: { main: number; cue: number } } {
    return {
      ...this.plan,
      cueTracks: { ...this.plan.cueTracks },
      wired: this.deps.getSink().isConnected,
      nodeGains: { main: this.plan.mainMonitorGain, cue: this.plan.cueGain },
    };
  }

  /**
   * Wählt die Monitor-Quelle des lokalen Users (MAIN/MON/PLUGIN). Der MAIN-Bus
   * inkl. Master-Stream bleibt unverändert; umgeschaltet wird nur der lokale
   * Abhörweg.
   */
  setMonitorSource(mode: MonitorSource, mon: MonitorUser = 'MON1', track?: TrackType): void {
    this.deps.ensureInitialized();
    this.request = { source: mode, mon, track };
    this.applyPlan();
  }

  /** DJ-PFL: Kanal-Vorhören pre-fader auf dem lokalen Cue-Bus. */
  setChannelPfl(track: TrackType, active: boolean): void {
    this.deps.ensureInitialized();
    if (active) this.pfl.add(track);
    else this.pfl.delete(track);
    this.applyPlan();
  }

  getPflTracks(): TrackType[] {
    return [...this.pfl];
  }

  setMainHolderActive(active: boolean): void { this.mainHolderActive = active; }
  isMainHolderActive(): boolean { return this.mainHolderActive; }

  setTrackReleased(track: TrackType, released: boolean): void {
    if (released) this.released.add(track);
    else this.released.delete(track);
  }
  isTrackReleased(track: TrackType): boolean { return this.released.has(track); }

  /** Darf dieser lokale User den Track laden? (DJ immer, andere nur bei Freigabe.) */
  canLoadTrack(track: TrackType): boolean {
    return this.mainHolderActive || this.released.has(track);
  }

  /**
   * Berechnet den Abhörplan neu (reine Policy in `core/audio/monitorRouting`)
   * und überträgt ihn auf den V2-Live-Sink (einziger hörbarer Monitor-Weg).
   */
  applyPlan(): void {
    const req = this.request;
    // DJ-PFL hat Vorrang: solange ein Kanal vorgehört wird, hört der lokale User
    // NUR diese Kanäle (pre-fader). MAIN-Bus/Master-Stream bleiben unverändert.
    const pflMix: Partial<Record<TrackType, number>> = {};
    if (this.pfl.size > 0) this.pfl.forEach((t) => { pflMix[t] = 1; });

    const plan = planMonitorRouting({
      source: this.pfl.size > 0 ? 'MON' : req.source,
      mon: req.mon,
      track: req.track,
      baseMix: this.pfl.size > 0 ? pflMix : (this.trackGain[req.mon] ?? {}),
      cueLevel: this.pfl.size > 0 ? 1 : (this.levels[req.mon] ?? 1),
    });
    this.plan = plan;
    this.deps.getSink().setMonitorRouting(plan);
  }

  /** Aktueller Abhörplan (für Export/Diagnose). */
  getPlan(): MonitorRoutingPlan {
    return this.plan;
  }

  /**
   * Übernimmt einen importierten Session-Monitor-Plan (Quelle + Cue-Matrix des
   * Ziel-Monitors) und wendet ihn an.
   */
  importRoutingPlan(plan: MonitorRoutingPlan & { soloTrack?: TrackType | null }): void {
    this.request = { source: plan.source, mon: plan.mon, track: plan.soloTrack ?? undefined };
    if (this.trackGain[plan.mon]) this.trackGain[plan.mon] = { ...plan.cueTracks };
    this.applyPlan();
  }

  /** Setzt den Abhör-Zustand zurück (dispose) – ohne an die Senke zu publizieren. */
  reset(): void {
    this.request = { source: 'MAIN', mon: 'MON1' };
    this.plan = defaultMonitorPlan('MON1');
    this.pfl.clear();
  }
}
