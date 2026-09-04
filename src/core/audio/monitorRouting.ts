/**
 * audioMONASTRY · Monitor-/Cue-Routing-Policy (P0-6)
 * ==================================================
 * Reine, plattformfreie Berechnung des lokalen Abhörwegs eines Users:
 *
 *   MAIN    → der User hört die fertige Master-Summe (Default).
 *   MON     → der User hört seinen eigenen Cue-Mix (Rollen-Matrix MON1..MON4).
 *   PLUGIN  → Cue-Solo: der User hört ausschließlich den Kanal seines Plugins.
 *
 * D13/P0-6-Regel: Der MAIN-Bus (GLOBAL_MASTER → masterVolume → Mastering →
 * Master-Stream) wird dabei NIE verändert oder getrennt. Umgeschaltet wird
 * ausschließlich der **lokale** Abhörpfad (Main-Monitor-Gain vs. Cue-Gain),
 * damit der Mix für die anderen bis zu 3 User und für den Master-Stream
 * (MASTEROUTMAINSTREAM) unverändert bleibt.
 *
 * Die Funktion ist bewusst rein (keine Web-Audio-Aufrufe), damit der
 * 4-User-Prüfpunkt deterministisch und ohne AudioContext testbar ist.
 */
import { ALL_TRACKS, type TrackType } from '../../types';

export type MonitorSource = 'MAIN' | 'MON' | 'PLUGIN' | 'MIX';
export type MonitorUser = 'MON1' | 'MON2' | 'MON3' | 'MON4';

export const MONITOR_USERS: readonly MonitorUser[] = ['MON1', 'MON2', 'MON3', 'MON4'];

export interface MonitorRoutingInput {
  /** Gewünschte Abhörquelle des lokalen Users. */
  source: MonitorSource;
  /** Cue-Bus des lokalen Users (1 Bus je Session-Teilnehmer). */
  mon: MonitorUser;
  /** Ziel-Kanal des Solo-Plugins (nur für `PLUGIN` relevant). */
  track?: TrackType;
  /** Rollen-/Basis-Cue-Mix des Users (0..2 je Kanal). */
  baseMix: Partial<Record<TrackType, number>>;
  /** Cue-Pegel des Users (0..1, aus `setMonitorGain`). */
  cueLevel?: number;
}

export interface MonitorRoutingPlan {
  source: MonitorSource;
  mon: MonitorUser;
  /** Kanal des Cue-Solos (nur bei `PLUGIN` gesetzt). */
  soloTrack: TrackType | null;
  /** Lokaler Abhörpegel der MAIN-Summe (0..1). */
  mainMonitorGain: number;
  /** Lokaler Abhörpegel des Cue-Busses (0..1). */
  cueGain: number;
  /** Effektive Cue-Matrix (0..2 je Kanal) für den lokalen Cue-Bus. */
  cueTracks: Record<TrackType, number>;
}

const clampMix = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(2, value)) : 1;

const clampLevel = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 1;

/**
 * Berechnet den lokalen Abhörweg. MAIN bleibt als Bus immer unangetastet –
 * geschaltet werden nur die beiden lokalen Abhör-Gains und die Cue-Matrix.
 */
export function planMonitorRouting(input: MonitorRoutingInput): MonitorRoutingPlan {
  const mon = MONITOR_USERS.includes(input.mon) ? input.mon : 'MON1';
  const cueLevel = clampLevel(input.cueLevel ?? 1);
  // PLUGIN = Cue-Solo (nur eigener Kanal), MIX = MAIN + eigener Kanal.
  const soloTrack =
    (input.source === 'PLUGIN' || input.source === 'MIX') && input.track ? input.track : null;

  const cueTracks = {} as Record<TrackType, number>;
  for (const track of ALL_TRACKS) {
    const base = clampMix(input.baseMix?.[track]);
    if (soloTrack) {
      // Cue-Solo: nur der Plugin-Kanal bleibt im Cue hörbar. Ist der Kanal im
      // Rollen-Mix stumm gezogen, wird er für das Solo auf 1 aufgezogen.
      cueTracks[track] = track === soloTrack ? (base > 0 ? base : 1) : 0;
    } else {
      cueTracks[track] = base;
    }
  }

  // Nur der lokale Abhörweg wird umgeschaltet. Der MAIN-Bus selbst behält
  // immer seinen Pegel. MIX lässt den MAIN-Monitor an und blendet den
  // Plugin-Kanal über den Cue-Bus dazu.
  const cueOnly = input.source === 'MON' || input.source === 'PLUGIN';
  const blended = input.source === 'MIX';

  return {
    source: input.source,
    mon,
    soloTrack,
    mainMonitorGain: cueOnly ? 0 : 1,
    cueGain: cueOnly || blended ? cueLevel : 0,
    cueTracks,
  };
}

/** Default-Plan (MAIN) für den Start-Zustand eines Users. */
export function defaultMonitorPlan(mon: MonitorUser = 'MON1'): MonitorRoutingPlan {
  return planMonitorRouting({ source: 'MAIN', mon, baseMix: {} });
}
