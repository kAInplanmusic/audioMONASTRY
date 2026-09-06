// ============================================================================
// audioMONASTRY – Einheitliches Datenmodell
// ----------------------------------------------------------------------------
// `TrackType` bleibt als Signal-Bus-Codierung (channel1..8) erhalten, damit alle
// bestehenden Presets, Komponenten und die Thread-/Harware-Verkabelung weiter
// funktionieren. ZUSÄTZLICH führen wir die SEMANTISCHEN Rollen ein, die die
// semantische Bedeutung jeder Spur explizit machen (kick, hat, clap, bass, ...).
//
// So werden types.ts, audioEngine.ts, Validatoren, Presets und alle Terminals
// konsistent. Kanal-Nummer → Bus-Index, Rolle → klangerzeugendes Modul.
// ============================================================================

// --- Spur (Bus) als bestehende Codierung ---
export type TrackType =
  | 'channel1'
  | 'channel2'
  | 'channel3'
  | 'channel4'
  | 'channel5'
  | 'channel6'
  | 'channel7'
  | 'channel8'
  | 'channel9'
  | 'channel10';

// Semantische Rollen – legen fest, WELCHE Klangerzeugung pro Spur läuft.
export type TrackRole =
  | 'kick'      // Membran/Punch-Drum        → channel1
  | 'hat'       // Hi-Hat / Metall            → channel2
  | 'clap'      // Klatsche / Noise           → channel3
  | 'perc'      // Percussion / perkussiv     → channel4 (Sampler)
  | 'snare'     // Snare / Stack              → channel5 (Sampler)
  | 'tom'       // Tom / Mids                 → channel6 (Sampler)
  | 'bass'      // Bassline / MonoSynth       → channel7
  | 'lead';     // Lead / Melodie             → channel8 (Sampler/Synth)

export const TRACK_ROLE_MAP: Record<TrackType, TrackRole> = {
  channel1: 'kick',
  channel2: 'hat',
  channel3: 'clap',
  channel4: 'perc',
  channel5: 'snare',
  channel6: 'tom',
  channel7: 'bass',
  channel8: 'lead',
  channel9: 'perc',
  channel10: 'lead',
};

export const ROLE_TO_TRACK: Record<TrackRole, TrackType> = {
  kick: 'channel1',
  hat: 'channel2',
  clap: 'channel3',
  perc: 'channel4',
  snare: 'channel5',
  tom: 'channel6',
  bass: 'channel7',
  lead: 'channel8',
};

export const ALL_TRACKS: TrackType[] = ['channel1','channel2','channel3','channel4','channel5','channel6','channel7','channel8','channel9','channel10'];
export const ALL_ROLES: TrackRole[] = ['kick','hat','clap','perc','snare','tom','bass','lead'];

/** Liefert die Rolle einer Spur. */
export const roleOf = (track: TrackType): TrackRole => TRACK_ROLE_MAP[track];

/** Liefert die Spur zu einer Rolle. */
export const trackOf = (role: TrackRole): TrackType => ROLE_TO_TRACK[role];

/** Ist das eine "Drum-/Perkussions"-Rolle (nicht Bass/Lead)? */
export const isDrumRole = (r: TrackRole) => r === 'kick' || r === 'hat' || r === 'clap' || r === 'perc' || r === 'snare' || r === 'tom';

// --- Patterns (16 Steps) mit semantischer Kompatibilität ---
export interface Patterns {
  channel1: boolean[];
  channel2: boolean[];
  channel3: boolean[];
  channel4: boolean[];
  channel5: boolean[];
  channel6: boolean[];
  channel7: boolean[];
  channel8: boolean[];
}

/** Erzeugt leere Patterns (16 steps je Spur). */
export const emptyPatterns = (): Patterns => ({
  channel1: Array(16).fill(false),
  channel2: Array(16).fill(false),
  channel3: Array(16).fill(false),
  channel4: Array(16).fill(false),
  channel5: Array(16).fill(false),
  channel6: Array(16).fill(false),
  channel7: Array(16).fill(false),
  channel8: Array(16).fill(false),
});

