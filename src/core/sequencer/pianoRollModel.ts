/**
 * audioMONASTRY · Piano-Roll-Modell (ZUK-001)
 * ===========================================
 * Reines, deterministisches Notenmodell für den Piano-Roll-Editor: Noten
 * anlegen/entfernen, Quantisieren, Transponieren, Längen ändern, Velocity-Spur
 * und Akkord-Stempel – plus Ghost-Noten (read-only Projektion fremder Spuren).
 *
 * Bewusst KEIN DOM-, Canvas-, WebAudio- oder React-Zugriff: das Modell rechnet
 * nur auf Ticks/Pitches und ist damit offline testbar. Die Abbildung
 * Tick → Spalte/Pixel macht ausschließlich die View
 * (`src/components/piano/PianoRoll.tsx`).
 *
 * Zeitbasis: 960 Ticks pro Viertelnote (`TICKS_PER_QUARTER`), also 240 Ticks
 * pro 16tel. Jede Funktion ist pur – sie gibt ein NEUES Array zurück und
 * verändert die Eingabe nie.
 *
 * Rand-Semantik (bewusst so entschieden, weil ein Editor nie Noten verlieren
 * darf): Pitch wird auf 0…127 geklemmt, Velocity auf 0…127, Start-Ticks auf
 * >= 0, Länge auf >= 1 Tick. Gruppen-Operationen (`moveNotes`,
 * `transposeNotes`) klemmen den Delta EINMAL für die ganze Auswahl, damit
 * Akkord-Intervalle an der Tastaturgrenze nicht zusammenfallen.
 */

/** Ticks pro Viertelnote (durchgängige Auflösung des Modells). */
export const TICKS_PER_QUARTER = 960;

/** Ticks pro 16tel – entspricht einer Rasterspalte im Editor. */
export const TICKS_PER_16TH = TICKS_PER_QUARTER / 4;

/** Kleinster MIDI-Pitch (C-1). */
export const MIN_PITCH = 0;

/** Größter MIDI-Pitch (G9). */
export const MAX_PITCH = 127;

/** Kleinste Velocity (Note-On mit Velocity 0 ist im MIDI-Datenmodell erlaubt). */
export const MIN_VELOCITY = 0;

/** Größte Velocity. */
export const MAX_VELOCITY = 127;

/** Kürzeste Note, die das Modell zulässt (nie 0 – sonst wäre sie unhörbar/unsichtbar). */
export const MIN_NOTE_LENGTH_TICKS = 1;

/** Standard-Velocity für neu angelegte Noten. */
export const DEFAULT_VELOCITY = 100;

/** Standard-Länge für neu angelegte Noten (ein 16tel). */
export const DEFAULT_NOTE_LENGTH_TICKS = TICKS_PER_16TH;

/** Akkord-Qualitäten des Stempels. */
export type ChordQuality = 'major' | 'minor' | '7' | 'dim';

/** Halbton-Intervalle je Akkord-Qualität (Grundton = 0). */
export const CHORD_INTERVALS: Readonly<Record<ChordQuality, readonly number[]>> = {
  major: [0, 4, 7],
  minor: [0, 3, 7],
  '7': [0, 4, 7, 10],
  dim: [0, 3, 6],
};

/**
 * Eine Note der editierbaren Spur.
 * `ghost: true` markiert eine read-only Projektion (siehe `GhostNote`); alle
 * Mutatoren überspringen solche Einträge, damit eine versehentlich gemischte
 * Liste keine fremden Noten verändert.
 */
export interface PianoRollNote {
  id: string;
  /** MIDI-Pitch, 0…127. */
  pitch: number;
  /** Start in Ticks ab Taktanfang, >= 0. */
  startTicks: number;
  /** Länge in Ticks, >= 1. */
  lengthTicks: number;
  /** Anschlagstärke, 0…127. */
  velocity: number;
  /** Auswahl-Zustand für Gruppen-Operationen (nur im Editor relevant). */
  selected: boolean;
  /** true = Projektion aus einer anderen Spur (nie editierbar). */
  ghost?: boolean;
}

