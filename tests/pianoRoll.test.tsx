// @vitest-environment jsdom
/**
 * ZUK-001 · Piano-Roll-Component (DOM/kein Canvas)
 * ================================================
 * Prüft das, was nur die View leisten kann: Raster (Pitch-Zeilen × 16tel),
 * Klick zum Anlegen, Drag zum Verschieben, Griff zum Verlängern, Velocity-Spur
 * (vertikaler Slider), Akkord-Stempel und die visuell unterscheidbaren
 * Ghost-Noten (read-only, nicht greifbar).
 */
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PianoRoll } from '../src/components/piano/PianoRoll';
import {
  projectGhostNotes,
  type GhostNote,
  type PianoRollNote,
} from '../src/core/sequencer/pianoRollModel';

afterEach(() => cleanup());

function note(
  id: string,
  pitch: number,
  startTicks = 0,
  lengthTicks = 240,
  velocity = 100,
): PianoRollNote {
  return { id, pitch, startTicks, lengthTicks, velocity, selected: false };
}

function Harness({ initial = [], ghosts = [] }: { initial?: PianoRollNote[]; ghosts?: GhostNote[] }) {
  const [notes, setNotes] = useState<PianoRollNote[]>(initial);
  return <PianoRoll notes={notes} onChange={(next) => setNotes(next)} ghostNotes={ghosts} />;
}

function cell(container: HTMLElement, pitch: number, tick: number): HTMLElement {
  const element = container.querySelector<HTMLElement>(`[data-cell="${pitch}:${tick}"]`);
  if (!element) throw new Error(`Zelle ${pitch}:${tick} nicht gerendert`);
  return element;
}

function noteBlocks(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-note-id]'));
}

describe('ZUK-001 · Piano-Roll-Raster', () => {
  it('rendert 24 Pitch-Zeilen × 16 16tel-Spalten plus Klaviatur', () => {
    const { container } = render(<Harness />);
    expect(container.querySelectorAll('[data-cell]')).toHaveLength(24 * 16);
    expect(container.querySelectorAll('[data-pitch-key]')).toHaveLength(24);
    // Default-Bereich ist C3…B4.
    expect(container.querySelector('[data-pitch-key="48"]')!.textContent).toBe('C3');
    expect(container.querySelector('[data-pitch-key="71"]')!.textContent).toBe('B4');
    expect(screen.getByLabelText('C4 16tel 1')).toBeTruthy();
    expect(screen.getByLabelText('C4 16tel 16')).toBeTruthy();
    expect(screen.getByLabelText('Piano-Roll-Raster')).toBeTruthy();
    expect(screen.getByLabelText('Velocity-Spur')).toBeTruthy();
  });

  it('legt per Klick eine 16tel-Note an und rechnet Tick → Spalte', () => {
    const { container } = render(<Harness />);
    fireEvent.click(cell(container, 60, 480));

    const blocks = noteBlocks(container);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].getAttribute('aria-label')).toBe('Note C4 bei Tick 480');
    // 480 Ticks = Spalte 2 → left 56px; 240 Ticks Länge → 27px breit.
    expect(blocks[0].style.left).toBe('56px');
    expect(blocks[0].style.width).toBe('27px');
    expect(blocks[0].style.top).toBe(`${(71 - 60) * 14 + 1}px`);
  });

  it('rendert Noten ausserhalb des sichtbaren Pitch-Bereichs nicht', () => {
    const { container } = render(<Harness initial={[note('note-1', 20, 0), note('note-2', 60, 0)]} />);
    expect(noteBlocks(container)).toHaveLength(1);
    expect(noteBlocks(container)[0].getAttribute('aria-label')).toBe('Note C4 bei Tick 0');
  });

  it('respektiert columns/lowestPitch/pitchRows als Props', () => {
    const { container } = render(
      <PianoRoll notes={[]} onChange={() => {}} columns={8} lowestPitch={36} pitchRows={12} />,
    );
    expect(container.querySelectorAll('[data-cell]')).toHaveLength(12 * 8);
    expect(container.querySelector('[data-pitch-key="36"]')!.textContent).toBe('C2');
    expect(container.querySelector('[data-pitch-key="47"]')!.textContent).toBe('B2');
    expect(container.querySelector('[data-cell="48:0"]')).toBeNull();
  });
});

describe('ZUK-001 · Ghost-Noten in der View', () => {
  const ghosts = projectGhostNotes([{ trackId: 'lead', notes: [note('note-7', 67, 240)] }]);

  it('zeigt Ghost-Noten gestrichelt, markiert und ohne Griff', () => {
    const { container } = render(<Harness ghosts={ghosts} />);
    const ghost = container.querySelector<HTMLElement>('[data-ghost="true"]')!;
    expect(ghost).toBeTruthy();
    expect(ghost.classList.contains('piano-roll__note--ghost')).toBe(true);
    expect(ghost.getAttribute('aria-readonly')).toBe('true');
    expect(ghost.getAttribute('data-ghost-source')).toBe('lead');
    expect(ghost.hasAttribute('data-note-id')).toBe(false);
    expect(ghost.querySelector('[data-resize="true"]')).toBeNull();
    expect(ghost.style.pointerEvents).toBe('none');
  });

  it('legt beim Klick auf eine Ghost-Note keine neue Note an', () => {
    const { container } = render(<Harness ghosts={ghosts} />);
    const ghost = container.querySelector<HTMLElement>('[data-ghost="true"]')!;
    fireEvent.click(ghost);
    expect(noteBlocks(container)).toHaveLength(0);
  });
});

