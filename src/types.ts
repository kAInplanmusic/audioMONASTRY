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
  | 'channel8';

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

export const ALL_TRACKS: TrackType[] = ['channel1','channel2','channel3','channel4','channel5','channel6','channel7','channel8'];
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
