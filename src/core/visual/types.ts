/**
 * audioMONASTRY · VisualMONK – Typen der Echtzeit-Visualisierung
 * =============================================================
 * Die Liveshow läuft als **Shader** (WebGPU/WGSL bzw. WebGL-Fallback) im
 * Renderer und wird von den Audio-Features des laufenden Sets getrieben.
 * Dieser Kern ist bewusst **rein und deterministisch** (keine DOM-/GPU-Nutzung),
 * damit die Audio→Visual-Abbildung ohne Browser testbar ist.
 */

/** Farbpalette als RGB-Quadrupel (r,g,b in 0..1) plus Basisfarbton (Grad). */
interface VisualPalette {
  /** 4–6 Farben, die im Shader interpoliert werden. */
  colors: ReadonlyArray<readonly [number, number, number]>;
  /** Grundfarbton in Grad (0–360), der bei Energie rotiert. */
  hueBase: number;
}

/** Wie stark die einzelnen Audio-Bänder die Bewegung treiben (0..1). */
interface VisualMotion {
  /** Grundrotation in Grad/Sekunde. */
  baseSpin: number;
  /** Zusätzliche Rotation aus den Höhen (Grad/Sekunde bei voller Energie). */
  trebleSpin: number;
  /** Verzerrung aus den Mitten. */
  warp: number;
  /** Farbton-Drift in Grad/Sekunde bei voller Energie. */
  hueSpeed: number;
  /** Grundtempo der Partikel/Felder. */
  flow: number;
}

/** Ein Stil der Liveshow. */
export interface VisualPreset {
  id: string;
  label: string;
  /** Kurzbeschreibung für UI/Tooltip. */
  description: string;
  palette: VisualPalette;
  motion: VisualMotion;
  /** Startregler 0..1 (Zoom, Glow, Sättigung) – werden von Audio übersteuert. */
  base: {
    zoom: number;
    glow: number;
    saturation: number;
    symmetry: number;
  };
}

/** Audio-Features, wie sie der Visual-Layer vom Audio-Graph bekommt (0..1). */
export interface AudioFeatures {
  /** Kick/Bass-Energie (ca. 20–160 Hz). */
  bass: number;
  /** Mitten (ca. 160–2 000 Hz). */
  mid: number;
  /** Höhen (ca. 2 000–16 000 Hz). */
  treble: number;
  /** Gesamtpegel (RMS). */
  rms: number;
  /** Transienten-/Onset-Stärke (0 = ruhig, 1 = harter Schlag). */
  onset: number;
  /** Grobe Energie über alle Bänder. */
  energy: number;
  /** Geschätztes Tempo in BPM (0 = unbekannt). */
  bpm: number;
}

/** Was der Shader pro Frame bekommt. Wird aus Audio + Preset gemappt. */
export interface VisualParams {
  /** Zoom (1 = neutral). */
  zoom: number;
  /** Rotation in Grad. */
  rotation: number;
  /** Verzerrung/Feldwarp 0..1. */
  warp: number;
  /** Farbton in Grad (0–360). */
  hue: number;
  /** Partikel-/Flussgeschwindigkeit. */
  flow: number;
  /** Helligkeit 0..1. */
  brightness: number;
  /** Kontrast 0..1. */
  contrast: number;
  /** Displacement-Amplitude 0..1. */
  displacement: number;
  /** Glow/Blüte 0..1. */
  glow: number;
  /** Symmetrie (Radialspiegel), ganzzahlig ≥ 1. */
  symmetry: number;
}

/** Neutraler Ausgangszustand (Stille). */
export const IDLE_AUDIO_FEATURES: AudioFeatures = {
  bass: 0,
  mid: 0,
  treble: 0,
  rms: 0,
  onset: 0,
  energy: 0,
  bpm: 0,
};