/** Eingabe für `normalizeNote` – die Id ist Pflicht, damit sie stabil bleibt. */
export interface NoteInit {
  id: string;
  pitch: number;
  startTicks: number;
  lengthTicks?: number;
  velocity?: number;
  selected?: boolean;
}

/** Eingabe für `addNote`: Id wird bei Bedarf aus dem Bestand abgeleitet. */
export interface NoteInput {
  id?: string;
  pitch: number;
  startTicks: number;
  lengthTicks?: number;
  velocity?: number;
  selected?: boolean;
}

/** Read-only Projektion einer Note aus einer anderen Spur. */
export interface GhostNote extends Omit<PianoRollNote, 'ghost' | 'selected'> {
  readonly ghost: true;
  readonly readOnly: true;
  readonly selected: false;
  /** Spur, aus der die Note projiziert wurde. */
  readonly sourceTrackId: string;
}

/** Eine Spur, aus der Ghost-Noten projiziert werden. */
export interface PianoRollTrack {
  readonly trackId: string;
  readonly notes: readonly PianoRollNote[];
}

/** Optionen für `projectGhostNotes`. */
export interface GhostProjectionOptions {
  /** Eigene (bearbeitete) Spur – wird nicht projiziert. */
  excludeTrackId?: string;
  /** Nur Noten, die dieses Fenster schneiden (inklusive). */
  fromTicks?: number;
  /** Nur Noten, die dieses Fenster schneiden (exklusive). */
  toTicks?: number;
}

/** Optionen für `moveNotes`. */
export interface MoveNotesOptions {
  deltaTicks: number;
  deltaPitch: number;
  /** Ziel-Ids; ohne Angabe gilt die gesamte (editierbare) Notenliste. */
  ids?: readonly string[];
}

/** Optionen für `quantizeNotes`. */
export interface QuantizeOptions {
  /** Ziel-Ids; ohne Angabe gilt die gesamte (editierbare) Notenliste. */
  ids?: readonly string[];
  /** Länge ebenfalls auf das Raster ziehen (Default: false, nur der Start). */
  quantizeLength?: boolean;
}

/** Optionen für den Akkord-Stempel. */
export interface ChordStampOptions {
  quality: ChordQuality;
  /** Grundton des Akkords (wird auf 0…127 geklemmt). */
  rootPitch: number;
  startTicks: number;
  velocity?: number;
  lengthTicks?: number;
}

