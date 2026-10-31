import { describe, expect, it } from 'vitest';
import { ItSynthBank, type InstrumentPitchDef } from '../src/core/instrument/itSynthVoice';

const def: InstrumentPitchDef = { id: 1, name: 'test', kind: 'synth', osc: 'sine', attack: 0.001, release: 0.01 };

function bank(notes: Array<number | string>): ItSynthBank {
  const synth = new ItSynthBank();
  synth.config(def);
  for (const note of notes) synth.noteOn(note, 1);
  return synth;
}

function render(synth: ItSynthBank, size = 128): Float32Array {
  const samples = new Float32Array(size);
  synth.renderBlock(samples);
  return samples;
}

describe('itSynth selective note release', () => {
  it('releases the requested note while retaining the other held voice', () => {
    const actual = bank([60, 64]);
    const reference = bank([60]);
    render(actual, 2048);
    render(reference, 2048);
    actual.noteOff('E4', true);
    render(actual);
    render(reference);
    expect(render(actual)).toEqual(render(reference));
  });

  it('does not release another voice when the requested note is absent', () => {
    const actual = bank([60]);
    const reference = bank([60]);
    render(actual, 2048);
    render(reference, 2048);
    actual.noteOff(64, true);
    expect(render(actual)).toEqual(render(reference));
  });
});
