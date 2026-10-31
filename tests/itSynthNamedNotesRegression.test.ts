import { describe, expect, it } from 'vitest';
import { ItSynthBank, type InstrumentPitchDef } from '../src/core/instrument/itSynthVoice';

const def: InstrumentPitchDef = { id: 1, name: 'test', kind: 'synth', osc: 'sine', attack: 0.001 };
function render(note: number | string): Float32Array {
  const bank = new ItSynthBank();
  bank.config(def);
  bank.noteOn(note, 1);
  const result = new Float32Array(512);
  bank.renderBlock(result);
  return result;
}

describe('itSynth named note pitch', () => {
  it('renders Eb4 at the same pitch as MIDI 63', () => {
    expect(render('Eb4')).toEqual(render(63));
  });

  it.each([
    ['C4', 60], ['A4', 69], ['C#4', 61], ['B3', 59],
    ['db4', 61], ['Bb4', 70], ['Cb4', 59], ['B#3', 60], ['B-2', -1],
    ['C10', 132],
  ] as const)(
    '%s has the same waveform as MIDI %i', (name, midi) => {
      const named = render(name);
      const numeric = render(midi);
      expect(named.some((sample) => Math.abs(sample) > 0.001)).toBe(true);
      expect(named).toEqual(numeric);
    },
  );
});
