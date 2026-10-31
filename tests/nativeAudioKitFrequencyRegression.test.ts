import { describe, expect, it } from 'vitest';
import { Frequency } from '../src/core/audio/compat/nativeAudioKit';

describe('nativeAudioKit Frequency', () => {
  it('converts Eb4 to the same frequency as MIDI 63', () => {
    expect(Frequency('Eb4').toFrequency()).toBeCloseTo(Frequency(63, 'midi').toFrequency(), 10);
  });

  it.each([
    ['Cb4', 59],
    ['B#3', 60],
    ['Fb4', 64],
    ['E#4', 65],
  ])('handles enharmonic boundary %s as MIDI %i', (note, midi) => {
    expect(Frequency(note).toFrequency()).toBeCloseTo(Frequency(midi, 'midi').toFrequency(), 10);
  });

  it.each([
    ['Db4', 61], ['eb4', 63], ['Gb4', 66], ['ab4', 68], ['Bb4', 70],
    ['C#4', 61], ['d#4', 63], ['F#4', 66], ['g#4', 68], ['A#4', 70],
    ['c4', 60], ['A4', 69], [' g3 ', 55], ['C-1', 0], ['B-2', -1],
    ['Cb-1', -1], ['B#-2', 0], ['G9', 127], ['G#9', 128],
  ])('converts %s to MIDI %i', (note, midi) => {
    expect(Frequency(note).toFrequency()).toBeCloseTo(Frequency(midi, 'midi').toFrequency(), 10);
  });

  it.each(['', 'H4', 'C', '4', 'C##4', 'CBB4', 'C♭4', 'C 4', 'C+4'])
    ('preserves A4 fallback for invalid note %j', (note) => {
      expect(Frequency(note).toFrequency()).toBe(440);
    });

  it('preserves numeric Hz and MIDI input behavior', () => {
    expect(Frequency(440).toFrequency()).toBe(440);
    expect(Frequency(69, 'midi').toFrequency()).toBe(440);
    expect(Frequency(0, 'midi').toFrequency()).toBeCloseTo(8.1757989156, 9);
    expect(Frequency(220, 'hz').toFrequency()).toBe(220);
  });
});