/** Erlaubter Transpositions-Bereich für eine Auswahl. */
export interface TransposeRange {
  min: number;
  max: number;
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;
const BLACK_KEY_OFFSETS = new Set([1, 3, 6, 8, 10]);
const NOTE_ID_PATTERN = /^note-(\d+)$/;

/** Klemmt einen Pitch auf 0…127 (gerundet; Nicht-Zahlen landen auf 0). */
export function clampPitch(pitch: number): number {
  if (!Number.isFinite(pitch)) return MIN_PITCH;
  return Math.min(MAX_PITCH, Math.max(MIN_PITCH, Math.round(pitch)));
}

/** Klemmt eine Velocity auf 0…127 (gerundet; Nicht-Zahlen auf `DEFAULT_VELOCITY`). */
export function clampVelocity(velocity: number): number {
  if (!Number.isFinite(velocity)) return DEFAULT_VELOCITY;
  return Math.min(MAX_VELOCITY, Math.max(MIN_VELOCITY, Math.round(velocity)));
}

/** Klemmt einen Start-Tick auf >= 0 (gerundet; Nicht-Zahlen auf 0). */
export function clampStartTicks(startTicks: number): number {
  if (!Number.isFinite(startTicks)) return 0;
  return Math.max(0, Math.round(startTicks));
}

/** Klemmt eine Länge auf >= 1 Tick (gerundet; Nicht-Zahlen auf das Minimum). */
export function clampLengthTicks(lengthTicks: number): number {
  if (!Number.isFinite(lengthTicks)) return MIN_NOTE_LENGTH_TICKS;
  return Math.max(MIN_NOTE_LENGTH_TICKS, Math.round(lengthTicks));
}

/** Baut aus einer Eingabe eine gültige Note (klemmt Pitch/Velocity/Zeiten). */
export function normalizeNote(init: NoteInit): PianoRollNote {
  return {
    id: init.id,
    pitch: clampPitch(init.pitch),
    startTicks: clampStartTicks(init.startTicks),
    lengthTicks: clampLengthTicks(init.lengthTicks ?? DEFAULT_NOTE_LENGTH_TICKS),
    velocity: clampVelocity(init.velocity ?? DEFAULT_VELOCITY),
    selected: init.selected === true,
  };
}

/**
 * Nächste freie Noten-Id aus dem Bestand (`note-<n>`), deterministisch und pur –
 * damit Tests reproduzierbar bleiben. Fremde Id-Formen (z. B. `ghost:…`) zählen nicht.
 */
export function nextNoteId(notes: readonly { id: string }[]): string {
  let max = 0;
  for (const note of notes) {
    const match = NOTE_ID_PATTERN.exec(note.id);
    if (!match) continue;
    const value = Number(match[1]);
    if (value > max) max = value;
  }
  return `note-${max + 1}`;
}

/** Notenname eines Pitches, z. B. 60 → "C4", 127 → "G9". */
export function noteName(pitch: number): string {
  const clamped = clampPitch(pitch);
  return `${NOTE_NAMES[clamped % 12]}${Math.floor(clamped / 12) - 1}`;
}

/** true für die schwarzen Tasten (für die Raster-Darstellung). */
export function isBlackKey(pitch: number): boolean {
  return BLACK_KEY_OFFSETS.has(((pitch % 12) + 12) % 12);
}

/** Gesamt-Ticks einer Spaltenanzahl (Spalte = 16tel). */
export function ticksForColumns(columns: number, ticksPerColumn: number = TICKS_PER_16TH): number {
  if (!Number.isFinite(columns) || columns <= 0) return 0;
  return Math.round(columns) * ticksPerColumn;
}

/** Zieht einen Tick auf das nächste Raster (kaufmännisch gerundet). */
export function snapTickToGrid(tick: number, gridTicks: number): number {
  const grid = Math.max(1, Math.round(gridTicks));
  return Math.round(clampStartTicks(tick) / grid) * grid;
}

/** Kopie der Liste, sortiert nach Start, Pitch, Länge und Id (stabil/deterministisch). */
export function sortNotes(notes: readonly PianoRollNote[]): PianoRollNote[] {
  return [...notes].sort((a, b) => {
    if (a.startTicks !== b.startTicks) return a.startTicks - b.startTicks;
    if (a.pitch !== b.pitch) return a.pitch - b.pitch;
    if (a.lengthTicks !== b.lengthTicks) return a.lengthTicks - b.lengthTicks;
    if (a.id === b.id) return 0;
    return a.id < b.id ? -1 : 1;
  });
}

/** Noten, die den Zeitraum [fromTicks, toTicks) schneiden. */
export function notesOverlapping(
  notes: readonly PianoRollNote[],
  fromTicks: number,
  toTicks: number,
): PianoRollNote[] {
  const from = Math.min(fromTicks, toTicks);
  const to = Math.max(fromTicks, toTicks);
  return notes.filter((note) => note.startTicks < to && note.startTicks + note.lengthTicks > from);
}

/** Nur die ausgewählten Noten. */
export function selectedNotes(notes: readonly PianoRollNote[]): PianoRollNote[] {
  return notes.filter((note) => note.selected === true);
}

/**
 * Note an einer Rasterposition (Hit-Test für Klick/Drag). Liegt mehr als eine
 * Note unter dem Punkt, gewinnt die letzte (= zuletzt gezeichnete/oberste).
 */
export function findNoteAt(
  notes: readonly PianoRollNote[],
  tick: number,
  pitch: number,
): PianoRollNote | null {
  let found: PianoRollNote | null = null;
  for (const note of notes) {
    if (note.ghost === true || note.pitch !== pitch) continue;
    if (tick >= note.startTicks && tick < note.startTicks + note.lengthTicks) found = note;
  }
  return found;
}

/** Legt eine Note an (Id automatisch, sofern nicht übergeben) und sortiert. */
export function addNote(notes: readonly PianoRollNote[], input: NoteInput): PianoRollNote[] {
  const note = normalizeNote({ ...input, id: input.id ?? nextNoteId(notes) });
  return sortNotes([...notes, note]);
}

/** Entfernt Noten anhand ihrer Ids (unbekannte Ids werden ignoriert). */
export function removeNotes(notes: readonly PianoRollNote[], ids: readonly string[]): PianoRollNote[] {
  if (ids.length === 0) return [...notes];
  const remove = new Set(ids);
  return notes.filter((note) => note.ghost === true || !remove.has(note.id));
}

/** Ändert Felder einer Note; alle Werte werden erneut geklemmt. */
export function updateNote(
  notes: readonly PianoRollNote[],
  id: string,
  patch: Partial<Pick<PianoRollNote, 'pitch' | 'startTicks' | 'lengthTicks' | 'velocity' | 'selected'>>,
): PianoRollNote[] {
  const next = notes.map((note) => {
    if (note.ghost === true || note.id !== id) return note;
    return normalizeNote({
      id: note.id,
      pitch: patch.pitch ?? note.pitch,
      startTicks: patch.startTicks ?? note.startTicks,
      lengthTicks: patch.lengthTicks ?? note.lengthTicks,
      velocity: patch.velocity ?? note.velocity,
      selected: patch.selected ?? note.selected,
    });
  });
  return sortNotes(next);
}

/** Markiert genau die übergebenen Ids (oder erweitert die Auswahl bei `additive`). */
export function selectNotes(
  notes: readonly PianoRollNote[],
  ids: readonly string[],
  additive = false,
): PianoRollNote[] {
  const select = new Set(ids);
  return sortNotes(
    notes.map((note) => {
      if (note.ghost === true) return note;
      const selected = select.has(note.id) || (additive && note.selected === true);
      return note.selected === selected ? note : normalizeNote({ ...note, selected });
    }),
  );
}

/** Hebt die Auswahl vollständig auf. */
export function clearSelection(notes: readonly PianoRollNote[]): PianoRollNote[] {
  return sortNotes(notes.map((note) => (note.selected ? normalizeNote({ ...note, selected: false }) : note)));
}

/**
 * Verschiebt Noten in Zeit und Tonhöhe. Das Delta wird EINMAL für die ganze
 * Auswahl geklemmt (Start >= 0, Pitch 0…127), damit Akkorde ihre Intervalle
 * behalten und an der Tastaturgrenze nicht zusammenfallen.
 */
export function moveNotes(
  notes: readonly PianoRollNote[],
  options: MoveNotesOptions,
): PianoRollNote[] {
  const targetIds = options.ids ? new Set(options.ids) : null;
  const targets = notes.filter(
    (note) => note.ghost !== true && (targetIds === null || targetIds.has(note.id)),
  );
  if (targets.length === 0) return [...notes];

  const minStart = Math.min(...targets.map((note) => note.startTicks));
  const minPitch = Math.min(...targets.map((note) => note.pitch));
  const maxPitch = Math.max(...targets.map((note) => note.pitch));

  const wantedTicks = Number.isFinite(options.deltaTicks) ? Math.round(options.deltaTicks) : 0;
  const wantedPitch = Number.isFinite(options.deltaPitch) ? Math.round(options.deltaPitch) : 0;
  const deltaTicks = Math.max(wantedTicks, -minStart);
  const deltaPitch = Math.min(Math.max(wantedPitch, -minPitch), MAX_PITCH - maxPitch);
  if (deltaTicks === 0 && deltaPitch === 0) return [...notes];

  const moved = new Set(targets.map((note) => note.id));
  return sortNotes(
    notes.map((note) => {
      if (note.ghost === true || !moved.has(note.id)) return note;
      return normalizeNote({
        ...note,
        startTicks: note.startTicks + deltaTicks,
        pitch: note.pitch + deltaPitch,
      });
    }),
  );
}

/** Setzt die Länge einer Note absolut (Minimum 1 Tick). */
export function resizeNote(
  notes: readonly PianoRollNote[],
  id: string,
  lengthTicks: number,
): PianoRollNote[] {
  return updateNote(notes, id, { lengthTicks });
}

/** Ändert die Länge aller Ziel-Noten relativ (Minimum 1 Tick). */
export function resizeNotes(
  notes: readonly PianoRollNote[],
  deltaTicks: number,
  ids?: readonly string[],
): PianoRollNote[] {
  const targetIds = ids ? new Set(ids) : null;
  const delta = Number.isFinite(deltaTicks) ? Math.round(deltaTicks) : 0;
  if (delta === 0) return [...notes];
  return sortNotes(
    notes.map((note) => {
      if (note.ghost === true) return note;
      if (targetIds !== null && !targetIds.has(note.id)) return note;
      return normalizeNote({ ...note, lengthTicks: note.lengthTicks + delta });
    }),
  );
}

/**
 * Quantisiert die Start-Zeiten (optional auch die Längen) auf ein Raster.
 * Ein Raster <= 0 ist ein Programmierfehler und wird laut abgelehnt, statt
 * stillschweigend Noten zu verschieben.
 */
export function quantizeNotes(
  notes: readonly PianoRollNote[],
  gridTicks: number,
  options: QuantizeOptions = {},
): PianoRollNote[] {
  if (!Number.isFinite(gridTicks) || gridTicks <= 0) {
    throw new RangeError(`quantizeNotes: gridTicks muss > 0 sein (war ${gridTicks})`);
  }
  const grid = Math.max(1, Math.round(gridTicks));
  const targetIds = options.ids ? new Set(options.ids) : null;
  return sortNotes(
    notes.map((note) => {
      if (note.ghost === true) return note;
      if (targetIds !== null && !targetIds.has(note.id)) return note;
      const startTicks = snapTickToGrid(note.startTicks, grid);
      const lengthTicks = options.quantizeLength
        ? Math.max(grid, snapTickToGrid(note.lengthTicks, grid))
        : note.lengthTicks;
      return normalizeNote({ ...note, startTicks, lengthTicks });
    }),
  );
}

/** Erlaubter Transpositions-Bereich der Ziel-Noten (ohne Ziel: volle Tastatur). */
export function allowedTransposeRange(
  notes: readonly PianoRollNote[],
  ids?: readonly string[],
): TransposeRange {
  const targetIds = ids ? new Set(ids) : null;
  const targets = notes.filter(
    (note) => note.ghost !== true && (targetIds === null || targetIds.has(note.id)),
  );
  if (targets.length === 0) return { min: -MAX_PITCH, max: MAX_PITCH };
  const minPitch = Math.min(...targets.map((note) => note.pitch));
  const maxPitch = Math.max(...targets.map((note) => note.pitch));
  // `-0` vermeiden: ein Transpositionsbereich von 0 ist eine echte 0.
  return { min: minPitch === 0 ? 0 : -minPitch, max: MAX_PITCH - maxPitch };
}

/** Transponiert die Ziel-Noten; der Halbton-Vorrat wird für die Gruppe geklemmt. */
export function transposeNotes(
  notes: readonly PianoRollNote[],
  semitones: number,
  ids?: readonly string[],
): PianoRollNote[] {
  return moveNotes(notes, { deltaTicks: 0, deltaPitch: semitones, ids });
}

/** Setzt die Velocity der Ziel-Noten (geklemmt auf 0…127). */
export function setVelocity(
  notes: readonly PianoRollNote[],
  ids: readonly string[],
  velocity: number,
): PianoRollNote[] {
  if (ids.length === 0) return [...notes];
  const targetIds = new Set(ids);
  const value = clampVelocity(velocity);
  return sortNotes(
    notes.map((note) => {
      if (note.ghost === true || !targetIds.has(note.id)) return note;
      if (note.velocity === value) return note;
      return normalizeNote({ ...note, velocity: value });
    }),
  );
}

/**
 * Velocity-Spur-Malerei: setzt die Velocity aller Noten, die das Tick-Fenster
 * [fromTicks, toTicks) schneiden (Reihenfolge der Grenzen ist egal).
 */
export function paintVelocity(
  notes: readonly PianoRollNote[],
  fromTicks: number,
  toTicks: number,
  velocity: number,
  ids?: readonly string[],
): PianoRollNote[] {
  const targetIds = ids ? new Set(ids) : null;
  const from = Math.min(fromTicks, toTicks);
  const to = Math.max(fromTicks, toTicks);
  const value = clampVelocity(velocity);
  return sortNotes(
    notes.map((note) => {
      if (note.ghost === true) return note;
      if (targetIds !== null && !targetIds.has(note.id)) return note;
      const intersects = note.startTicks < to && note.startTicks + note.lengthTicks > from;
      if (!intersects) return note;
      return normalizeNote({ ...note, velocity: value });
    }),
  );
}

/**
 * Stempelt einen Akkord auf einen Tick. Töne oberhalb von Pitch 127 entfallen
 * (die Tastatur endet dort), bereits vorhandene identische Töne (gleicher Tick,
 * gleicher Pitch) werden nicht doppelt angelegt.
 */
export function stampChord(
  notes: readonly PianoRollNote[],
  options: ChordStampOptions,
): PianoRollNote[] {
  const intervals = CHORD_INTERVALS[options.quality];
  if (!intervals) {
    throw new RangeError(`stampChord: unbekannte Akkordqualität "${String(options.quality)}"`);
  }
  const rootPitch = clampPitch(options.rootPitch);
  const startTicks = clampStartTicks(options.startTicks);
  const velocity = clampVelocity(options.velocity ?? DEFAULT_VELOCITY);
  const lengthTicks = clampLengthTicks(options.lengthTicks ?? DEFAULT_NOTE_LENGTH_TICKS);

  let next: PianoRollNote[] = [...notes];
  for (const interval of intervals) {
    const pitch = rootPitch + interval;
    if (pitch > MAX_PITCH) continue;
    const exists = next.some(
      (note) => note.ghost !== true && note.startTicks === startTicks && note.pitch === pitch,
    );
    if (exists) continue;
    next = [
      ...next,
      normalizeNote({ id: nextNoteId(next), pitch, startTicks, lengthTicks, velocity }),
    ];
  }
  return sortNotes(next);
}

/**
 * Projiziert die Noten fremder Spuren als Ghost-Noten (read-only).
 * Die eigene Spur (`excludeTrackId`) wird nie projiziert, bereits projizierte
 * Ghost-Noten werden nicht erneut projiziert. Das Ergebnis ist deterministisch
 * sortiert (Start, Pitch, Id) und trägt `ghost: true` / `readOnly: true`.
 */
export function projectGhostNotes(
  tracks: readonly PianoRollTrack[],
  options: GhostProjectionOptions = {},
): GhostNote[] {
  const windowStart =
    options.fromTicks !== undefined && Number.isFinite(options.fromTicks)
      ? options.fromTicks
      : Number.NEGATIVE_INFINITY;
  const windowEnd =
    options.toTicks !== undefined && Number.isFinite(options.toTicks)
      ? options.toTicks
      : Number.POSITIVE_INFINITY;

  const ghosts: GhostNote[] = [];
  for (const track of tracks) {
    if (options.excludeTrackId !== undefined && track.trackId === options.excludeTrackId) continue;
    for (const note of track.notes) {
      if (note.ghost === true) continue;
      const endTicks = note.startTicks + note.lengthTicks;
      if (endTicks <= windowStart || note.startTicks >= windowEnd) continue;
      ghosts.push({
        id: `ghost:${track.trackId}:${note.id}`,
        pitch: note.pitch,
        startTicks: note.startTicks,
        lengthTicks: note.lengthTicks,
        velocity: note.velocity,
        selected: false,
        ghost: true,
        readOnly: true,
        sourceTrackId: track.trackId,
      });
    }
  }
  return [...ghosts].sort((a, b) => {
    if (a.startTicks !== b.startTicks) return a.startTicks - b.startTicks;
    if (a.pitch !== b.pitch) return a.pitch - b.pitch;
    if (a.id === b.id) return 0;
    return a.id < b.id ? -1 : 1;
  });
}
