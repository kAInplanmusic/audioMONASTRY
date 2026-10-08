/**
 * audioMONASTRY · Audio-Graph-Serialisierung (Task 2.1.4 / finale Liste F4)
 * ========================================================================
 * JSON-serialisierbares Audio-Graph-Format für Session-Export/-Import.
 * Enthält alles, was einen hörbaren Zustand vollständig reproduziert:
 * Patterns, Synth-Noten, Mixer-Gains/Pans, Master-Pegel, BPM/Swing/Gate,
 * Tonleiter und Spatial-Setup.
 *
 * Die eigentliche Anwendung erfolgt über `audioEngine.exportGraphState()` /
 * `audioEngine.importGraphState()` – diese Datei liefert Typ + Validierung.
 */

export interface AudioGraphState {
  version: 1;
  bpm: number;
  swing: number;
  gate: number;
  scale: string;
  patterns: Record<string, boolean[]>;
  synthNotes: number[];
  masterVolumeDb: number;
  spatialSetupId: string;
  channelGainsDb: Record<string, number>;
  channelPans: Record<string, number>;
  timestamp: number;
}

const TRACK_KEYS = [
  'channel1', 'channel2', 'channel3', 'channel4',
  'channel5', 'channel6', 'channel7', 'channel8',
];

/** Validiert ein unbekanntes Objekt als AudioGraphState (defensiv). */
export function isAudioGraphState(value: unknown): value is AudioGraphState {
  if (!value || typeof value !== 'object') return false;
  const s = value as Record<string, unknown>;
  if (s.version !== 1) return false;
  if (typeof s.bpm !== 'number' || typeof s.swing !== 'number' || typeof s.gate !== 'number') return false;
  if (typeof s.scale !== 'string') return false;
  if (!s.patterns || typeof s.patterns !== 'object') return false;
  // 16- UND 32-Step-Sessions sind gueltig (setStepCount unterstuetzt beide).
  if (!Array.isArray(s.synthNotes) || (s.synthNotes.length !== 16 && s.synthNotes.length !== 32)) return false;
  // Patterns muessen je Track ein boolean[] mit 16/32 Eintraegen sein.
  for (const arr of Object.values(s.patterns)) {
    if (!Array.isArray(arr) || (arr.length !== 16 && arr.length !== 32)) return false;
  }
  if (typeof s.masterVolumeDb !== 'number' || typeof s.spatialSetupId !== 'string') return false;
  if (!s.channelGainsDb || typeof s.channelGainsDb !== 'object') return false;
  if (!s.channelPans || typeof s.channelPans !== 'object') return false;
  return true;
}

/** Erzeugt einen leeren, gültigen Basis-Graph (Fallback). */
export function emptyAudioGraphState(): AudioGraphState {
  const patterns: Record<string, boolean[]> = {};
  for (const t of TRACK_KEYS) patterns[t] = Array(16).fill(false);
  const channelGainsDb: Record<string, number> = {};
  const channelPans: Record<string, number> = {};
  for (const t of TRACK_KEYS) { channelGainsDb[t] = 0; channelPans[t] = 0; }
  return {
    version: 1,
    bpm: 120,
    swing: 0,
    gate: 0.9,
    scale: 'A Minor Pentatonic',
    patterns,
    synthNotes: Array(16).fill(0),
    masterVolumeDb: -6,
    spatialSetupId: '10.0',
    channelGainsDb,
    channelPans,
    timestamp: Date.now(),
  };
}

export { TRACK_KEYS };
