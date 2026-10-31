import { describe, expect, it, vi } from 'vitest';
import { InstrumentBackend } from '../src/core/instrument/InstrumentBackend';

const engine = vi.hoisted(() => ({
  loadInstrument: vi.fn(async () => {}),
  instrumentNote: vi.fn(),
  instrumentRelease: vi.fn(),
  playSynthesisInstrument: vi.fn(),
}));
vi.mock('../src/utils/audioEngine', () => ({ audioEngine: engine }));

describe('InstrumentBackend multi-digit octave transposition', () => {
  it.each([
    [101, 'C10', 1, 'C#10'],
    [1, 'C-10', -1, 'B-11'],
    [101, 'B#9', 1, 'C#10'],
    [1, 'Cb10', -1, 'A#9'],
    [101, 'Cb10', 0, 'B9'],
    [101, 'B#-11', 1, 'C#-10'],
    [1, 'Cb-10', 0, 'B-11'],
  ] as const)('dispatches instrument %i: %s offset %i as %s', async (id, note, offset, expected) => {
    const backend = new InstrumentBackend();
    await backend.load(id);
    backend.setParam('transpose', offset);
    engine.instrumentNote.mockClear();
    engine.playSynthesisInstrument.mockClear();
    backend.noteOn(note);
    if (id === 1) {
      await vi.waitFor(() => expect(engine.instrumentNote).toHaveBeenCalledWith(expected));
    } else {
      await vi.waitFor(() => expect(engine.playSynthesisInstrument).toHaveBeenCalledWith(
        expect.objectContaining({ id }), expected, 1,
      ));
    }
  });
});
