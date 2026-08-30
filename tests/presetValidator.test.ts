import { describe, expect, it } from 'vitest';
import { validatePreset, validateTrackPreset, normalizePatterns } from '../src/utils/presetValidator';

const validPreset = {
  global: { tempo: 128, masterVolume: -6 },
  tracks: [
    { id: 'channel1', instrument: 'kickSynth', output: 'bus-a', patterns: Array(16).fill(false) },
  ],
  buses: [{ id: 'bus-a', output: 'destination' }],
  connections: [{ source: 'channel1', destination: 'bus-a' }],
};

describe('presetValidator', () => {
  it('validiert ein korrektes Preset', () => {
    expect(validatePreset(validPreset).global?.tempo).toBe(128);
  });

  it('wirft bei ungültigen Presets', () => {
    expect(() => validatePreset({ tracks: 'kaputt' })).toThrow();
  });

  it('prüft Track-Patterns', () => {
    const good = Object.fromEntries(
      ['channel1', 'channel2', 'channel3', 'channel4', 'channel5', 'channel6', 'channel7', 'channel8']
        .map((k) => [k, Array(16).fill(false)]),
    );
    expect(validateTrackPreset(good)).toBe(true);
    expect(validateTrackPreset({ channel1: [true] })).toBe(false);
    expect(validateTrackPreset(null)).toBe(false);
  });

  it('normalisiert Patterns auf 8 Spuren à 16 Steps', () => {
    const normalized = normalizePatterns({ channel1: [true, false, true] });
    expect(normalized.channel1).toHaveLength(16);
    expect(normalized.channel1[0]).toBe(true);
    expect(normalized.channel7).toHaveLength(16);
  });
});