export interface TrackPreset {
  id: string;
  name: string;
  genre: string;
  bpm: number;
  key: string;
  description: string;
  patterns: Patterns;
  synthNotes: number[]; // Index maps to step, value represents pitch index in scale
  cutoff: number;
  resonance: number;
  delayTime: number;
  decay: number;
}

export interface AudioElement {
  id: string;
  name: string;
  type: 'sample' | 'song' | 'noise';
  source: string;
  tags: string[];
  frequency?: number;
  duration?: number;
  url?: string;
  createdAt: string;
}

export interface MotionSequence {
  id: string;
  name: string;
  type: string; // e.g. 'automation', 'rhythm_pattern'
  tags: string[];
  data: any;
  createdAt: string;
}

export const MUSIC_SCALES = {
  'A Minor Pentatonic': ['A2', 'C3', 'D3', 'E3', 'G3', 'A3', 'C4', 'D4'],
  'C Minor (Acid)': ['C2', 'Eb2', 'F2', 'G2', 'Bb2', 'C3', 'Eb3', 'F3'],
  'F# Phrygian': ['F#2', 'G2', 'A#2', 'B2', 'C#3', 'D3', 'E3', 'F#3'],
};

// --- spatialMONK (WhitePaper: Abschnitt 7 Presets & State) ---

export type SpatialQuality = 'low' | 'medium' | 'high';

/** Eine räumlich platzierbare Quelle im spatialMONK-Scene-Modell. */
export interface SpatialSource {
  id: number;
  name: string;
  /** Azimut in Grad: -90 links, 0 vorne, +90 rechts. */
  az: number;
  /** Elevation in Grad (aktuell analytisch, HRTF folgt). */
  el: number;
  /** Distanz (≥ 0), steuert Dämpfung + Distanz-Lowpass. */
  dist: number;
  /** Quell-Gain 0..1.5. */
  gain: number;
  muted: boolean;
  /** UI-Farbe (optional, sonst automatisch). */
  color?: string;
  /** Optionale Spur-Kopplung für den Legacy-Audio-Pfad. */
  track?: TrackType;
}

export interface SpatialGlobalState {
  quality: SpatialQuality;
  listenerRot: number;
  masterGain: number;
  hrtf: string;
  /** Ausgabe-Layout (SPATIAL_SETUPS-ID, z. B. '2.0', '4.1', '24.2'). */
  layout?: string;
}

export interface SpatialSceneState {
  version: 'spatialMONK-v1';
  global: SpatialGlobalState;
  sources: SpatialSource[];
}

/** Migriert ein altes Spatial-Monk-Preset auf das neue Scene-Format. */
export function migrateLegacySpatialPreset(old: any): SpatialSceneState {
  const legacySources = Array.isArray(old?.sources) ? old.sources : Array.isArray(old?.nodes) ? old.nodes : [];
  const sources: SpatialSource[] = legacySources.map((s: any, i: number) => ({
    id: Number(s?.id ?? i + 1),
    name: String(s?.name ?? s?.label ?? `Quelle ${i + 1}`),
    az: Number(s?.az ?? (typeof s?.x === 'number' ? s.x * 90 : 0)),
    el: Number(s?.el ?? 0),
    dist: Number(s?.dist ?? (typeof s?.y === 'number' ? Math.max(0.2, 1.2 - s.y * 0.6) : 1.2)),
    gain: Number(s?.gain ?? s?.volume ?? 0.9),
    muted: Boolean(s?.muted ?? !s?.active),
    color: s?.color,
  }));
  return {
    version: 'spatialMONK-v1',
    global: {
      quality: old?.global?.quality === 'high' || old?.global?.quality === 'medium' ? old.global.quality : 'medium',
      listenerRot: Number(old?.global?.listenerRot ?? 0),
      masterGain: Number(old?.global?.masterGain ?? old?.masterGain ?? 1),
      hrtf: String(old?.global?.hrtf ?? 'default'),
      layout: String(old?.global?.layout ?? old?.setup ?? '10.0'),
    },
    sources,
  };
}
