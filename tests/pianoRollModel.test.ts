/**
 * ZUK-001 · Piano-Roll-Modell
 * ===========================
 * Deckt jede Operation aus `src/core/sequencer/pianoRollModel.ts` ab:
 * Klemmung (Pitch 0/127, Velocity 0/127, Länge 0), Normalisierung, Id-Vergabe,
 * Anlegen/Entfernen/Ändern, Auswahl, Verschieben (Gruppen-Klemmung), Länge,
 * Quantisierung, Transponieren, Velocity-Spur, Akkord-Stempel (Dur/Moll/7/dim),
 * Ghost-Projektion fremder Spuren – jeweils inkl. Randfällen und ohne die
 * Eingabe zu verändern.
 */
import { describe, expect, it } from 'vitest';
import {
  CHORD_INTERVALS,
  DEFAULT_NOTE_LENGTH_TICKS,
  DEFAULT_VELOCITY,
  MAX_PITCH,
  MAX_VELOCITY,
  TICKS_PER_16TH,
  TICKS_PER_QUARTER,
  addNote,
  allowedTransposeRange,
  clampLengthTicks,
  clampPitch,
  clampStartTicks,
  clampVelocity,
  clearSelection,
  findNoteAt,
  isBlackKey,
  moveNotes,
  nextNoteId,
  normalizeNote,
  noteName,
  notesOverlapping,
  paintVelocity,
  projectGhostNotes,
  quantizeNotes,
  removeNotes,
  resizeNote,
  resizeNotes,
  selectNotes,
  selectedNotes,
  setVelocity,
  snapTickToGrid,
  sortNotes,
  stampChord,
  ticksForColumns,
  transposeNotes,
  updateNote,
  type ChordQuality,
  type GhostNote,
  type PianoRollNote,
} from '../src/core/sequencer/pianoRollModel';

function note(
  id: string,
  pitch: number,
  startTicks = 0,
  lengthTicks: number = TICKS_PER_16TH,
  velocity: number = DEFAULT_VELOCITY,
): PianoRollNote {
  return { id, pitch, startTicks, lengthTicks, velocity, selected: false };
}

function pitches(notes: readonly PianoRollNote[]): number[] {
  return notes.map((n) => n.pitch);
}

