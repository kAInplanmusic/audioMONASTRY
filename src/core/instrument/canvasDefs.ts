/**
 * audioMONASTRY · Instrument-Canvas-Definitionen (plattformneutral)
 * ==================================================================
 * Reine Geometrie-/Mapping-Daten für die spielbaren Instrument-Canvases.
 * Keine React-/Canvas-Abhängigkeit → vollständig testbar.
 */

export type InstrumentCanvasKind = 'guitar' | 'theremin' | 'hang' | 'drums';

export interface CanvasZone {
  /** Eindeutige Zone-Id (für Tests/UI). */
  id: string;
  /** MIDI-Note (oder null = Pitch wird dynamisch berechnet). */
  midiNote: number | null;
  /** Relative Bounds 0..1 innerhalb der Canvas. */
  x: number;
  y: number;
  w: number;
  h: number;
  label?: string;
}

export interface CanvasDef {
  kind: InstrumentCanvasKind;
  /** Instrumente, für die diese Canvas-Variante gilt (Namens-Substrings). */
  matches: string[];
  zones: CanvasZone[];
}

/** Gitarre/Harfe/Sitar: 6 Saiten × 5 Bünde (Note steigt mit Bund). */
const STRING_ROOTS = [64, 59, 55, 50, 45, 40]; // E4..E2 (Standard-Tuning)

function guitarZones(): CanvasZone[] {
  const zones: CanvasZone[] = [];
  for (let s = 0; s < STRING_ROOTS.length; s++) {
    for (let f = 0; f < 5; f++) {
      zones.push({
        id: `string${s + 1}-fret${f}`,
        midiNote: STRING_ROOTS[s] + f,
        x: f / 5,
        y: s / STRING_ROOTS.length,
        w: 1 / 5,
        h: 1 / STRING_ROOTS.length,
        label: `S${s + 1}F${f}`,
      });
    }
  }
  return zones;
}

/** Theremin: XY-Fläche, Note wird aus X (tief→hoch) dynamisch berechnet. */
function thereminZones(): CanvasZone[] {
  return Array.from({ length: 12 }, (_, i) => ({
    id: `theremin-${i}`,
    midiNote: null, // dynamisch: 36 + i
    x: i / 12,
    y: 0,
    w: 1 / 12,
    h: 1,
  }));
}

/** Hang/Kalimba: 9 Zonen-Pads (Pentatonik). */
const HANG_NOTES = [48, 52, 55, 57, 60, 64, 67, 69, 72];

function hangZones(): CanvasZone[] {
  return HANG_NOTES.map((note, i) => {
    const col = i % 3;
    const row = Math.floor(i / 3);
    return {
      id: `hang-${i}`,
      midiNote: note,
      x: col / 3,
      y: row / 3,
      w: 1 / 3,
      h: 1 / 3,
      label: `P${i + 1}`,
    };
  });
}

/** Drums: 8 Pads (Kick, Snare, Clap, Hat, Tom×2, Ride, Crash). */
const DRUM_NOTES: { note: number; label: string }[] = [
  { note: 36, label: 'KICK' },
  { note: 38, label: 'SNARE' },
  { note: 39, label: 'CLAP' },
  { note: 42, label: 'HAT' },
  { note: 47, label: 'TOM-L' },
  { note: 50, label: 'TOM-H' },
  { note: 51, label: 'RIDE' },
  { note: 49, label: 'CRASH' },
];

function drumZones(): CanvasZone[] {
  return DRUM_NOTES.map((d, i) => {
    const col = i % 4;
    const row = Math.floor(i / 4);
    return {
      id: `drum-${i}`,
      midiNote: d.note,
      x: col / 4,
      y: row / 2,
      w: 1 / 4,
      h: 1 / 2,
      label: d.label,
    };
  });
}

export const INSTRUMENT_CANVAS_DEFS: CanvasDef[] = [
  { kind: 'guitar', matches: ['guitar', 'banjo', 'ukulele', 'mandolin', 'sitar', 'harp', 'koto', 'erhu', 'bass', 'violin', 'viola', 'cello', 'contrabass'], zones: guitarZones() },
  { kind: 'theremin', matches: ['theremin', 'ondes', 'waterphone', 'otamatone'], zones: thereminZones() },
  { kind: 'hang', matches: ['hang', 'kalimba', 'steel drum', 'glockenspiel', 'marimba', 'vibraphone', 'tubular bells', 'celesta'], zones: hangZones() },
  { kind: 'drums', matches: ['drum', 'perc', 'kick', 'snare', 'clap', 'hat', 'timpani'], zones: drumZones() },
];

/** Wählt die passende Canvas-Definition für einen Instrumentennamen. */
export function canvasDefForInstrument(name: string): CanvasDef | undefined {
  const n = name.toLowerCase();
  return INSTRUMENT_CANVAS_DEFS.find((d) => d.matches.some((m) => n.includes(m)));
}

/** Liefert die Note einer Zone (Theremin: dynamisch aus X-Position). */
export function zoneNote(zone: CanvasZone, xRatio = 0.5): number {
  if (zone.midiNote !== null) return zone.midiNote;
  // Theremin: X 0..1 → MIDI 36..84 (48 Halbtöne).
  const v = Math.max(0, Math.min(1, xRatio));
  return 36 + Math.round(v * 48);
}

/** Findet die Zone an einer relativen Position (x,y in 0..1). */
export function hitZone(def: CanvasDef, x: number, y: number): CanvasZone | undefined {
  return def.zones.find((z) => x >= z.x && x < z.x + z.w && y >= z.y && y < z.y + z.h);
}
