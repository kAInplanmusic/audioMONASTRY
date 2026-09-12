import { describe, expect, it, vi } from 'vitest';
import { InstrumentSynth, type InstrumentSynthDeps } from '../src/audio/instrumentSynth';
import type { InstrumentPatch } from '../src/data/instrumentSynths';
import type * as Tone from '../src/core/audio/compat/nativeAudioKit';

// ---------------------------------------------------------------------------
// AUDIO-P1-002 Rest B: Instrument-Synth-Fassade. Geprüft wird Routing,
// Zustandsübernahme (adopt), Note-On/Release und Dispose – mit Fakes.
// ---------------------------------------------------------------------------

function makeDeps() {
  const calls = { ensureChannel: vi.fn() };
  const channelInput = {} as unknown as AudioNode;
  const deps: InstrumentSynthDeps = {
    ensureChannelNode: calls.ensureChannel,
    getChannelInput: () => channelInput,
    getMasterBus: () => null,
    getCurrentTime: () => 42,
  };
  return { deps, calls, channelInput };
}

const patch: InstrumentPatch = {
  id: 131, name: 'Piano', kind: 'acoustic', osc: 'sine',
  partials: [{ ratio: 1, amp: 1 }, { ratio: 2, amp: 0.5 }],
  env: [0.01, 0.2, 0.6, 0.4],
  filterFreq: 2000, filterType: 'lowpass', filterQ: 1,
  vibratoAmt: 0, vibratoHz: 5, noise: 0,
} as unknown as InstrumentPatch;

describe('InstrumentSynth', () => {
  it('baut den additiven Synthesizer über channel4 und ist danach bereit', async () => {
    const { deps, calls } = makeDeps();
    const synth = new InstrumentSynth(deps);
    expect(synth.isReady).toBe(false);
    await synth.build(patch);
    expect(calls.ensureChannel).toHaveBeenCalledWith('channel4');
    expect(synth.isReady).toBe(true);
    synth.dispose();
    expect(synth.isReady).toBe(false);
  });

  it('meldet Aufbaufehler als Zustand (kein Throw) und räumt auf', async () => {
    const { deps } = makeDeps();
    const synth = new InstrumentSynth(deps);
    await expect(synth.build({ ...patch, partials: null } as unknown as InstrumentPatch)).resolves.toBeUndefined();
    expect(synth.isReady).toBe(false);
  });

  it('adopt übernimmt nur die übergebenen Felder', () => {
    const { deps } = makeDeps();
    const synth = new InstrumentSynth(deps);
    const filter = { disconnect: vi.fn() } as unknown as Tone.Filter;
    synth.adopt({ filter });
    // adopt({filter}) ersetzt nur den Filter, keine Stimmen -> nicht bereit.
    expect(synth.isReady).toBe(false);
    synth.dispose();
    expect((filter as unknown as { disconnect: ReturnType<typeof vi.fn> }).disconnect).toHaveBeenCalled();
  });

  it('Note-On setzt Partial-Frequenzen und triggert die Hülle, Release fährt sie zurück', () => {
    const { deps } = makeDeps();
    const synth = new InstrumentSynth(deps);
    const osc = { frequency: { setValueAtTime: vi.fn() }, stop: vi.fn(), disconnect: vi.fn() } as unknown as Tone.Oscillator;
    const envOut = {
      gain: { cancelScheduledValues: vi.fn(), setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn(), setTargetAtTime: vi.fn() },
      disconnect: vi.fn(),
    } as unknown as Tone.Gain;
    synth.adopt({ oscs: [osc], partialRatios: [2], envOut });
    expect(synth.isReady).toBe(true);

    synth.noteOn(69); // A4
    expect((osc as unknown as { frequency: { setValueAtTime: ReturnType<typeof vi.fn> } }).frequency.setValueAtTime)
      .toHaveBeenCalledWith(expect.any(Number), 42);
    expect((envOut as unknown as { gain: { exponentialRampToValueAtTime: ReturnType<typeof vi.fn> } }).gain.exponentialRampToValueAtTime)
      .toHaveBeenCalled();

    synth.release();
    expect((envOut as unknown as { gain: { setTargetAtTime: ReturnType<typeof vi.fn> } }).gain.setTargetAtTime)
      .toHaveBeenCalledWith(0.0001, 42, 0.15);
  });

  it('Note-On ohne Stimme ist unkritisch (kein Throw)', () => {
    const { deps } = makeDeps();
    expect(() => new InstrumentSynth(deps).noteOn(60)).not.toThrow();
  });
});
