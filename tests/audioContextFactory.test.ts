import { describe, expect, it } from 'vitest';
import { resolveAudioContextOptions } from '../src/utils/audioContextFactory';

describe('audioContextFactory (P2-1/P1-3)', () => {
  it('wendet latencyHint und sampleRate an', () => {
    const opts = resolveAudioContextOptions({ latencyHint: 'interactive', sampleRate: 48000 });
    expect(opts.latencyHint).toBe('interactive');
    expect(opts.sampleRate).toBe(48000);
  });

  it('akzeptiert numerische latencyHint (Sekunden)', () => {
    const opts = resolveAudioContextOptions({ latencyHint: 0.01 });
    expect(opts.latencyHint).toBe(0.01);
  });

  it('ignoriert ungültige sampleRate-Werte', () => {
    expect(resolveAudioContextOptions({ sampleRate: 0 }).sampleRate).toBeUndefined();
    expect(resolveAudioContextOptions({ sampleRate: NaN }).sampleRate).toBeUndefined();
  });

  it('liefert leeres Options-Objekt ohne Settings', () => {
    expect(resolveAudioContextOptions()).toEqual({});
  });
});
