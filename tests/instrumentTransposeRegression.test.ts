import { describe, expect, it, vi } from 'vitest';
import { InstrumentBackend } from '../src/core/instrument/InstrumentBackend';

const engine = vi.hoisted(() => ({
  loadInstrument: vi.fn(async () => {}),
  instrumentNote: vi.fn(),
  instrumentRelease: vi.fn(),
  playSynthesisInstrument: vi.fn(),
}));
vi.mock('../src/utils/audioEngine', () => ({ audioEngine: engine }));

describe('InstrumentBackend transposition regression', () => {
  it.each([1, 101])('passes an untransposed Eb4 as D#4 to engine for instrument %i', async (id) => {
    const backend = new InstrumentBackend();
    await backend.load(id);
    engine.instrumentNote.mockClear();
    engine.playSynthesisInstrument.mockClear();
    backend.noteOn('Eb4');
    if (id === 1) {
      await vi.waitFor(() => expect(engine.instrumentNote).toHaveBeenCalledWith('D#4'));
    } else {
      await vi.waitFor(() => expect(engine.playSynthesisInstrument).toHaveBeenCalledWith(
        expect.objectContaining({ id }), 'D#4', 1,
      ));
    }
  });

  it('transposes C-1 down to B-2 before passing it to the synthesis engine', async () => {
    const backend = new InstrumentBackend();
    await backend.load(101);
    backend.setParam('transpose', -1);
    engine.playSynthesisInstrument.mockClear();
    backend.noteOn('C-1');
    await vi.waitFor(() => expect(engine.playSynthesisInstrument).toHaveBeenCalledWith(
      expect.objectContaining({ id: 101 }), 'B-2', 1,
    ));
  });

  it('transposes Eb4 before passing it to the synthesis engine', async () => {
    const backend = new InstrumentBackend();
    await backend.load(101);
    backend.setParam('transpose', 1);
    engine.playSynthesisInstrument.mockClear();
    backend.noteOn('Eb4');
    await vi.waitFor(() => expect(engine.playSynthesisInstrument).toHaveBeenCalledWith(
      expect.objectContaining({ id: 101 }), 'E4', 1,
    ));
  });

  it.each([
    ['db4', 1, 'D4'], ['Cb4', 1, 'C4'], ['B#3', 1, 'C#4'],
    ['C-1', -12, 'C-2'], ['C-1', -13, 'B-3'], ['B-2', 1, 'C-1'],
    ['not a note', 1, 'not a note'],
  ] as const)('transposes %s by %i semitones to %s', (note, offset, expected) => {
    const backend = new InstrumentBackend();
    backend.setParam('transpose', offset);
    const transpose = (backend as unknown as { transpose(note: string): string }).transpose.bind(backend);
    expect(transpose(note)).toBe(expected);
  });

  it('passes a transposed flat to the acoustic engine as a sharp name', async () => {
    const backend = new InstrumentBackend();
    await backend.load(1);
    backend.setParam('transpose', 1);
    engine.instrumentNote.mockClear();
    backend.noteOn('Db4');
    await vi.waitFor(() => expect(engine.instrumentNote).toHaveBeenCalledWith('D4'));
  });

  it('transposes a named note by one semitone without changing octave', () => {
    const backend = new InstrumentBackend();
    backend.setParam('transpose', 1);
    const transpose = (backend as unknown as { transpose(note: string): string }).transpose.bind(backend);
    expect(transpose('C4')).toBe('C#4');
    expect(transpose('B3')).toBe('C4');
    backend.setParam('transpose', -1);
    expect(transpose('C4')).toBe('B3');
  });
});
