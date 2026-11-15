import { describe, expect, it } from 'vitest';
import { applyWaveformMessage, waveformState, WAVEFORM_STALE_MS } from '../src/hooks/useBackendWaveform';
import { shouldUseBackendMainMonitor } from '../src/hooks/useBackendMainMonitor';

const msg = (over: Record<string, unknown> = {}) => ({
  type: 'waveform-peak', frame: 9600, frames: 9600, sampleRate: 96000,
  peakL: 0.5, peakR: 0.25, rmsL: 0.2, rmsR: 0.1, clipped: 0, ...over,
});

describe('R16 §P3 backend waveform is the only source for the shared Main display', () => {
  it('accepts a well-formed message and keeps every reported field', () => {
    const value = applyWaveformMessage(null, msg({ clipped: 7 }), 1000);
    expect(value).toMatchObject({ peakL: 0.5, peakR: 0.25, rmsL: 0.2, rmsR: 0.1, clipped: 7, frame: 9600, sampleRate: 96000 });
    expect(value?.receivedAt).toBe(1000);
  });

  it('marks the value stale after the freshness window and never invents one', () => {
    const value = applyWaveformMessage(null, msg(), 1000);
    expect(waveformState(null, 1000)).toBe('missing');
    expect(waveformState(value, 1000 + WAVEFORM_STALE_MS)).toBe('live');
    expect(waveformState(value, 1000 + WAVEFORM_STALE_MS + 1)).toBe('stale');
  });

  it('ignores malformed or foreign messages instead of poisoning the display', () => {
    const good = applyWaveformMessage(null, msg(), 1000);
    expect(applyWaveformMessage(good, { type: 'main-out-update' }, 2000)).toBe(good);
    expect(applyWaveformMessage(good, msg({ peakL: 'loud' }), 2000)).toBe(good);
    expect(applyWaveformMessage(good, null, 2000)).toBe(good);
  });
});

describe('R16 §P2 backend monitor is limited to holders in Main routing', () => {
  const base = { userId: 'u1', mixerHolder: 'u1', masterHolder: '', routing: 'main' as const };
  it('allows the mixer holder and the master holder in Main routing', () => {
    expect(shouldUseBackendMainMonitor(base)).toBe(true);
    expect(shouldUseBackendMainMonitor({ ...base, mixerHolder: '', masterHolder: 'u1' })).toBe(true);
  });
  it('refuses listeners without a holder role and refuses plugin/cue routing', () => {
    expect(shouldUseBackendMainMonitor({ ...base, mixerHolder: 'u2', masterHolder: 'u2' })).toBe(false);
    expect(shouldUseBackendMainMonitor({ ...base, routing: 'plugins' })).toBe(false);
    expect(shouldUseBackendMainMonitor({ ...base, routing: 'cue' })).toBe(false);
    expect(shouldUseBackendMainMonitor({ ...base, mixerHolder: '', masterHolder: '' })).toBe(false);
  });
});
