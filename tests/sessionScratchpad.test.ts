// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  MONK_DRAG_MIME,
  MONK_SCRATCH_MIME,
  buildSessionSnapshot,
  createScratchpadId,
  createScratchpadSnapshot,
  loadSessionScratchpad,
  readMonkDragItem,
  saveSessionScratchpad,
  writeMonkDragItem,
  writeMonkScratchItem,
} from '../src/core/session/sessionScratchpad';

describe('P1-4: Session-Scratchpad (IndexedDB-Adapter)', () => {
  it('erzeugt stabile Scratchpad-IDs', () => {
    const id = createScratchpadId('Dark Warehouse Set');
    expect(id.startsWith('scratch-dark-warehouse-set-')).toBe(true);
    expect(createScratchpadId('!!!').startsWith('scratch-session-')).toBe(true);
  });

  it('lädt in Umgebungen ohne IndexedDB defensiv null', async () => {
    expect(await loadSessionScratchpad()).toBeNull();
  });

  it('speichern ist fire-and-forget (kein Wurf ohne IndexedDB)', async () => {
    await expect(
      saveSessionScratchpad({
        id: createScratchpadId('test'),
        name: 'test',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        snapshot: { bpm: 128, isPlaying: false, patterns: {}, moduleStates: {}, mixer: {}, routing: {} },
      }),
    ).resolves.toBeUndefined();
  });

  it('buildSessionSnapshot ist pure und liefert Defaults', () => {
    const snap = buildSessionSnapshot({ drum: 'PRO', mixer: 'OFF' }, 128, true);
    expect(snap.bpm).toBe(128);
    expect(snap.isPlaying).toBe(true);
    expect(snap.moduleStates).toEqual({ drum: 'PRO', mixer: 'OFF' });
    expect(snap.patterns).toEqual({});
    expect(snap.mixer).toEqual({});
    expect(snap.routing).toEqual({});
    // Keine Referenz auf das Eingabe-Objekt (Defensive Copy).
    const states = { drum: 'AUTO_AI' };
    const snap2 = buildSessionSnapshot(states, 120, false);
    states.drum = 'OFF';
    expect(snap2.moduleStates.drum).toBe('AUTO_AI');
  });

  it('createScratchpadSnapshot setzt Timestamps und übernimmt Zusatzfelder', () => {
    const item = createScratchpadSnapshot('Live Set', { synth: 'AUTO_AI' }, 132, false, {
      patterns: { drum: [true, false] },
    });
    expect(item.name).toBe('Live Set');
    expect(item.snapshot.bpm).toBe(132);
    expect(item.snapshot.moduleStates.synth).toBe('AUTO_AI');
    expect(item.snapshot.patterns.drum).toEqual([true, false]);
    expect(item.createdAt).toBeLessThanOrEqual(Date.now());
    expect(item.updatedAt).toBe(item.createdAt);
  });

  it('DnD-Items werden verlustfrei geschrieben und gelesen', () => {
    const store = new Map<string, string>();
    const dt = {
      setData: (mime: string, value: string) => store.set(mime, value),
      getData: (mime: string) => store.get(mime) ?? '',
    };
    const item = { type: 'module' as const, id: 'drum', name: 'drumMONK', state: 'PRO' };
    writeMonkDragItem({ dataTransfer: dt }, item);
    expect(JSON.parse(store.get(MONK_DRAG_MIME) ?? '')).toEqual(item);

    const read = readMonkDragItem({ dataTransfer: dt });
    expect(read).toEqual(item);

    // Eigener MIME fürs Herausziehen aus dem Scratchpad.
    const entry = { type: 'scratchpad' as const, id: 'drum', name: 'drumMONK', addedAt: 1 };
    const dt2 = {
      setData: (mime: string, value: string) => store.set(mime, value),
      getData: (mime: string) => store.get(mime) ?? '',
    };
    writeMonkScratchItem({ dataTransfer: dt2 }, entry);
    const readEntry = readMonkDragItem({ dataTransfer: dt2 }, MONK_SCRATCH_MIME);
    expect(readEntry?.type).toBe('scratchpad');
  });

  it('readMonkDragItem ignoriert kaputte Daten defensiv', () => {
    const dt = {
      getData: () => '{invalid-json',
    };
    expect(readMonkDragItem({ dataTransfer: dt })).toBeNull();
    expect(readMonkDragItem({ dataTransfer: null })).toBeNull();
  });
});
