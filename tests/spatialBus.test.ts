import { afterEach, describe, expect, it, vi } from 'vitest';
import { SpatialBus, type SpatialBusDeps } from '../src/audio/spatialBus';
import type { TrackType } from '../src/types';

// ---------------------------------------------------------------------------
// AUDIO-P1-002 Rest C: N-Kanal-Spatial-Bus. Geprüft werden Aufbau (Splitter/
// Merger/Gains für >2 Kanäle, Passthrough für 2.0), Ring-Gewichte per
// setPosition, de-klickte Mode-/Setup-Wechsel und reset – mit Fake-WebAudio.
// ---------------------------------------------------------------------------

function fakeNode() {
  return { connect: vi.fn(), disconnect: vi.fn() };
}

function fakeGain() {
  return {
    gain: { value: 0, setTargetAtTime: vi.fn(), cancelScheduledValues: vi.fn() },
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
}

function makeCtx() {
  const gains: ReturnType<typeof fakeGain>[] = [];
  const splitters: ReturnType<typeof fakeNode>[] = [];
  const mergers: ReturnType<typeof fakeNode>[] = [];
  const destination = fakeNode();
  const ctx = {
    currentTime: 7,
    sampleRate: 48000,
    destination,
    createGain: vi.fn(() => { const g = fakeGain(); gains.push(g); return g; }),
    createChannelSplitter: vi.fn(() => { const s = fakeNode(); splitters.push(s); return s; }),
    createChannelMerger: vi.fn(() => { const m = fakeNode(); mergers.push(m); return m; }),
  } as unknown as AudioContext;
  return { ctx, gains, splitters, mergers, destination };
}

function makeDeps(overrides: Partial<SpatialBusDeps> = {}) {
  const { ctx, gains, splitters, mergers, destination } = makeCtx();
  const setChannelPan = vi.fn();
  const outputGain = fakeGain();
  const masterOut = fakeNode();
  const deps: SpatialBusDeps = {
    getContext: () => ctx,
    getMasterOut: () => masterOut as unknown as AudioNode,
    getDestination: () => destination as unknown as AudioNode,
    getOutputGain: () => outputGain as unknown as GainNode,
    setChannelPan,
    ...overrides,
  };
  return { deps, ctx, gains, splitters, mergers, destination, setChannelPan, outputGain, masterOut };
}

/** Nur die Ring-Gains (nicht sourceL/sourceR/monoSource) tragen Gewichte. */
function weightedGains(gains: ReturnType<typeof fakeGain>[]) {
  return gains.filter((g) => g.gain.setTargetAtTime.mock.calls.length > 0);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('SpatialBus', () => {
  it('fällt bei unbekannten Setups auf 10.0 zurück und merkt sich gültige', () => {
    const { deps } = makeDeps();
    const bus = new SpatialBus(deps);
    expect(bus.getSetupId()).toBe('10.0');
    bus.setSetup('gibt-es-nicht');
    expect(bus.getSetupId()).toBe('10.0');
    bus.setSetup('4.0');
    expect(bus.getSetupId()).toBe('4.0');
  });

  it('baut für 4.0 einen Mehrkanal-Bus: Splitter(2), Merger(4), Master und Destination verbunden', () => {
    const { deps, ctx, splitters, mergers, destination, masterOut } = makeDeps();
    const bus = new SpatialBus(deps);
    bus.setSetup('4.0');

    expect(bus.isEnabled).toBe(true);
    expect(ctx.createChannelSplitter).toHaveBeenCalledWith(2);
    expect(ctx.createChannelMerger).toHaveBeenCalledWith(4);
    expect(masterOut.connect).toHaveBeenCalledWith(splitters[0]);
    expect(mergers[0].connect).toHaveBeenCalledWith(destination);
  });

  it('lässt 2.0 als Stereo-Passthrough (kein Mehrkanal-Bus)', () => {
    const { deps, ctx } = makeDeps();
    const bus = new SpatialBus(deps);
    bus.setSetup('2.0');

    expect(bus.isEnabled).toBe(false);
    expect(ctx.createChannelMerger).not.toHaveBeenCalled();
  });

  it('schreibt bei setPosition die Ring-Gewichte auf die Gains und setzt das Kanal-Pan', () => {
    const { deps, gains, setChannelPan } = makeDeps();
    const bus = new SpatialBus(deps);
    bus.setSetup('4.0');

    bus.setPosition('channel1' as TrackType, 0, 0);

    // 4 Hauptkanäle -> genau 4 Gewichts-Gains (sourceL/R/monoSource bleiben frei).
    expect(weightedGains(gains)).toHaveLength(4);
    expect(setChannelPan).toHaveBeenCalledTimes(1);
    expect(setChannelPan).toHaveBeenCalledWith('channel1', expect.any(Number));
    expect(bus.getLastChannels()).toHaveLength(4);
  });

  it('setPosition ohne aufgebauten Bus setzt nur die Kanal-Gewichte (kein Throw)', () => {
    const { deps } = makeDeps();
    const bus = new SpatialBus(deps);
    expect(() => bus.setPosition('channel2' as TrackType, 0.5, -0.5)).not.toThrow();
    expect(bus.isEnabled).toBe(false);
    // Default-Setup 10.0 -> 10 Ring-Kanäle werden auch ohne Bus berechnet.
    expect(bus.getLastChannels()).toHaveLength(10);
  });

  it('blendet den Output-Gain bei SEPARATION weich aus und bei ON_TOP wieder ein', () => {
    const { deps, outputGain } = makeDeps();
    const bus = new SpatialBus(deps);

    bus.setMode('SEPARATION');
    expect(outputGain.gain.cancelScheduledValues).toHaveBeenCalledWith(7);
    expect(outputGain.gain.setTargetAtTime).toHaveBeenCalledWith(0.0001, 7, 0.02);
    expect(bus.getMode()).toBe('SEPARATION');

    bus.setMode('ON_TOP');
    expect(outputGain.gain.setTargetAtTime).toHaveBeenLastCalledWith(1, 7, 0.02);
    expect(bus.getMode()).toBe('ON_TOP');
  });

  it('setMode ohne AudioContext ist unkritisch (Modus wird trotzdem gesetzt)', () => {
    const { deps } = makeDeps({ getContext: () => null });
    const bus = new SpatialBus(deps);
    expect(() => bus.setMode('SEPARATION')).not.toThrow();
    expect(bus.getMode()).toBe('SEPARATION');
  });

  it('build ohne AudioContext ist ein No-Op', () => {
    const { deps } = makeDeps({ getContext: () => null });
    const bus = new SpatialBus(deps);
    expect(() => bus.build()).not.toThrow();
    expect(bus.isEnabled).toBe(false);
  });

  it('plant bei laufendem Bus einen de-klickten Rebuild (60 ms) statt hart zu trennen', () => {
    vi.useFakeTimers();
    const { deps, ctx, gains } = makeDeps();
    const bus = new SpatialBus(deps);
    bus.setSetup('4.0');
    expect(ctx.createChannelMerger).toHaveBeenCalledTimes(1);
    const oldGains = [...gains];

    bus.setSetup('6.0'); // laufender Bus -> erst weich auf 0, dann Rebuild
    expect(oldGains.some((g) => g.gain.setTargetAtTime.mock.calls.some((c) => c[0] === 0))).toBe(true);
    expect(ctx.createChannelMerger).toHaveBeenCalledTimes(1); // noch nicht neu gebaut

    vi.advanceTimersByTime(60);
    expect(ctx.createChannelMerger).toHaveBeenCalledTimes(2);
    expect(ctx.createChannelMerger).toHaveBeenLastCalledWith(6);
  });

  it('reset räumt den Bus-Zustand ab und stoppt einen geplanten Rebuild', () => {
    vi.useFakeTimers();
    const { deps, ctx } = makeDeps();
    const bus = new SpatialBus(deps);
    bus.setSetup('4.0');
    bus.setSetup('6.0'); // Rebuild geplant

    bus.reset();
    expect(bus.isEnabled).toBe(false);

    vi.advanceTimersByTime(120); // geplanter Rebuild darf nicht mehr laufen
    expect(ctx.createChannelMerger).toHaveBeenCalledTimes(1);
  });
});
