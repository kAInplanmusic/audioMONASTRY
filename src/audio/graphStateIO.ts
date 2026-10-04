/**
 * audioMONASTRY · Graph-State-Serialisierung (aus `audioEngine`, AUDIO-P1-002)
 * ===========================================================================
 * Export und Import des hörbaren Graph-Zustands lagen zuvor als
 * `exportGraphState`/`importGraphState` in der 2.5k-Zeilen-Fassade
 * `utils/audioEngine`. Hier liegt nur noch die Politik: WAS gehört zum hörbaren
 * Zustand und in welcher Reihenfolge wird er wiederhergestellt
 * (BPM → Swing → Gate → Skala → Patterns → Kanal-Gains → Kanal-Pans →
 * Master-Pegel → Spatial-Setup).
 *
 * Bewusst ohne Engine-Zustand: Lese- und Schreibseite werden als schmale Ports
 * hereingereicht (Muster wie `SpatialBus`/`ChannelStripState`). Dadurch ist die
 * Serialisierung ohne AudioContext prüfbar, und die Fassade behält nur ihre
 * Adapter.
 *
 * Verhalten unverändert übernommen: Wertebereiche (BPM 20..300, Swing 0..1,
 * Gate 0.05..1), Skalen-Whitelist, Finitheits-Prüfungen, Ramp-Zeit 0.03 s, der
 * `hasTrack`-Filter (unbekannte Tracks werden übersprungen, der Knoten wird aber
 * VOR dem Ramp angelegt) und der weiche Fehlerpfad (warn + `false`).
 */
import { MUSIC_SCALES, type TrackType } from '../types';
import {
  TRACK_KEYS, isAudioGraphState, type AudioGraphState,
} from '../utils/audioGraphSerialization';

/** Leseseite: der aktuelle hörbare Zustand. */
export interface GraphStateSource {
  bpm(): number;
  swing(): number;
  gate(): number;
  scaleName(): string;
  allPatterns(): Record<string, boolean[]>;
  synthNotes(): number[];
  /** `undefined` = kein Master-Pegel vorhanden (Fallback -6 dB, wie zuvor). */
  masterVolumeDb(): number | undefined;
  spatialSetupId(): string;
  channelGainDb(track: TrackType): number | undefined;
  channelPan(track: TrackType): number | undefined;
}

/** Schreibseite: Zustand wieder anwenden. */
export interface GraphStateSink {
  setBpm(bpm: number): void;
  setSwing(value: number): void;
  setGate(value: number): void;
  setScaleName(name: keyof typeof MUSIC_SCALES): void;
  loadPatterns(patterns: Record<string, boolean[]>, synthNotes: number[], bpm: number): void;
  /** Kennt die Engine diesen Track (Pattern-Eintrag)? */
  hasTrack(track: string): boolean;
  ensureChannelNode(track: TrackType): void;
  rampChannelGainToDb(track: TrackType, db: number, ramp: number): void;
  setChannelPan(track: TrackType, pan: number): void;
  rampMasterVolumeTo(db: number, ramp: number): void;
  setSpatialSetup(id: string): void;
  warn(message: string, cause: unknown): void;
}

/** Serialisiert den hörbaren Zustand als JSON-fähiges Objekt. */
export function readGraphState(src: GraphStateSource): AudioGraphState {
  const channelGainsDb: Record<string, number> = {};
  const channelPans: Record<string, number> = {};
  (TRACK_KEYS as TrackType[]).forEach((track) => {
    channelGainsDb[track] = src.channelGainDb(track) ?? 0;
    channelPans[track] = src.channelPan(track) ?? 0;
  });
  return {
    version: 1,
    bpm: src.bpm(),
    swing: src.swing(),
    gate: src.gate(),
    scale: String(src.scaleName()),
    // Deep-Copy: der Export darf keine Referenz auf lebende Pattern-Arrays tragen.
    patterns: JSON.parse(JSON.stringify(src.allPatterns())) as Record<string, boolean[]>,
    synthNotes: [...src.synthNotes()],
    masterVolumeDb: src.masterVolumeDb() ?? -6,
    spatialSetupId: src.spatialSetupId(),
    channelGainsDb,
    channelPans,
    timestamp: Date.now(),
  };
}

/** Wendet einen exportierten Zustand an. `false` = abgelehnt (ungültig oder Fehler). */
export function applyGraphState(state: AudioGraphState, sink: GraphStateSink): boolean {
  if (!isAudioGraphState(state)) return false;
  try {
    if (Number.isFinite(state.bpm) && state.bpm >= 20 && state.bpm <= 300) {
      sink.setBpm(state.bpm);
    }
    sink.setSwing(Math.max(0, Math.min(1, state.swing)));
    sink.setGate(Math.max(0.05, Math.min(1, state.gate)));
    if (typeof state.scale === 'string' && state.scale in MUSIC_SCALES) {
      sink.setScaleName(state.scale as keyof typeof MUSIC_SCALES);
    }
    // Bewusst der ROHE state.bpm (wie zuvor): `loadPatterns` prüft selbst.
    sink.loadPatterns(state.patterns, state.synthNotes, state.bpm);
    for (const [track, db] of Object.entries(state.channelGainsDb)) {
      if (!sink.hasTrack(track)) continue;
      sink.ensureChannelNode(track as TrackType);
      if (Number.isFinite(db)) sink.rampChannelGainToDb(track as TrackType, db, 0.03);
    }
    for (const [track, pan] of Object.entries(state.channelPans)) {
      if (!sink.hasTrack(track)) continue;
      sink.ensureChannelNode(track as TrackType);
      if (Number.isFinite(pan)) sink.setChannelPan(track as TrackType, pan);
    }
    if (Number.isFinite(state.masterVolumeDb)) sink.rampMasterVolumeTo(state.masterVolumeDb, 0.03);
    if (typeof state.spatialSetupId === 'string') sink.setSpatialSetup(state.spatialSetupId);
    return true;
  } catch (cause) {
    sink.warn('Audio-Graph-Import fehlgeschlagen:', cause);
    return false;
  }
}
