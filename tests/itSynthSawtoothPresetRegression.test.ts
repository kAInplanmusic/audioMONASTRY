import { expect, it } from 'vitest';
import { SYNTHESIS_INSTRUMENTS } from '../src/core/instrument/catalog';
import { ItSynthBank, type InstrumentPitchDef } from '../src/core/instrument/itSynthVoice';

function render(def: InstrumentPitchDef): Float32Array {
  const bank = new ItSynthBank();
  bank.config(def);
  bank.noteOn(69, 1);
  const output = new Float32Array(2048);
  bank.renderBlock(output);
  return output;
}

it('renders catalog preset 101 sawtooth as saw rather than sine', () => {
  const preset = SYNTHESIS_INSTRUMENTS.find((instrument) => instrument.id === 101);
  if (!preset || preset.kind !== 'synth') throw new Error('Synth preset 101 is missing');
  expect(preset.osc).toBe('sawtooth');

  const sawtooth = render(preset);
  const saw = render({ ...preset, osc: 'saw' });
  const sine = render({ ...preset, osc: 'sine' });
  expect(sawtooth.every(Number.isFinite)).toBe(true);
  expect(Math.max(...sawtooth.map(Math.abs))).toBeGreaterThan(0.001);
  const maxDifference = (a: Float32Array, b: Float32Array) =>
    Math.max(...a.map((sample, index) => Math.abs(sample - b[index])));
  expect(maxDifference(sawtooth, saw)).toBeLessThan(1e-7);
  expect(maxDifference(sawtooth, sine)).toBeGreaterThan(0.001);
});
