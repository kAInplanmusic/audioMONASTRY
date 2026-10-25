/**
 * PianoRollStore – Core-Store-Tests (ZUK-001)
 * ==========================================
 * Pure-Logic-Tests (node env, kein jsdom), prüfen Store-Invarianten,
 * Sanitize, Subscribe, Serialisierung, Hydration-Idempotenz.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pianoRollStore, createPianoRollStore, type PianoRollStoreSettings } from '../src/core/sequencer/pianoRollStore';
import { TICKS_PER_QUARTER, MAX_PITCH, MIN_VELOCITY, MAX_VELOCITY } from '../src/core/sequencer/pianoRollModel';

function makeNote(overrides: Partial<PianoRollStoreSettings['tracks']['channel1'][0]> = {}) {
  return {
    id: crypto.randomUUID(),
    pitch: 60,
    startTicks: 0,
    lengthTicks: TICKS_PER_QUARTER / 4,
    velocity: 100,
    selected: false,
    ...overrides,
  };
}

describe('ZUK-001 · PianoRollStore (Core)', () => {
  let store: ReturnType<typeof createPianoRollStore>;

  beforeEach(() => {
    store = createPianoRollStore();
  });

  afterEach(() => {
    store.reset();
  });

  it('liefert leere Noten-Arrays für alle Spuren', () => {
    for (const track of ['channel1', 'channel2', 'channel3']) {
      expect(store.getNotes(track)).toEqual([]);
    }
  });

  it('setNotes speichert sanitisierte Noten und erhöht Revision', () => {
    const n1 = makeNote({ pitch: 64, startTicks: 480, velocity: 80 });
    const snap0 = store.getSnapshot();
    const changed = store.setNotes('channel1', [n1]);
    const snap1 = store.getSnapshot();

    expect(changed).toBe(true);
    expect(snap1.revision).toBe(snap0.revision + 1);
    expect(store.getNotes('channel1')).toHaveLength(1);
    expect(store.getNotes('channel1')[0]).toMatchObject({
      pitch: 64,
      startTicks: 480,
      velocity: 80,
    });
  });

  it('setNotes mit identischem Inhalt ändert Revision NICHT', () => {
    const n1 = makeNote();
    store.setNotes('channel1', [n1]);
    const revBefore = store.getSnapshot().revision;
    store.setNotes('channel1', [n1]); // gleiche Referenz-Inhalte
    expect(store.getSnapshot().revision).toBe(revBefore);
  });

  it('sanitize: pitch außerhalb 0–127 wird gekappt', () => {
    store.setNotes('channel1', [makeNote({ pitch: -5 }), makeNote({ pitch: 200 })]);
    const notes = store.getNotes('channel1');
    expect(notes[0].pitch).toBe(0);
    expect(notes[1].pitch).toBe(MAX_PITCH);
  });

  it('sanitize: velocity außerhalb 1–127 wird gekappt', () => {
    store.setNotes('channel1', [makeNote({ velocity: 0 }), makeNote({ velocity: 200 })]);
    const notes = store.getNotes('channel1');
    expect(notes[0].velocity).toBe(MIN_VELOCITY);
    expect(notes[1].velocity).toBe(MAX_VELOCITY);
  });

  it('sanitize: negative startTicks → 0, lengthTicks < 16tel → 16tel', () => {
    store.setNotes('channel1', [
      makeNote({ startTicks: -100, lengthTicks: 10 }),
      makeNote({ lengthTicks: 0 }),
    ]);
    const notes = store.getNotes('channel1');
    expect(notes[0].startTicks).toBe(0);
    expect(notes[0].lengthTicks).toBeGreaterThanOrEqual(TICKS_PER_QUARTER / 16);
    expect(notes[1].lengthTicks).toBeGreaterThanOrEqual(TICKS_PER_QUARTER / 16);
  });

  it('sanitize: fehlende/ungültige id → neue UUID, missing fields → Defaults', () => {
    store.setNotes('channel1', [
      { pitch: 62, startTicks: 0 } as any,
      { id: '', pitch: 64, startTicks: 0 } as any,
    ]);
    const notes = store.getNotes('channel1');
    expect(notes).toHaveLength(2);
    expect(typeof notes[0].id === 'string' && notes[0].id.length > 0).toBe(true);
    expect(typeof notes[1].id === 'string' && notes[1].id.length > 0).toBe(true);
  });

  it('subscribe wird bei Änderung benachrichtigt', () => {
    let calls = 0;
    const unsub = store.subscribe(() => { calls++; });
    store.setNotes('channel1', [makeNote()]);
    store.setNotes('channel1', [makeNote()]);
    unsub();
    store.setNotes('channel1', [makeNote()]);
    expect(calls).toBe(2);
  });

  it('serialisierung & hydratation (load) sind rundlauf-fest', () => {
    const original = [
      makeNote({ pitch: 60, startTicks: 0 }),
      makeNote({ pitch: 64, startTicks: 480 }),
    ];
    store.setNotes('channel1', original);
    const serialized = store.serialize();

    const fresh = createPianoRollStore();
    const loaded = fresh.load(serialized);
    expect(loaded).toBe(true);
    expect(fresh.getNotes('channel1')).toHaveLength(2);
    expect(fresh.getNotes('channel1')[0].pitch).toBe(60);
    expect(fresh.getNotes('channel1')[1].pitch).toBe(64);
    // Serialisierung des geladenen = Original (bis auf id-Regenerierung bei Defaults)
    expect(fresh.serialize()).toEqual(serialized);
  });

  it('load ist idempotent: zweiter load auf gleichem Store wirkt nicht', () => {
    const s = store.serialize();
    store.load(s); // erster load
    const rev1 = store.getSnapshot().revision;
    const loadedAgain = store.load(s);
    expect(loadedAgain).toBe(false);
    expect(store.getSnapshot().revision).toBe(rev1);
  });

  it('load auf bereits befülltem Store (pristine=false) wirkt nicht', () => {
    store.setNotes('channel1', [makeNote()]); // macht pristine=false
    const revBefore = store.getSnapshot().revision;
    const loaded = store.load({ version: 1, tracks: { channel1: [makeNote({ pitch: 99 })] } });
    expect(loaded).toBe(false);
    expect(store.getSnapshot().revision).toBe(revBefore);
    expect(store.getNotes('channel1')[0].pitch).not.toBe(99);
  });

  it('isEmpty spiegelt den Zustand wider', () => {
    expect(store.isEmpty()).toBe(true);
    store.setNotes('channel1', [makeNote()]);
    expect(store.isEmpty()).toBe(false);
    store.setNotes('channel1', []);
    expect(store.isEmpty()).toBe(true);
  });

  it('reset setzt Store auf Werkseinstellung', () => {
    store.setNotes('channel1', [makeNote()]);
    store.reset();
    expect(store.isEmpty()).toBe(true);
    expect(store.getSnapshot().revision).toBe(0);
    expect(store.isPristine()).toBe(true);
  });

  it('setAllNotes setzt mehrere Spuren atomar', () => {
    store.setAllNotes({
      channel1: [makeNote({ pitch: 60 })],
      channel2: [makeNote({ pitch: 62 }), makeNote({ pitch: 64 })],
    });
    expect(store.getNotes('channel1')).toHaveLength(1);
    expect(store.getNotes('channel2')).toHaveLength(2);
    expect(store.getNotes('channel3')).toHaveLength(0);
  });
});