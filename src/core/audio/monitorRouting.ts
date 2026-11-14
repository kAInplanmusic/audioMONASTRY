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
  /** Explicit complete set of locally owned active source channels. Empty means silence. */
  tracks?: readonly TrackType[];
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
  /**
   * UI-2026-11-06-003: Roh-Wert des lokalen Kopfhörer-/Monitorreglers (0..1).
   * Der WIRKSAME Abhörpegel steht in `mainMonitorGain` (Policy × dieser Wert) –
   * so ändert jede Reglerbewegung den Plan-Schlüssel des V2-Sinks und wird
   * tatsächlich gesendet (der Sink dedupliziert über genau diesen Schlüssel).
   * Das Feld ist Diagnose/UI und bewusst NICHT Teil des Session-Plans (jeder
   * User hört seine eigene Lautstärke; Master-Stream bleibt unberührt).
   * Fehlt das Feld (ältere Pläne/Sessions), gilt 1.
   */
  localMonitorGain?: number;
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
  const selected = input.tracks !== undefined ? new Set(input.tracks) : input.track ? new Set([input.track]) : null;
  const scoped = input.source === 'PLUGIN' || input.source === 'MIX';
  const soloTrack = scoped && selected?.size === 1 ? [...selected][0] : null;

  const cueTracks = {} as Record<TrackType, number>;
  for (const track of ALL_TRACKS) {
    const base = clampMix(input.baseMix?.[track]);
    if (scoped && selected !== null) {
      // Cue-Solo: nur der Plugin-Kanal bleibt im Cue hörbar. Ist der Kanal im
      // Rollen-Mix stumm gezogen, wird er für das Solo auf 1 aufgezogen.
      cueTracks[track] = selected.has(track) ? (base > 0 ? base : 1) : 0;
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
    // Routing-Policy ist 0/1; der lokale Hörpegel kommt aus der Facade und
    // multipliziert im V2-Graph (Default hier: volle Lautstärke).
    localMonitorGain: 1,
    cueTracks,
  };
}

/** Default-Plan (MAIN) für den Start-Zustand eines Users. */
export function defaultMonitorPlan(mon: MonitorUser = 'MON1'): MonitorRoutingPlan {
  return planMonitorRouting({ source: 'MAIN', mon, baseMix: {} });
}
