import { describe, expect, it, vi } from 'vitest';
import { InstrumentBackend } from '../src/core/instrument/InstrumentBackend';

const engine = vi.hoisted(() => ({
  loadInstrument: vi.fn(async (_id: number) => {}),
  instrumentNote: vi.fn((_note: string | number) => {}),
  instrumentRelease: vi.fn(),
  playSynthesisInstrument: vi.fn(),
}));
vi.mock('../src/utils/audioEngine', () => ({ audioEngine: engine }));

describe('event-time instrument state', () => {
  it('keeps two acoustic patch loads and their notes in event order', async () => {
    const calls: string[] = [];
    engine.loadInstrument.mockImplementation(async (id) => { calls.push(`load:${id}`); });
    engine.instrumentNote.mockImplementation((note) => { calls.push(`note:${note}`); });
    engine.instrumentRelease.mockImplementation(() => { calls.push('off'); });
    try {
      const backend = new InstrumentBackend();
      const first = backend.load(1);
      backend.noteOn('C4');
      backend.noteOff();
      const second = backend.load(2);
      backend.noteOn('D4');
      backend.noteOff();
      await Promise.all([first, second]);
      await vi.waitFor(() => expect(calls).toEqual(['load:1', 'note:C4', 'off', 'load:2', 'note:D4', 'off']));
    } finally {
      engine.loadInstrument.mockReset().mockImplementation(async () => {});
      engine.instrumentNote.mockReset();
      engine.instrumentRelease.mockReset();
    }
  });
  it('waits for an acoustic patch to finish loading before note-on and preserves note-off order', async () => {
    let finish!: () => void;
    const ready = new Promise<void>((resolve) => { finish = resolve; });
    engine.loadInstrument.mockImplementationOnce(() => ready);
    engine.instrumentNote.mockClear();
    engine.instrumentRelease.mockClear();
    const backend = new InstrumentBackend();
    await backend.load(101);
    const loading = backend.load(1);
    backend.noteOn('C4');
    backend.noteOff();
    await vi.waitFor(() => expect(engine.loadInstrument).toHaveBeenCalledWith(1));
    expect(engine.instrumentNote).not.toHaveBeenCalled();
    finish();
    await loading;
    await vi.waitFor(() => expect(engine.instrumentRelease).toHaveBeenCalledTimes(1));
    expect(engine.instrumentNote).toHaveBeenCalledWith('C4');
    expect(engine.instrumentNote.mock.invocationCallOrder[0]).toBeLessThan(engine.instrumentRelease.mock.invocationCallOrder[0]);
  });
  it('dispatches the note-on snapshot and note-off in order after a same-turn state change', async () => {
    const backend = new InstrumentBackend();
    await backend.load(101);
    engine.instrumentRelease.mockClear();
    engine.playSynthesisInstrument.mockClear();
    backend.setParam('transpose', 1);
    backend.setParam('velocity', 0.5);
    backend.setParam('gain', 0.8);
    backend.noteOn('C4');
    backend.noteOff();
    const secondLoad = backend.load(102);
    backend.setParam('transpose', -1);
    backend.setParam('velocity', 1);
    backend.setParam('gain', 1);
    await secondLoad;
    await vi.waitFor(() => expect(engine.instrumentRelease).toHaveBeenCalledTimes(1));
    expect(engine.playSynthesisInstrument).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: 101 }), 'C#4', 0.4,
    );
    expect(engine.playSynthesisInstrument.mock.invocationCallOrder[0]).toBeLessThan(
      engine.instrumentRelease.mock.invocationCallOrder[0],
    );
  });
});
