import { beforeEach, describe, expect, it, vi } from 'vitest';

const { noteOn, noteOff, handleProgramChange } = vi.hoisted(() => ({
  noteOn: vi.fn(),
  noteOff: vi.fn(),
  handleProgramChange: vi.fn(),
}));

vi.mock('../src/core/instrument/InstrumentBackend', () => ({
  instrumentBackend: { noteOn, noteOff, handleProgramChange },
  InstrumentBackend: class {},
}));

import { dispatchInstrumentControl, velocityToMidi } from '../src/core/instrument/instrumentControl';

describe('instrumentControl – ControlMessage → IInstrumentBackend', () => {
  beforeEach(() => {
    noteOn.mockClear();
    noteOff.mockClear();
    handleProgramChange.mockClear();
  });

  it('noteOn: 7-Bit-Velocity wird auf 0..1 skaliert', () => {
    dispatchInstrumentControl({ kind: 'noteOn', idNum: 60, value: 127, channel: 1 });
    expect(noteOn).toHaveBeenCalledWith(60, 1);

    dispatchInstrumentControl({ kind: 'noteOn', idNum: 64, value: 64, channel: 2 });
    expect(noteOn).toHaveBeenCalledWith(64, 64 / 127);
  });

  it('noteOff: löst noteOff aus (idNum irrelevant)', () => {
    dispatchInstrumentControl({ kind: 'noteOff', idNum: 60, value: 0, channel: 1 });
    expect(noteOff).toHaveBeenCalledOnce();
  });

  it('program: reicht an handleProgramChange weiter', () => {
    dispatchInstrumentControl({ kind: 'program', idNum: 25, value: 25, channel: 3 });
    expect(handleProgramChange).toHaveBeenCalledWith(25, 3);
  });

  it('ignoriert CC/Pitch/Transport (kein Instrumenten-Event)', () => {
    dispatchInstrumentControl({ kind: 'cc', idNum: 7, value: 100, channel: 1 });
    dispatchInstrumentControl({ kind: 'pitch', idNum: 0, value: 8192, channel: 1 });
    dispatchInstrumentControl({ kind: 'start', idNum: 0, value: 0, channel: 1 });
    expect(noteOn).not.toHaveBeenCalled();
    expect(noteOff).not.toHaveBeenCalled();
    expect(handleProgramChange).not.toHaveBeenCalled();
  });

  it('velocityToMidi rundet und klemmt auf 0..127', () => {
    expect(velocityToMidi(0)).toBe(0);
    expect(velocityToMidi(1)).toBe(127);
    expect(velocityToMidi(0.5)).toBe(64);
    expect(velocityToMidi(-0.2)).toBe(0);
    expect(velocityToMidi(1.5)).toBe(127);
  });
});
