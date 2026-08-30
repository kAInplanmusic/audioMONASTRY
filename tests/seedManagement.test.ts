import { describe, expect, it } from 'vitest';
import { hashString, mulberry32, SeedManager } from '../src/core/session/seedManagement';

describe('seedManagement', () => {
  it('hashString ist deterministisch', () => {
    expect(hashString('audio')).toBe(hashString('audio'));
    expect(hashString('audio')).not.toBe(hashString('musik'));
  });

  it('mulberry32 liefert deterministische Sequenzen', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const seqA = Array.from({ length: 5 }, () => a());
    const seqB = Array.from({ length: 5 }, () => b());
    expect(seqA).toEqual(seqB);
    expect(seqA.every((v) => v >= 0 && v < 1)).toBe(true);
  });

  it('SeedManager erzeugt stabile Preset-Seeds', () => {
    const sm = new SeedManager();
    expect(sm.presetSeed('kick', 123)).toBe(sm.presetSeed('kick', 123));
    expect(sm.presetSeed('kick', 123)).not.toBe(sm.presetSeed('kick', 456));
  });

  it('SeedManager serialisiert/deserialisiert State', () => {
    const sm = new SeedManager();
    sm.setSessionSeed(7);
    const state = sm.toJSON();
    const sm2 = new SeedManager();
    sm2.fromJSON(state);
    expect(sm2.sessionSeed).toBe(7);
  });
});
