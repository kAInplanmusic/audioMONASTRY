/**
 * audioMONASTRY · Sequence-/Noten-Helfer
 * ======================================
 * Reine, deterministische Funktionen für Patterns und MIDI-Noten.
 * Kein Audio-Context-/Tone-Zugriff.
 */

export function normalizeSteps(steps: boolean[], count: number): boolean[] {
  if (steps.length === count) return [...steps];
  if (steps.length > count) return steps.slice(0, count);
  return [...steps, ...Array(count - steps.length).fill(false)];
}

export function normalizeNotes(notes: number[], count: number): number[] {
  if (notes.length === count) return [...notes];
  if (notes.length > count) return notes.slice(0, count);
  return [...notes, ...Array(count - notes.length).fill(0)];
}

/** Wandelt einen MIDI-Noten-String (z. B. 'C5') in eine Frequenz um. */
export function noteToFreq(note: string): number {
  const m = /^([A-Ga-g])([#b]?)(-?\d)$/.exec(note);
  if (!m) return 440;
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const semitone = names.indexOf(m[1].toUpperCase() + m[2]);
  if (semitone < 0) return 440;
  const octave = Number.parseInt(m[3], 10);
  const midi = 12 + (octave + 1) * 12 + semitone; // C4=60
  return 440 * Math.pow(2, (midi - 69) / 12);
}