describe('ZUK-001 · Zeitbasis und Klemmung an den Rändern', () => {
  it('nutzt 960 Ticks pro Viertel und 240 pro 16tel', () => {
    expect(TICKS_PER_QUARTER).toBe(960);
    expect(TICKS_PER_16TH).toBe(240);
    expect(DEFAULT_NOTE_LENGTH_TICKS).toBe(TICKS_PER_16TH);
  });

  it('klemmt Pitch auf 0…127 und rundet kaufmännisch', () => {
    expect(clampPitch(-1)).toBe(0);
    expect(clampPitch(0)).toBe(0);
    expect(clampPitch(127)).toBe(127);
    expect(clampPitch(128)).toBe(127);
    expect(clampPitch(9999)).toBe(MAX_PITCH);
    expect(clampPitch(60.4)).toBe(60);
    expect(clampPitch(60.6)).toBe(61);
    // Nicht-Zahlen sind kein Crash, sondern der tiefste Pitch.
    expect(clampPitch(Number.NaN)).toBe(0);
    expect(clampPitch(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('klemmt Velocity auf 0…127, NaN fällt auf die Standard-Velocity', () => {
    expect(clampVelocity(-5)).toBe(0);
    expect(clampVelocity(0)).toBe(0);
    expect(clampVelocity(127)).toBe(MAX_VELOCITY);
    expect(clampVelocity(200)).toBe(127);
    expect(clampVelocity(99.6)).toBe(100);
    expect(clampVelocity(Number.NaN)).toBe(DEFAULT_VELOCITY);
  });

  it('klemmt Start-Ticks auf >= 0 und Längen auf >= 1', () => {
    expect(clampStartTicks(-5)).toBe(0);
    expect(clampStartTicks(239.6)).toBe(240);
    expect(clampStartTicks(Number.NaN)).toBe(0);
    expect(clampLengthTicks(0)).toBe(1);
    expect(clampLengthTicks(-10)).toBe(1);
    expect(clampLengthTicks(239.4)).toBe(239);
    expect(clampLengthTicks(Number.NaN)).toBe(1);
  });

  it('normalizeNote setzt Defaults und repariert kaputte Werte', () => {
    const created = normalizeNote({ id: 'note-1', pitch: 60, startTicks: 0 });
    expect(created).toEqual({
      id: 'note-1',
      pitch: 60,
      startTicks: 0,
      lengthTicks: TICKS_PER_16TH,
      velocity: DEFAULT_VELOCITY,
      selected: false,
    });

    const zeroLength = normalizeNote({ id: 'note-2', pitch: 200, startTicks: -20, lengthTicks: 0, velocity: 999 });
    expect(zeroLength.pitch).toBe(127);
    expect(zeroLength.startTicks).toBe(0);
    expect(zeroLength.lengthTicks).toBe(1);
    expect(zeroLength.velocity).toBe(127);
  });

  it('vergibt die nächste freie Id und ignoriert fremde Id-Formen', () => {
    expect(nextNoteId([])).toBe('note-1');
    expect(nextNoteId([note('note-1', 60), note('note-3', 62)])).toBe('note-4');
    expect(nextNoteId([note('ghost:lead:note-99', 60)])).toBe('note-1');
  });

  it('benennt Noten und erkennt schwarze Tasten', () => {
    expect(noteName(0)).toBe('C-1');
    expect(noteName(60)).toBe('C4');
    expect(noteName(61)).toBe('C#4');
    expect(noteName(127)).toBe('G9');
    expect(noteName(500)).toBe('G9');
    expect(isBlackKey(60)).toBe(false);
    expect(isBlackKey(61)).toBe(true);
    expect(isBlackKey(66)).toBe(true);
  });

  it('rechnet Spalten in Ticks um und rastet Ticks ein', () => {
    expect(ticksForColumns(16)).toBe(3840);
    expect(ticksForColumns(4, 480)).toBe(1920);
    expect(ticksForColumns(0)).toBe(0);
    expect(snapTickToGrid(119, 240)).toBe(0);
    expect(snapTickToGrid(120, 240)).toBe(240);
    expect(snapTickToGrid(130, 240)).toBe(240);
    expect(snapTickToGrid(-30, 240)).toBe(0);
  });
});

describe('ZUK-001 · Anlegen, Entfernen, Ändern', () => {
  it('sortiert Noten nach Start, Pitch, Länge und Id', () => {
    const input = [note('note-3', 64, 480), note('note-2', 60, 0), note('note-1', 60, 480)];
    const sorted = sortNotes(input);
    // Start zuerst, dann Pitch: note-2 (0) vor note-1/note-3 (480, 60 vor 64).
    expect(sorted.map((n) => n.id)).toEqual(['note-2', 'note-1', 'note-3']);
    // Bei Gleichstand entscheidet die Id.
    expect(sortNotes([note('note-9', 60, 0), note('note-4', 60, 0)]).map((n) => n.id)).toEqual([
      'note-4',
      'note-9',
    ]);
    // Eingabe bleibt unverändert.
    expect(input.map((n) => n.id)).toEqual(['note-3', 'note-2', 'note-1']);
  });

  it('legt Noten an, ohne die Eingabe zu verändern', () => {
    const before = [note('note-1', 60, 480)];
    const after = addNote(before, { pitch: 62, startTicks: 0, velocity: 42 });
    expect(after).toHaveLength(2);
    expect(before).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: 'note-2', pitch: 62, startTicks: 0, velocity: 42, selected: false });
    expect(after[0].lengthTicks).toBe(TICKS_PER_16TH);
  });

  it('behält die Rand-Pitches 0 und 127 beim Anlegen exakt bei', () => {
    const withLow = addNote([], { id: 'low', pitch: 0, startTicks: 0 });
    const withHigh = addNote([], { id: 'high', pitch: 127, startTicks: 0 });
    expect(withLow[0].pitch).toBe(0);
    expect(withHigh[0].pitch).toBe(127);
  });

  it('entfernt nur die genannten Ids', () => {
    const before = [note('note-1', 60), note('note-2', 62), note('note-3', 64)];
    const after = removeNotes(before, ['note-2', 'unbekannt']);
    expect(after.map((n) => n.id)).toEqual(['note-1', 'note-3']);
    expect(before).toHaveLength(3);
    expect(removeNotes(before, [])).toHaveLength(3);
  });

  it('aktualisiert Felder und klemmt die neuen Werte', () => {
    const before = [note('note-1', 60), note('note-2', 62)];
    const after = updateNote(before, 'note-1', { pitch: 200, velocity: -4 });
    const target = after.find((n) => n.id === 'note-1')!;
    expect(target.pitch).toBe(127);
    expect(target.velocity).toBe(0);
    expect(after.find((n) => n.id === 'note-2')).toEqual(before[1]);
    expect(updateNote(before, 'unbekannt', { pitch: 70 })).toEqual(before);
  });
});

describe('ZUK-001 · Auswahl', () => {
  it('setzt eine exklusive Auswahl, erweitert sie additiv und hebt sie auf', () => {
    const base = [note('note-1', 60), note('note-2', 62), note('note-3', 64)];
    const onlyOne = selectNotes(base, ['note-1']);
    expect(selectedNotes(onlyOne).map((n) => n.id)).toEqual(['note-1']);

    const additive = selectNotes(onlyOne, ['note-3'], true);
    expect(selectedNotes(additive).map((n) => n.id)).toEqual(['note-1', 'note-3']);

    const replaced = selectNotes(additive, ['note-2'], false);
    expect(selectedNotes(replaced).map((n) => n.id)).toEqual(['note-2']);

    expect(selectedNotes(clearSelection(replaced))).toEqual([]);
  });
});

describe('ZUK-001 · Verschieben und Längen', () => {
  it('verschiebt nur die Ziel-Noten in Zeit und Tonhöhe', () => {
    const before = [note('note-1', 60, 0), note('note-2', 62, 240)];
    const after = moveNotes(before, { ids: ['note-2'], deltaTicks: 480, deltaPitch: 3 });
    expect(after.find((n) => n.id === 'note-1')).toEqual(before[0]);
    expect(after.find((n) => n.id === 'note-2')).toMatchObject({ startTicks: 720, pitch: 65 });
  });

  it('klemmt das Zeit-Delta der Gruppe, damit kein Start < 0 entsteht', () => {
    const before = [note('note-1', 60, 240), note('note-2', 62, 480)];
    const after = moveNotes(before, { deltaTicks: -480, deltaPitch: 0 });
    expect(after.map((n) => n.startTicks)).toEqual([0, 240]);
  });

  it('klemmt das Pitch-Delta der Gruppe und erhält Akkord-Intervalle', () => {
    // C-Dur Dreiklang hoch oben an der Tastatur: +100 Halbtöne geht nicht.
    const triad = [note('note-1', 60, 0), note('note-2', 64, 0), note('note-3', 67, 0)];
    const after = moveNotes(triad, { deltaTicks: 0, deltaPitch: 100 });
    expect(pitches(after)).toEqual([120, 124, 127]);
    expect(after[1].pitch - after[0].pitch).toBe(4);
    expect(after[2].pitch - after[1].pitch).toBe(3);
  });

  it('liefert bei Delta 0 und ohne Ziel-Noten eine Kopie unverändert zurück', () => {
    const before = [note('note-1', 60, 0)];
    expect(moveNotes(before, { deltaTicks: 0, deltaPitch: 0 })).toEqual(before);
    expect(moveNotes([], { deltaTicks: 240, deltaPitch: 12 })).toEqual([]);
    expect(moveNotes(before, { ids: ['unbekannt'], deltaTicks: 240, deltaPitch: 0 })).toEqual(before);
  });

  it('setzt Längen absolut mit Minimum 1 Tick', () => {
    const before = [note('note-1', 60, 0, 240)];
    expect(resizeNote(before, 'note-1', 0)[0].lengthTicks).toBe(1);
    expect(resizeNote(before, 'note-1', -500)[0].lengthTicks).toBe(1);
    expect(resizeNote(before, 'note-1', 480)[0].lengthTicks).toBe(480);
    expect(before[0].lengthTicks).toBe(240);
  });

  it('ändert Längen relativ und klemmt auf das Minimum', () => {
    const before = [note('note-1', 60, 0, 240), note('note-2', 62, 0, 480)];
    const shrunk = resizeNotes(before, -1000);
    expect(shrunk.map((n) => n.lengthTicks)).toEqual([1, 1]);
    const grown = resizeNotes(before, 240, ['note-2']);
    expect(grown.map((n) => n.lengthTicks)).toEqual([240, 720]);
    expect(resizeNotes(before, 0)).toEqual(before);
  });
});

describe('ZUK-001 · Quantisierung', () => {
  it('rastet Start-Zeiten auf das 16tel-Raster', () => {
    const before = [note('note-1', 60, 119), note('note-2', 62, 130), note('note-3', 64, 120)];
    const after = quantizeNotes(before, TICKS_PER_16TH);
    expect(after.map((n) => n.startTicks)).toEqual([0, 240, 240]);
    // Länge bleibt unangetastet.
    expect(after.every((n) => n.lengthTicks === TICKS_PER_16TH)).toBe(true);
  });

  it('quantisiert optional auch die Längen (Minimum ein Raster)', () => {
    const before = [note('note-1', 60, 0, 130), note('note-2', 62, 0, 100)];
    const after = quantizeNotes(before, TICKS_PER_16TH, { quantizeLength: true });
    expect(after.map((n) => n.lengthTicks)).toEqual([240, 240]);
  });

  it('quantisiert nur die Ziel-Ids', () => {
    const before = [note('note-1', 60, 130), note('note-2', 62, 130)];
    const after = quantizeNotes(before, TICKS_PER_16TH, { ids: ['note-2'] });
    expect(after.find((n) => n.id === 'note-1')!.startTicks).toBe(130);
    expect(after.find((n) => n.id === 'note-2')!.startTicks).toBe(240);
  });

  it('lehnt ein Raster <= 0 laut ab, statt Noten still zu verschieben', () => {
    const before = [note('note-1', 60, 130)];
    expect(() => quantizeNotes(before, 0)).toThrow(RangeError);
    expect(() => quantizeNotes(before, -240)).toThrow(RangeError);
    expect(() => quantizeNotes(before, Number.NaN)).toThrow(RangeError);
    expect(before[0].startTicks).toBe(130);
  });
});

describe('ZUK-001 · Transponieren', () => {
  it('transponiert in beide Richtungen', () => {
    const before = [note('note-1', 60, 0)];
    expect(transposeNotes(before, 12)[0].pitch).toBe(72);
    expect(transposeNotes(before, -12)[0].pitch).toBe(48);
  });

  it('stoppt an den Tastaturgrenzen 0 und 127 ohne Noten zu verlieren', () => {
    const top = [note('note-1', 127, 0)];
    const bottom = [note('note-1', 0, 0)];
    expect(transposeNotes(top, 12)).toHaveLength(1);
    expect(pitches(transposeNotes(top, 12))).toEqual([127]);
    expect(pitches(transposeNotes(bottom, -12))).toEqual([0]);
  });

  it('erhält Akkord-Intervalle an der Grenze (Gruppen-Klemmung)', () => {
    const triad = [note('note-1', 0, 0), note('note-2', 4, 0), note('note-3', 7, 0)];
    expect(pitches(transposeNotes(triad, -12))).toEqual([0, 4, 7]);
  });

  it('meldet den erlaubten Transpositionsbereich', () => {
    expect(allowedTransposeRange([note('note-1', 60, 0)])).toEqual({ min: -60, max: 67 });
    expect(allowedTransposeRange([note('note-1', 0, 0), note('note-2', 127, 0)])).toEqual({ min: 0, max: 0 });
    expect(allowedTransposeRange([])).toEqual({ min: -127, max: 127 });
  });

  it('transponiert nur die Ziel-Ids', () => {
    const before = [note('note-1', 60, 0), note('note-2', 62, 0)];
    const after = transposeNotes(before, 5, ['note-1']);
    expect(after.find((n) => n.id === 'note-1')!.pitch).toBe(65);
    expect(after.find((n) => n.id === 'note-2')!.pitch).toBe(62);
  });
});

describe('ZUK-001 · Velocity-Spur', () => {
  it('setzt Velocity geklemmt und nur für die Ziel-Ids', () => {
    const before = [note('note-1', 60, 0, 240, 100), note('note-2', 62, 0, 240, 100)];
    const loud = setVelocity(before, ['note-1'], 200);
    expect(loud.find((n) => n.id === 'note-1')!.velocity).toBe(127);
    expect(loud.find((n) => n.id === 'note-2')!.velocity).toBe(100);

    const silent = setVelocity(before, ['note-1', 'note-2'], -3);
    expect(silent.map((n) => n.velocity)).toEqual([0, 0]);
    expect(setVelocity(before, [], 64)).toEqual(before);
  });

  it('malt Velocity nur über Noten, die das Tick-Fenster schneiden', () => {
    const before = [note('note-1', 60, 0, 240), note('note-2', 62, 240, 240), note('note-3', 64, 480, 240)];
    // Fenster [240, 480): Note 1 endet genau am Fensteranfang, Note 3 beginnt genau am Fensterende.
    const painted = paintVelocity(before, 240, 480, 33);
    expect(painted.map((n) => n.velocity)).toEqual([DEFAULT_VELOCITY, 33, DEFAULT_VELOCITY]);
    // Grenzen in beliebiger Reihenfolge.
    expect(paintVelocity(before, 480, 240, 33).map((n) => n.velocity)).toEqual([DEFAULT_VELOCITY, 33, DEFAULT_VELOCITY]);
  });
});

describe('ZUK-001 · Akkord-Stempel', () => {
  it('kennt Dur, Moll, Dominant 7 und Vermindert', () => {
    expect(CHORD_INTERVALS.major).toEqual([0, 4, 7]);
    expect(CHORD_INTERVALS.minor).toEqual([0, 3, 7]);
    expect(CHORD_INTERVALS['7']).toEqual([0, 4, 7, 10]);
    expect(CHORD_INTERVALS.dim).toEqual([0, 3, 6]);

    const major = stampChord([], { quality: 'major', rootPitch: 60, startTicks: 0 });
    expect(pitches(major)).toEqual([60, 64, 67]);

    const minor = stampChord([], { quality: 'minor', rootPitch: 60, startTicks: 0 });
    expect(pitches(minor)).toEqual([60, 63, 67]);

    const seventh = stampChord([], { quality: '7', rootPitch: 60, startTicks: 0 });
    expect(pitches(seventh)).toEqual([60, 64, 67, 70]);

    const dim = stampChord([], { quality: 'dim', rootPitch: 60, startTicks: 0 });
    expect(pitches(dim)).toEqual([60, 63, 66]);
  });

  it('übernimmt Tick, Velocity, Länge und vergibt fortlaufende Ids', () => {
    const stamped = stampChord([], {
      quality: 'major',
      rootPitch: 60,
      startTicks: 480,
      velocity: 42,
      lengthTicks: 960,
    });
    expect(stamped.map((n) => n.id)).toEqual(['note-1', 'note-2', 'note-3']);
    expect(stamped.every((n) => n.startTicks === 480 && n.velocity === 42 && n.lengthTicks === 960)).toBe(true);
    expect(stamped.every((n) => n.selected === false)).toBe(true);
  });

  it('lässt Töne oberhalb von Pitch 127 entfallen', () => {
    // 125 + 4 = 129, 125 + 7 = 132 -> nur der Grundton bleibt.
    expect(pitches(stampChord([], { quality: 'major', rootPitch: 125, startTicks: 0 }))).toEqual([125]);
    // Am unteren Rand passt der verminderte Dreiklang vollständig.
    expect(pitches(stampChord([], { quality: 'dim', rootPitch: 0, startTicks: 0 }))).toEqual([0, 3, 6]);
    // Grundton jenseits der Tastatur wird geklemmt.
    expect(pitches(stampChord([], { quality: 'major', rootPitch: 200, startTicks: 0 }))).toEqual([127]);
  });

  it('stempelt nicht doppelt auf dieselbe Position', () => {
    const once = stampChord([], { quality: 'minor', rootPitch: 57, startTicks: 240 });
    const twice = stampChord(once, { quality: 'minor', rootPitch: 57, startTicks: 240 });
    expect(twice).toHaveLength(3);
    expect(pitches(twice)).toEqual([57, 60, 64]);
  });

  it('ergänzt einen bestehenden Akkord um fehlende Töne', () => {
    const before = [note('note-1', 60, 0)];
    const after = stampChord(before, { quality: 'major', rootPitch: 60, startTicks: 0 });
    expect(after).toHaveLength(3);
    expect(pitches(after)).toEqual([60, 64, 67]);
    expect(before).toHaveLength(1);
  });

  it('lehnt unbekannte Qualitäten ab', () => {
    expect(() =>
      stampChord([], { quality: 'sus9' as ChordQuality, rootPitch: 60, startTicks: 0 }),
    ).toThrow(RangeError);
  });
});

describe('ZUK-001 · Ghost-Noten (Projektion fremder Spuren)', () => {
  const lead = { trackId: 'lead', notes: [note('note-1', 72, 0), note('note-2', 74, 480)] };
  const bass = { trackId: 'bass', notes: [note('note-1', 36, 240)] };

  it('lässt die eigene Spur aus und markiert die Projektion read-only', () => {
    const ghosts = projectGhostNotes([lead, bass], { excludeTrackId: 'lead' });
    expect(ghosts).toHaveLength(1);
    const ghost = ghosts[0];
    expect(ghost).toEqual({
      id: 'ghost:bass:note-1',
      pitch: 36,
      startTicks: 240,
      lengthTicks: TICKS_PER_16TH,
      velocity: DEFAULT_VELOCITY,
      selected: false,
      ghost: true,
      readOnly: true,
      sourceTrackId: 'bass',
    });
    expect(ghost.ghost).toBe(true);
    expect(ghost.readOnly).toBe(true);
  });

  it('projiziert alle fremden Spuren deterministisch sortiert', () => {
    const ghosts = projectGhostNotes([lead, bass]);
    expect(ghosts.map((g) => g.id)).toEqual(['ghost:lead:note-1', 'ghost:bass:note-1', 'ghost:lead:note-2']);
    expect(ghosts.map((g) => g.startTicks)).toEqual([0, 240, 480]);
    // Zweiter Lauf liefert dieselbe Reihenfolge.
    expect(projectGhostNotes([bass, lead]).map((g) => g.id)).toEqual(ghosts.map((g) => g.id));
  });

  it('filtert auf ein Tick-Fenster (from inklusive, to exklusive)', () => {
    const ghosts = projectGhostNotes([lead, bass], { fromTicks: 240, toTicks: 480 });
    expect(ghosts.map((g) => g.id)).toEqual(['ghost:bass:note-1']);
    expect(projectGhostNotes([lead, bass], { fromTicks: 0, toTicks: 240 }).map((g) => g.id)).toEqual([
      'ghost:lead:note-1',
    ]);
  });

  it('projiziert Ghost-Noten nicht erneut', () => {
    const alreadyGhost = [
      lead,
      { trackId: 'pad', notes: [{ ...note('note-9', 50, 0), ghost: true }] },
    ];
    expect(projectGhostNotes(alreadyGhost).map((g) => g.id)).toEqual([
      'ghost:lead:note-1',
      'ghost:lead:note-2',
    ]);
  });

  it('verändert die Quell-Spuren nicht', () => {
    projectGhostNotes([lead, bass]);
    expect(lead.notes).toHaveLength(2);
    expect(bass.notes).toHaveLength(1);
    expect(lead.notes[0].ghost).toBeUndefined();
  });

  it('liefert für leere Spuren eine leere Liste', () => {
    expect(projectGhostNotes([])).toEqual([]);
    expect(projectGhostNotes([{ trackId: 'empty', notes: [] }])).toEqual([]);
  });

  it('Ghost-Noten bleiben bei Gruppen-Operationen unangetastet', () => {
    const ghosts: GhostNote[] = projectGhostNotes([bass], { excludeTrackId: 'lead' });
    const mixed: PianoRollNote[] = [note('note-1', 60, 0), ...ghosts];
    const moved = transposeNotes(mixed, 12);
    expect(moved.find((n) => n.id === 'note-1')!.pitch).toBe(72);
    expect(moved.find((n) => n.id === 'ghost:bass:note-1')!.pitch).toBe(36);

    const resized = resizeNotes(mixed, 240);
    expect(resized.find((n) => n.id === 'ghost:bass:note-1')!.lengthTicks).toBe(TICKS_PER_16TH);

    const silenced = setVelocity(mixed, ['ghost:bass:note-1'], 0);
    expect(silenced.find((n) => n.id === 'ghost:bass:note-1')!.velocity).toBe(DEFAULT_VELOCITY);
  });
});

describe('ZUK-001 · Abfragen für die View', () => {
  it('findet die Note unter einem Rasterpunkt', () => {
    const notes = [note('note-1', 60, 240, 240)];
    expect(findNoteAt(notes, 240, 60)!.id).toBe('note-1');
    expect(findNoteAt(notes, 479, 60)!.id).toBe('note-1');
    expect(findNoteAt(notes, 480, 60)).toBeNull();
    expect(findNoteAt(notes, 300, 61)).toBeNull();
    expect(findNoteAt([], 0, 60)).toBeNull();
  });

  it('liefert alle Noten, die einen Zeitraum schneiden', () => {
    const notes = [note('note-1', 60, 0, 240), note('note-2', 62, 240, 240), note('note-3', 64, 960, 240)];
    expect(notesOverlapping(notes, 100, 300).map((n) => n.id)).toEqual(['note-1', 'note-2']);
    expect(notesOverlapping(notes, 300, 100).map((n) => n.id)).toEqual(['note-1', 'note-2']);
    expect(notesOverlapping(notes, 480, 960)).toEqual([]);
  });
});
