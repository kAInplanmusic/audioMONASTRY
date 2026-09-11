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

