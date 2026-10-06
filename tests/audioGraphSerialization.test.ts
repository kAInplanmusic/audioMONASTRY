import { describe, expect, it } from 'vitest';
import { emptyAudioGraphState, isAudioGraphState } from '../src/utils/audioGraphSerialization';

describe('audioGraphSerialization', () => {
  it('erzeugt einen gültigen leeren Graph', () => {
    const state = emptyAudioGraphState();
    expect(isAudioGraphState(state)).toBe(true);
    expect(state.version).toBe(1);
    expect(state.bpm).toBe(120);
    expect(Object.keys(state.patterns)).toHaveLength(8);
    expect(state.synthNotes).toHaveLength(16);
  });

  it('lehnt ungültige Objekte ab', () => {
    expect(isAudioGraphState(null)).toBe(false);
    expect(isAudioGraphState({ version: 2 })).toBe(false);
    expect(isAudioGraphState({ version: 1, bpm: '120' })).toBe(false);
    expect(isAudioGraphState({ version: 1, bpm: 120, swing: 0, gate: 0.9, scale: 'x' })).toBe(false);
  });
});
