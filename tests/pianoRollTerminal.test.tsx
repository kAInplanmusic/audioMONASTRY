/**
 * PianoRollTerminal – jsdom Panel-Tests (ZUK-001)
 * ==============================================
 * Prüft: Panel rendert Titel, Einklappen, Spurwahl; Noten aus dem Store;
 * Edit (Add/Move/Velocity) schreibt zurück in denselben Store (Identität);
 * Re-Render überlebt; leerer Store crasht nicht.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { pianoRollStore, createPianoRollStore } from '../src/core/sequencer/pianoRollStore';
import { TICKS_PER_16TH, TICKS_PER_QUARTER } from '../src/core/sequencer/pianoRollModel';
import { PianoRollTerminal } from '../src/components/am/PianoRollTerminal';

// Mock Plugin-Settings (verhindert WebRTCManager-Import)
const mockSettings = new Map<string, Record<string, unknown>>();
vi.mock('../src/utils/pluginSettings', () => ({
  readPluginSettings: (id: string) => mockSettings.get(id) ?? null,
  writePluginSettings: (id: string, s: Record<string, unknown>) => { mockSettings.set(id, s); },
}));

function makeNote(overrides: Partial<{ id: string; pitch: number; startTicks: number; lengthTicks: number; velocity: number }> = {}) {
  return {
    id: overrides.id ?? `note-${crypto.randomUUID()}`,
    pitch: overrides.pitch ?? 60,
    startTicks: overrides.startTicks ?? 0,
    lengthTicks: overrides.lengthTicks ?? TICKS_PER_QUARTER / 4,
    velocity: overrides.velocity ?? 100,
    selected: false,
  };
}

describe('ZUK-001 · PianoRollTerminal (jsdom)', () => {
  let testStore: ReturnType<typeof createPianoRollStore>;

  beforeEach(() => {
    mockSettings.clear();
    testStore = createPianoRollStore();
    cleanup();
  });

  afterEach(() => {
    cleanup();
  });

  it('rendert Titel, Collapse-Toggle und Spur-Selektor', () => {
    render(<PianoRollTerminal store={testStore} />);

    expect(screen.getByText('Piano Roll')).toBeTruthy();
    expect(screen.getByRole('button', { name: /einklappen|ausklappen/i })).toBeTruthy();
    expect(screen.getByLabelText('Piano-Roll-Spur')).toBeTruthy();
  });

  it('zeigt leere Piano-Roll ohne Crash (keine Noten im Store)', () => {
    render(<PianoRollTerminal store={testStore} />);

    // Grid & Velocity-Spur rendern
    expect(screen.getByLabelText('Piano-Roll-Raster')).toBeTruthy();
    expect(screen.getByLabelText('Velocity-Spur')).toBeTruthy();
    // Subtitle zeigt 0 Noten
    expect(screen.getByText(/0 Noten/)).toBeTruthy();
  });

  it('rendert Noten aus dem Store', async () => {
    const n1 = makeNote({ id: 'note-1', pitch: 60, startTicks: 0 });
    const n2 = makeNote({ id: 'note-2', pitch: 64, startTicks: TICKS_PER_16TH * 4 });
    testStore.setNotes('channel1', [n1, n2]);

    const { container } = render(<PianoRollTerminal store={testStore} />);

    await waitFor(() => {
      // Zwei Noten-Blöcke im DOM (data-note-id)
      expect(container.querySelector('[data-note-id="note-1"]')).toBeTruthy();
      expect(container.querySelector('[data-note-id="note-2"]')).toBeTruthy();
    });
  });

  it('Edit (Add): Klick in Zelle fügt Note hinzu und schreibt in Store', async () => {
    render(<PianoRollTerminal store={testStore} />);

    // Zelle C4 (pitch 60), 16tel 1 (tick 0) anklicken
    const cell = screen.getByLabelText('C4 16tel 1');
    await act(async () => fireEvent.click(cell));

    await waitFor(() => {
      expect(testStore.getNotes('channel1')).toHaveLength(1);
      const added = testStore.getNotes('channel1')[0];
      expect(added.pitch).toBe(60);
      expect(added.startTicks).toBe(0);
    });
  });

  it('Edit (Move): Drag einer Note verschiebt sie und schreibt in Store', async () => {
    const n1 = makeNote({ id: 'note-move', pitch: 60, startTicks: 0 });
    testStore.setNotes('channel1', [n1]);

    const { container } = render(<PianoRollTerminal store={testStore} />);

    const noteBlock = container.querySelector('[data-note-id="note-move"]');
    expect(noteBlock).toBeTruthy();
    
    // PointerDown auf Note, PointerOver auf Zielzelle (C4, 16tel 5 = tick 4*TICKS_PER_16TH), PointerUp
    await act(async () => fireEvent.pointerDown(noteBlock!));
    const targetCell = screen.getByLabelText('C4 16tel 5');
    await act(async () => fireEvent.pointerOver(targetCell));
    await act(async () => fireEvent.pointerUp(targetCell));

    await waitFor(() => {
      const moved = testStore.getNotes('channel1')[0];
      expect(moved.startTicks).toBe(TICKS_PER_16TH * 4);
    });
  });

  it('Edit (Velocity): Slider ändert Velocity und schreibt in Store', async () => {
    const n1 = makeNote({ id: 'note-vel', pitch: 60, startTicks: 0, velocity: 80 });
    testStore.setNotes('channel1', [n1]);

    render(<PianoRollTerminal store={testStore} />);

    const velocityInput = screen.getByLabelText('Velocity note-vel');
    await act(async () => fireEvent.change(velocityInput, { target: { value: '120' } }));

    await waitFor(() => {
      expect(testStore.getNotes('channel1')[0].velocity).toBe(120);
    });
  });

  it('Re-Render überlebt: Store-Identität bleibt, Noten erhalten', async () => {
    const n1 = makeNote({ id: 'note-survive', pitch: 60, startTicks: 0 });
    testStore.setNotes('channel1', [n1]);

    const { container, rerender } = render(<PianoRollTerminal store={testStore} />);
    await waitFor(() => expect(container.querySelector('[data-note-id="note-survive"]')).toBeTruthy());

    // Re-render mit gleicher Props – Store bleibt identisch
    rerender(<PianoRollTerminal store={testStore} />);

    await waitFor(() => {
      expect(container.querySelector('[data-note-id="note-survive"]')).toBeTruthy();
      expect(testStore.getNotes('channel1')).toHaveLength(1);
    });
  });

  it('Store-Identität: Panel nutzt exakt die übergebene Store-Instanz (keine Kopie)', async () => {
    // Wir übergeben unseren testStore und prüfen, dass Änderungen genau dort landen
    const externalStore = createPianoRollStore();
    const n1 = makeNote({ id: 'id-external', pitch: 67, startTicks: TICKS_PER_16TH * 2 });
    externalStore.setNotes('channel1', [n1]);

    const { container } = render(<PianoRollTerminal store={externalStore} />);

    await waitFor(() => expect(container.querySelector('[data-note-id="id-external"]')).toBeTruthy());

    // Jetzt im Panel eine Note hinzufügen (Klick in leere Zelle D4 16tel 1 = pitch 62, tick 0)
    const cell = screen.getByLabelText('D4 16tel 1');
    await act(async () => fireEvent.click(cell));

    await waitFor(() => {
      // Die externe Instanz muss die neue Note enthalten
      const notes = externalStore.getNotes('channel1');
      expect(notes).toHaveLength(2);
      expect(notes.some((n) => n.pitch === 62 && n.startTicks === 0)).toBe(true);
    });

    // Gegenbeweis: globale Singleton NICHT betroffen
    expect(pianoRollStore.getNotes('channel1')).toHaveLength(0);
  });

  it('Spur-Wechsel zeigt Noten der gewählten Spur', async () => {
    testStore.setNotes('channel1', [makeNote({ id: 'ch1-note', pitch: 60 })]);
    testStore.setNotes('channel2', [makeNote({ id: 'ch2-note', pitch: 62 })]);

    const { container } = render(<PianoRollTerminal store={testStore} />);

    await waitFor(() => expect(container.querySelector('[data-note-id="ch1-note"]')).toBeTruthy());
    expect(container.querySelector('[data-note-id="ch2-note"]')).toBeFalsy();

    // Auf Channel 2 wechseln
    const select = screen.getByLabelText('Piano-Roll-Spur');
    await act(async () => fireEvent.change(select, { target: { value: 'channel2' } }));

    await waitFor(() => {
      expect(container.querySelector('[data-note-id="ch2-note"]')).toBeTruthy();
      expect(container.querySelector('[data-note-id="ch1-note"]')).toBeFalsy();
    });
  });

  it('Collapse/Expand blendet Body ein/aus', async () => {
    testStore.setNotes('channel1', [makeNote({ id: 'n1', pitch: 60 })]);
    const { container } = render(<PianoRollTerminal store={testStore} />);

    await waitFor(() => expect(container.querySelector('[data-note-id="n1"]')).toBeTruthy());

    // Einklappen
    const toggle = screen.getByRole('button', { name: /einklappen/i });
    await act(async () => fireEvent.click(toggle));
    // Body is display:none, but element still in DOM; prüfen, dass es versteckt ist
    const body = container.querySelector('#pr-body') as HTMLElement | null;
    expect(body?.style.display).toBe('none');
    expect(screen.getByRole('button', { name: /ausklappen/i })).toBeTruthy();

    // Ausklappen
    await act(async () => fireEvent.click(screen.getByRole('button', { name: /ausklappen/i })));
    await waitFor(() => expect(container.querySelector('[data-note-id="n1"]')).toBeTruthy());
  });

  it('Persistenz: writePluginSettings wird bei Änderung aufgerufen', async () => {
    render(<PianoRollTerminal store={testStore} />);
    const cell = screen.getByLabelText('C4 16tel 1');
    await act(async () => fireEvent.click(cell));

    await waitFor(() => {
      expect(mockSettings.has('pianoroll')).toBe(true);
      const settings = mockSettings.get('pianoroll');
      expect(settings).toHaveProperty('version', 1);
      expect(settings).toHaveProperty('tracks');
    });
  });
});