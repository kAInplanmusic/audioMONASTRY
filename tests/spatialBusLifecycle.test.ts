import { describe, expect, it, vi } from 'vitest';
import { SpatialBus, type SpatialBusDeps } from '../src/audio/spatialBus';

function node() { return { connect: vi.fn(), disconnect: vi.fn() }; }
function gain() {
  return {
    ...node(),
    gain: { value: 1, setTargetAtTime: vi.fn(), cancelScheduledValues: vi.fn() },
  };
}

describe('SP-P0-03 SpatialBus graph lifecycle', () => {
  it('disconnects splitter, intermediate gain nodes, ring gains and merger on reset', () => {
    const splitters: ReturnType<typeof node>[] = [];
    const gains: ReturnType<typeof gain>[] = [];
    const mergers: ReturnType<typeof node>[] = [];
    const master = node(), destination = node(), outputGain = gain();
    const ctx = {
      currentTime: 0, sampleRate: 48000,
      createChannelSplitter: vi.fn(() => { const n = node(); splitters.push(n); return n; }),
      createChannelMerger: vi.fn(() => { const n = node(); mergers.push(n); return n; }),
      createGain: vi.fn(() => { const g = gain(); gains.push(g); return g; }),
    } as unknown as AudioContext;
    const deps: SpatialBusDeps = {
      getContext: () => ctx,
      getMasterOut: () => master as unknown as AudioNode,
      getDestination: () => destination as unknown as AudioNode,
      getOutputGain: () => outputGain as unknown as GainNode,
      setChannelPan: () => {},
    };
    const bus = new SpatialBus(deps);
    bus.setSetup('4.0');
    expect(bus.isEnabled).toBe(true);
    expect(splitters).toHaveLength(1);
    expect(mergers).toHaveLength(1);
    bus.reset();
    expect(bus.isEnabled).toBe(false);
    expect(splitters[0].disconnect).toHaveBeenCalledTimes(1);
    expect(mergers[0].disconnect).toHaveBeenCalledTimes(1);
    expect(gains.length).toBeGreaterThan(4);
    for (const g of gains) expect(g.disconnect).toHaveBeenCalledTimes(1);
    bus.reset();
    expect(splitters[0].disconnect).toHaveBeenCalledTimes(1);
  });
});
