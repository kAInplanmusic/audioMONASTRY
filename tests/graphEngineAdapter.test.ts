import { describe, expect, it, vi } from 'vitest';
import { GraphEngineAdapter } from '../src/core/audio/compat/GraphEngineAdapter';
import { emptyAudioGraphState } from '../src/utils/audioGraphSerialization';

describe('GraphEngineAdapter (V1→V2-Migration)', () => {
  it('syncToGraph spiegelt Engine-State in den Graph', () => {
    const state = emptyAudioGraphState();
    state.channelGainsDb = { channel1: -6, channel2: 3 };
    state.channelPans = { channel1: -0.5, channel2: 0.5 };

    const importState = vi.fn(() => true);
    const adapter = new GraphEngineAdapter({ exportState: () => state, importState });

    const exported = adapter.syncToGraph();
    expect(exported.channelGainsDb.channel1).toBeCloseTo(-6, 5);
    expect(adapter.graph.graph.compile().validated).toBe(true);
  });

  it('syncFromGraph spielt Graph-State in die Engine zurück', () => {
    const state = emptyAudioGraphState();
    const importState = vi.fn(() => true);
    const adapter = new GraphEngineAdapter({ exportState: () => state, importState });

    expect(adapter.syncFromGraph()).toBe(true);
    expect(importState).toHaveBeenCalledTimes(1);
  });
});