describe('ZUK-001 · Drag: verschieben und verlängern', () => {
  it('verschiebt eine Note per Pointer-Drag auf eine andere Zelle', () => {
    const { container } = render(<Harness initial={[note('note-1', 60, 0)]} />);
    const block = noteBlocks(container)[0];

    fireEvent.pointerDown(block);
    fireEvent.pointerOver(cell(container, 62, 240));
    fireEvent.pointerUp(container);

    const moved = noteBlocks(container)[0];
    expect(moved.getAttribute('aria-label')).toBe('Note D4 bei Tick 240');
    expect(moved.style.left).toBe('28px');
  });

  it('verlängert eine Note über den Griff am rechten Rand', () => {
    const { container } = render(<Harness initial={[note('note-1', 60, 0)]} />);
    const handle = noteBlocks(container)[0].querySelector<HTMLElement>('[data-resize="true"]')!;

    fireEvent.pointerDown(handle);
    fireEvent.pointerOver(cell(container, 60, 960));
    fireEvent.pointerUp(container);

    // 960 + 240 - 0 = 1200 Ticks → 1200/240*28 - 1 = 139px
    expect(noteBlocks(container)[0].style.width).toBe('139px');
  });

  it('markiert die angefasste Note als ausgewählt', () => {
    const { container } = render(<Harness initial={[note('note-1', 60, 0), note('note-2', 64, 240)]} />);
    fireEvent.pointerDown(noteBlocks(container)[0]);
    fireEvent.pointerUp(container);

    const selected = noteBlocks(container).filter((el) => el.getAttribute('data-selected') === 'true');
    expect(selected).toHaveLength(1);
    expect(selected[0].getAttribute('aria-label')).toBe('Note C4 bei Tick 0');
  });
});

describe('ZUK-001 · Akkord-Stempel in der View', () => {
  it('stempelt den gewählten Akkord auf die geklickte Spalte', () => {
    const { container } = render(<Harness />);
    fireEvent.change(screen.getByLabelText('Akkord-Qualität'), { target: { value: 'minor' } });
    fireEvent.change(screen.getByLabelText('Akkord-Grundton'), { target: { value: '57' } });

    const stamp = screen.getByRole('button', { name: 'Akkord-Stempel' });
    fireEvent.click(stamp);
    expect(stamp.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(cell(container, 60, 240));

    const labels = noteBlocks(container).map((el) => el.getAttribute('aria-label'));
    expect(labels).toEqual(['Note A3 bei Tick 240', 'Note C4 bei Tick 240', 'Note E4 bei Tick 240']);
  });

  it('legt ohne gedrückten Stempel weiterhin Einzelnoten an', () => {
    const { container } = render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Akkord-Stempel' })); // an
    fireEvent.click(screen.getByRole('button', { name: 'Akkord-Stempel' })); // wieder aus
    fireEvent.click(cell(container, 60, 0));
    expect(noteBlocks(container)).toHaveLength(1);
  });
});

describe('ZUK-001 · Velocity-Spur', () => {
  it('ändert die Velocity über den vertikalen Slider der Spur', () => {
    const { container } = render(<Harness initial={[note('note-1', 60, 0, 240, 100)]} />);
    const slider = screen.getByLabelText('Velocity note-1') as HTMLInputElement;
    expect(slider.value).toBe('100');
    expect(slider.type).toBe('range');

    fireEvent.change(slider, { target: { value: '20' } });
    expect((screen.getByLabelText('Velocity note-1') as HTMLInputElement).value).toBe('20');
    // Balkenhöhe folgt der Velocity: 20/127 * 60 = 9.448…px
    const bar = container.querySelector<HTMLElement>('.piano-roll__velocity-bar')!;
    expect(Number.parseFloat(bar.style.height)).toBeCloseTo(9.45, 1);
  });

  it('zeigt Ghost-Noten in der Spur ohne Regler', () => {
    const ghosts = projectGhostNotes([{ trackId: 'pad', notes: [note('note-1', 55, 0)] }]);
    const { container } = render(<Harness ghosts={ghosts} />);
    expect(container.querySelectorAll('[data-ghost-velocity="true"]')).toHaveLength(1);
    expect(container.querySelectorAll('.piano-roll__velocity-input')).toHaveLength(0);
  });
});

describe('ZUK-001 · Toolbar (Quantisieren, Transponieren, Löschen)', () => {
  it('quantisiert die Noten auf das gewählte Raster', () => {
    const { container } = render(<Harness initial={[note('note-1', 60, 130)]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Quantisieren' }));
    expect(noteBlocks(container)[0].getAttribute('aria-label')).toBe('Note C4 bei Tick 240');
  });

  it('transponiert alle Noten ohne Auswahl um eine Oktave', () => {
    const { container } = render(<Harness initial={[note('note-1', 48, 0)]} />);
    fireEvent.click(screen.getByRole('button', { name: '+12' }));
    expect(noteBlocks(container)[0].getAttribute('aria-label')).toBe('Note C4 bei Tick 0');
  });

  it('löscht die ausgewählten Noten', () => {
    const { container } = render(<Harness initial={[note('note-1', 60, 0), note('note-2', 64, 480)]} />);
    const deleteButton = screen.getByRole('button', { name: 'Auswahl löschen' }) as HTMLButtonElement;
    expect(deleteButton.disabled).toBe(true);

    fireEvent.pointerDown(noteBlocks(container)[1]);
    fireEvent.pointerUp(container);
    expect(deleteButton.disabled).toBe(false);

    fireEvent.click(deleteButton);
    expect(noteBlocks(container)).toHaveLength(1);
    expect(noteBlocks(container)[0].getAttribute('aria-label')).toBe('Note C4 bei Tick 0');
  });
});
