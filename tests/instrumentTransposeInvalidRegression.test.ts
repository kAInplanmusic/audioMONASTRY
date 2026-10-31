import { describe, expect, it, vi } from 'vitest';
import { InstrumentBackend } from '../src/core/instrument/InstrumentBackend';
import { storageSet, storageRemove } from '../src/utils/storage';

const engine = vi.hoisted(() => ({
  loadInstrument: vi.fn(async () => {}),
  instrumentNote: vi.fn(), instrumentRelease: vi.fn(), playSynthesisInstrument: vi.fn(),
}));
vi.mock('../src/utils/audioEngine', () => ({ audioEngine: engine }));

describe('transpose integer validation', () => {
  it('rejects a persisted invalid transpose without changing the current preset', async () => {
    const backend = new InstrumentBackend();
    await backend.load(101);
    backend.setParam('transpose', 1);
    const key = 'monk_instrument_invalid-transpose-race-regression';
    storageSet(key, JSON.stringify({ ...backend.getParams(), transpose: 0.5 }));
    try {
      expect(await backend.loadPreset('invalid-transpose-race-regression')).toBeNull();
      expect(backend.getParams().transpose).toBe(1);
    } finally {
      storageRemove(key);
    }
  });
  it.each([0.5, -0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'ignores invalid transpose %s, retaining the previous valid value', async (value) => {
      const backend = new InstrumentBackend();
      await backend.load(101);
      backend.setParam('transpose', 1);
      backend.setParam('transpose', value);
      expect(backend.getParams().transpose).toBe(1);
      engine.playSynthesisInstrument.mockClear();
      backend.noteOn('C4');
      await vi.waitFor(() => expect(engine.playSynthesisInstrument).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ id: 101 }), 'C#4', 1,
      ));
    },
  );
});
