import { useCallback, useMemo, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import {
  CHORD_INTERVALS,
  DEFAULT_NOTE_LENGTH_TICKS,
  DEFAULT_VELOCITY,
  MAX_PITCH,
  MAX_VELOCITY,
  MIN_VELOCITY,
  TICKS_PER_16TH,
  TICKS_PER_QUARTER,
  addNote,
  clampPitch,
  isBlackKey,
  moveNotes,
  noteName,
  quantizeNotes,
  removeNotes,
  resizeNote,
  selectNotes,
  selectedNotes,
  setVelocity,
  stampChord,
  transposeNotes,
  type ChordQuality,
  type GhostNote,
  type PianoRollNote,
} from '../../core/sequencer/pianoRollModel';

/** Breite einer 16tel-Spalte in px. */
const CELL_W = 28;
/** Höhe einer Pitch-Zeile in px. */
const ROW_H = 14;
/** Breite der Klaviatur-Leiste links. */
const SIDEBAR_W = 48;
/** Höhe der Velocity-Spur in px. */
const VELOCITY_LANE_H = 64;

/** Laufender Drag: Verschieben (Block) oder Länge ziehen (Griff rechts). */
type DragState =
  | { kind: 'move'; noteId: string; originStartTicks: number; originPitch: number }
  | { kind: 'resize'; noteId: string; startTicks: number };

export interface PianoRollProps {
  /** Editierbare Noten der aktuellen Spur (Parent hält den Zustand). */
  notes: readonly PianoRollNote[];
  /** Wird bei jeder Änderung mit der neuen (unveränderlichen) Liste gerufen. */
  onChange: (notes: PianoRollNote[]) => void;
  /** Read-only Projektion fremder Spuren (siehe `projectGhostNotes`). */
  ghostNotes?: readonly GhostNote[];
  /** Sichtbare 16tel-Spalten (Default 16 = ein 4/4-Takt). */
  columns?: number;
  /** Tiefster sichtbarer Pitch (Default 48 = C3). */
  lowestPitch?: number;
  /** Sichtbare Pitch-Zeilen (Default 24 = zwei Oktaven). */
  pitchRows?: number;
}

const QUALITY_LABELS: Record<ChordQuality, string> = {
  major: 'Dur',
  minor: 'Moll',
  '7': 'Dominant 7',
  dim: 'Vermindert',
};

/**
 * Piano-Roll (ZUK-001) – DOM/SVG-freies Raster ohne Canvas:
 * Pitch-Zeilen × 16tel-Spalten, Notenblöcke, Velocity-Spur darunter,
 * Ghost-Noten der anderen Spuren (gestrichelt, nicht klickbar) und
 * Akkord-Stempel. Die gesamte Rechenlogik liegt in
 * `src/core/sequencer/pianoRollModel.ts`; diese Komponente übersetzt nur
 * Zeiger-Ereignisse in Modell-Aufrufe (kein Audio-, DOM- oder Storage-Zugriff).
 */
export function PianoRoll({
  notes,
  onChange,
  ghostNotes = [],
  columns: columnsProp = 16,
  lowestPitch: lowestPitchProp = 48,
  pitchRows: pitchRowsProp = 24,
}: PianoRollProps) {
  const [chordQuality, setChordQuality] = useState<ChordQuality>('major');
  const [chordRoot, setChordRoot] = useState(60);
  const [chordArmed, setChordArmed] = useState(false);
  const [quantizeGrid, setQuantizeGrid] = useState<number>(TICKS_PER_16TH);
  const [drag, setDrag] = useState<DragState | null>(null);

  const columns = Math.max(1, Math.round(columnsProp));
  const lowestPitch = clampPitch(lowestPitchProp);
  const highestPitch = Math.min(MAX_PITCH, lowestPitch + Math.max(1, Math.round(pitchRowsProp)) - 1);
  const rowCount = highestPitch - lowestPitch + 1;
  const gridWidth = columns * CELL_W;
  const gridHeight = rowCount * ROW_H;

  /** Zeilen von oben (höchster Pitch) nach unten (tiefster Pitch). */
  const pitches = useMemo(
    () => Array.from({ length: rowCount }, (_, index) => highestPitch - index),
    [rowCount, highestPitch],
  );

  const rowOf = (pitch: number) => highestPitch - pitch;
  const isVisible = (pitch: number) => pitch >= lowestPitch && pitch <= highestPitch;
  const targetIds = selectedNotes(notes).map((note) => note.id);

  const handleCellClick = (pitch: number, tick: number) => {
    if (drag) return; // Klick am Ende eines Drags ist kein "Note anlegen"
    if (chordArmed) {
      onChange(stampChord(notes, { quality: chordQuality, rootPitch: chordRoot, startTicks: tick }));
      return;
    }
    onChange(
      addNote(notes, {
        pitch,
        startTicks: tick,
        lengthTicks: DEFAULT_NOTE_LENGTH_TICKS,
        velocity: DEFAULT_VELOCITY,
      }),
    );
  };

  const handleCellPointerOver = (pitch: number, tick: number) => {
    if (!drag) return;
    if (drag.kind === 'move') {
      onChange(
        moveNotes(notes, {
          ids: [drag.noteId],
          deltaTicks: tick - drag.originStartTicks,
          deltaPitch: pitch - drag.originPitch,
        }),
      );
      return;
    }
    onChange(resizeNote(notes, drag.noteId, tick + TICKS_PER_16TH - drag.startTicks));
  };

  const handleNotePointerDown = (event: ReactPointerEvent<HTMLDivElement>, note: PianoRollNote) => {
    event.stopPropagation();
    event.preventDefault();
    onChange(selectNotes(notes, [note.id], event.shiftKey));
    setDrag({
      kind: 'move',
      noteId: note.id,
      originStartTicks: note.startTicks,
      originPitch: note.pitch,
    });
  };

  const handleResizePointerDown = (
    event: ReactPointerEvent<HTMLSpanElement>,
    note: PianoRollNote,
  ) => {
    event.stopPropagation();
    event.preventDefault();
    onChange(selectNotes(notes, [note.id], event.shiftKey));
    setDrag({ kind: 'resize', noteId: note.id, startTicks: note.startTicks });
  };

  const handleNoteKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>, note: PianoRollNote) => {
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      onChange(removeNotes(notes, [note.id]));
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onChange(selectNotes(notes, [note.id], event.shiftKey));
    }
  };

  const endDrag = useCallback(() => setDrag(null), []);
  const transpose = (semitones: number) =>
    onChange(transposeNotes(notes, semitones, targetIds.length > 0 ? targetIds : undefined));

  return (
    <div
      className="piano-roll"
      style={{ display: 'flex', flexDirection: 'column', gap: 8, fontFamily: 'monospace' }}
      onPointerUp={endDrag}
      onPointerLeave={endDrag}
    >
      <div
        className="piano-roll__toolbar"
        style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, fontSize: 11 }}
      >
        <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          Akkord
          <select
            aria-label="Akkord-Grundton"
            value={chordRoot}
            onChange={(event) => setChordRoot(clampPitch(Number(event.target.value)))}
          >
            {pitches.map((pitch) => (
              <option key={pitch} value={pitch}>
                {noteName(pitch)}
              </option>
            ))}
          </select>
        </label>
        <select
          aria-label="Akkord-Qualität"
          value={chordQuality}
          onChange={(event) => setChordQuality(event.target.value as ChordQuality)}
        >
          {(Object.keys(CHORD_INTERVALS) as ChordQuality[]).map((quality) => (
            <option key={quality} value={quality}>
              {QUALITY_LABELS[quality]}
            </option>
          ))}
        </select>
        <button
          type="button"
          aria-pressed={chordArmed}
          onClick={() => setChordArmed((armed) => !armed)}
          style={{ padding: '2px 8px', cursor: 'pointer' }}
        >
          Akkord-Stempel
        </button>
        <select
          aria-label="Quantisierung"
          value={quantizeGrid}
          onChange={(event) => setQuantizeGrid(Number(event.target.value))}
        >
          <option value={TICKS_PER_QUARTER}>1/4</option>
          <option value={TICKS_PER_QUARTER / 2}>1/8</option>
          <option value={TICKS_PER_16TH}>1/16</option>
          <option value={TICKS_PER_16TH / 2}>1/32</option>
        </select>
        <button
          type="button"
          onClick={() =>
            onChange(quantizeNotes(notes, quantizeGrid, targetIds.length > 0 ? { ids: targetIds } : {}))
          }
          style={{ padding: '2px 8px', cursor: 'pointer' }}
        >
          Quantisieren
        </button>
        <button
          type="button"
          onClick={() => transpose(-12)}
          disabled={notes.length === 0}
          style={{ padding: '2px 8px', cursor: 'pointer' }}
        >
          −12
        </button>
        <button
          type="button"
          onClick={() => transpose(12)}
          disabled={notes.length === 0}
          style={{ padding: '2px 8px', cursor: 'pointer' }}
        >
          +12
        </button>
        <button
          type="button"
          onClick={() => onChange(removeNotes(notes, targetIds))}
          disabled={targetIds.length === 0}
          style={{ padding: '2px 8px', cursor: 'pointer' }}
        >
          Auswahl löschen
        </button>
      </div>

      <div className="piano-roll__body" style={{ display: 'flex', alignItems: 'flex-start' }}>
        <div className="piano-roll__keys" style={{ width: SIDEBAR_W, flex: '0 0 auto' }}>
          {pitches.map((pitch) => (
            <div
              key={pitch}
              data-pitch-key={pitch}
              style={{
                height: ROW_H,
                lineHeight: `${ROW_H}px`,
                fontSize: 8,
                paddingRight: 4,
                textAlign: 'right',
                color: isBlackKey(pitch) ? '#9ca3af' : '#e5e7eb',
                background: isBlackKey(pitch) ? '#111827' : '#1f2937',
                borderBottom: '1px solid #0b1220',
              }}
            >
              {noteName(pitch)}
            </div>
          ))}
        </div>

        <div className="piano-roll__surface" style={{ flex: '0 0 auto', width: gridWidth }}>
          <div
            className="piano-roll__grid"
            role="grid"
            aria-label="Piano-Roll-Raster"
            style={{
              position: 'relative',
              width: gridWidth,
              height: gridHeight,
              background: '#0b1220',
              overflow: 'hidden',
            }}
          >
            {pitches.map((pitch) =>
              Array.from({ length: columns }, (_, column) => {
                const tick = column * TICKS_PER_16TH;
                return (
                  <div
                    key={`cell-${pitch}-${column}`}
                    data-cell={`${pitch}:${tick}`}
                    role="button"
                    tabIndex={-1}
                    aria-label={`${noteName(pitch)} 16tel ${column + 1}`}
                    onClick={() => handleCellClick(pitch, tick)}
                    onPointerOver={() => handleCellPointerOver(pitch, tick)}
                    style={{
                      position: 'absolute',
                      left: column * CELL_W,
                      top: rowOf(pitch) * ROW_H,
                      width: CELL_W,
                      height: ROW_H,
                      boxSizing: 'border-box',
                      borderRight: `1px solid ${column % 4 === 3 ? '#1f2937' : '#131c2e'}`,
                      borderBottom: '1px solid #131c2e',
                      background: isBlackKey(pitch)
                        ? column % 4 === 0
                          ? '#141c2b'
                          : '#101724'
                        : column % 4 === 0
                          ? '#1a2436'
                          : '#161f2f',
                      cursor: chordArmed ? 'copy' : 'crosshair',
                    }}
                  />
                );
              }),
            )}

            {ghostNotes
              .filter((ghost) => isVisible(ghost.pitch))
              .map((ghost) => (
                <div
                  key={ghost.id}
                  data-ghost="true"
                  data-ghost-source={ghost.sourceTrackId}
                  aria-readonly="true"
                  aria-label={`Ghost ${noteName(ghost.pitch)} aus ${ghost.sourceTrackId}`}
                  className="piano-roll__note piano-roll__note--ghost"
                  style={{
                    position: 'absolute',
                    left: (ghost.startTicks / TICKS_PER_16TH) * CELL_W,
                    top: rowOf(ghost.pitch) * ROW_H + 2,
                    width: Math.max(6, (ghost.lengthTicks / TICKS_PER_16TH) * CELL_W - 1),
                    height: ROW_H - 4,
                    boxSizing: 'border-box',
                    border: '1px dashed #64748b',
                    borderRadius: 2,
                    background: 'rgba(100, 116, 139, 0.18)',
                    pointerEvents: 'none',
                    opacity: 0.75,
                  }}
                />
              ))}

            {notes
              .filter((note) => isVisible(note.pitch))
              .map((note) => (
                <div
                  key={note.id}
                  data-note-id={note.id}
                  data-selected={note.selected ? 'true' : 'false'}
                  role="button"
                  tabIndex={0}
                  aria-label={`Note ${noteName(note.pitch)} bei Tick ${note.startTicks}`}
                  aria-pressed={note.selected}
                  className="piano-roll__note piano-roll__note--editable"
                  onPointerDown={(event) => handleNotePointerDown(event, note)}
                  onKeyDown={(event) => handleNoteKeyDown(event, note)}
                  style={{
                    position: 'absolute',
                    left: (note.startTicks / TICKS_PER_16TH) * CELL_W,
                    top: rowOf(note.pitch) * ROW_H + 1,
                    width: Math.max(6, (note.lengthTicks / TICKS_PER_16TH) * CELL_W - 1),
                    height: ROW_H - 2,
                    boxSizing: 'border-box',
                    borderRadius: 2,
                    border: note.selected ? '1px solid #fef08a' : '1px solid #38bdf8',
                    background: note.selected ? '#facc15' : '#0ea5e9',
                    cursor: 'grab',
                    // Während eines Drags liegen alle Blöcke "unter" dem Zeiger,
                    // damit die Rasterzellen darunter weiter Hover-Ereignisse liefern.
                    pointerEvents: drag ? 'none' : 'auto',
                  }}
                >
                  <span
                    className="piano-roll__resize-handle"
                    data-resize="true"
                    onPointerDown={(event) => handleResizePointerDown(event, note)}
                    style={{
                      position: 'absolute',
                      right: 0,
                      top: 0,
                      width: 6,
                      height: '100%',
                      cursor: 'ew-resize',
                      background: 'rgba(0, 0, 0, 0.35)',
                    }}
                  />
                </div>
              ))}
          </div>

          <div
            className="piano-roll__velocity"
            role="group"
            aria-label="Velocity-Spur"
            style={{
              position: 'relative',
              width: gridWidth,
              height: VELOCITY_LANE_H,
              marginTop: 6,
              background: '#0b1220',
              borderTop: '1px solid #1f2937',
            }}
          >
            {ghostNotes
              .filter((ghost) => isVisible(ghost.pitch))
              .map((ghost) => (
                <div
                  key={`velocity-${ghost.id}`}
                  data-ghost-velocity="true"
                  style={{
                    position: 'absolute',
                    left: (ghost.startTicks / TICKS_PER_16TH) * CELL_W,
                    bottom: 0,
                    width: 2,
                    height: Math.max(2, (ghost.velocity / MAX_VELOCITY) * (VELOCITY_LANE_H - 4)),
                    background: '#475569',
                  }}
                />
              ))}

            {notes
              .filter((note) => isVisible(note.pitch))
              .map((note) => (
              <div
                key={`velocity-${note.id}`}
                className="piano-roll__velocity-item"
                style={{
                  position: 'absolute',
                  left: (note.startTicks / TICKS_PER_16TH) * CELL_W,
                  bottom: 0,
                  width: Math.max(12, Math.min(CELL_W - 2, (note.lengthTicks / TICKS_PER_16TH) * CELL_W)),
                  height: VELOCITY_LANE_H,
                }}
              >
                <div
                  className="piano-roll__velocity-bar"
                  style={{
                    position: 'absolute',
                    left: 0,
                    bottom: 0,
                    width: '100%',
                    height: Math.max(2, (note.velocity / MAX_VELOCITY) * (VELOCITY_LANE_H - 4)),
                    background: note.selected ? '#facc15' : '#0ea5e9',
                    opacity: 0.55,
                  }}
                />
                <input
                  type="range"
                  min={MIN_VELOCITY}
                  max={MAX_VELOCITY}
                  step={1}
                  value={note.velocity}
                  aria-label={`Velocity ${note.id}`}
                  className="piano-roll__velocity-input"
                  onChange={(event) => onChange(setVelocity(notes, [note.id], Number(event.target.value)))}
                  style={{
                    position: 'absolute',
                    left: 0,
                    top: 0,
                    width: '100%',
                    height: '100%',
                    margin: 0,
                    writingMode: 'vertical-lr',
                    direction: 'rtl',
                    cursor: 'ns-resize',
                  }}
                />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export default PianoRoll;
