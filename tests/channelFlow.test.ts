import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/core/audio/compat/nativeAudioKit', () => {
  class MockNode {
    volume = { value: 0, rampTo: () => {} };
    pan = { value: 0 };
    frequency = { value: 440 };
    gain = { value: 0, rampTo: () => {} };
    Q = { value: 0 };
    connect() { return this; }
    disconnect() { return this; }
    chain() { return this; }
    start() { return this; }
    stop() { return this; }
    dispose() { return this; }
    set() { return this; }
    triggerAttackRelease() {}
    toDestination() { return this; }
  }
  return {
    Volume: MockNode, Gain: MockNode, Filter: MockNode, Oscillator: MockNode,
    Analyser: MockNode, Player: MockNode, Noise: MockNode, AmplitudeEnvelope: MockNode,
    MembraneSynth: MockNode, MetalSynth: MockNode, NoiseSynth: MockNode,
    MonoSynth: MockNode, Synth: MockNode, Panner: MockNode, FeedbackDelay: MockNode,
    Delay: MockNode, Compressor: MockNode, MultibandCompressor: MockNode, Limiter: MockNode,
    Frequency: vi.fn(() => ({ toFrequency: () => 440 })),
    Transport: {
      bpm: { value: 120 }, start: vi.fn(), stop: vi.fn(),
      scheduleRepeat: vi.fn(), cancel: vi.fn(), position: '0:0:0',
    },
    context: { currentTime: 0, destination: {} },
    start: vi.fn(async () => {}),
  };
});

import { pluginAudioChannels } from '../src/core/audio/pluginChannelMap';
import { PLUGIN_ROUTE_IDS, validateRoutingMatrix, getPluginRoute } from '../src/core/pluginAudioRouter';

/**
 * F1/F11-Regressionstests: Die Kanal-Routing-Matrix muss zu den Zielkanälen
 * passen, damit alle Plugin-Quellen über den Kanalzug geführt werden können.
 */
describe('Audiokanalfluss · Plugin-Routing-Matrix', () => {
  it('ordnet alle audio-einspeisenden Plugins einem Kanalzug zu', () => {
    // UI2-P0-001 (2026-10-06): 8 feste Quellen — 1 drop · 2 song ·
    // 3 drumsampler · 4 syntisampler · 5 instru · 6 voice · 7 sound · 8 stem.
    expect(pluginAudioChannels('drop')[0]).toBe('channel1');
    expect(pluginAudioChannels('song')[0]).toBe('channel2');
    expect(pluginAudioChannels('drum')[0]).toBe('channel3');
    expect(pluginAudioChannels('synthesizer')[0]).toBe('channel4');
    expect(pluginAudioChannels('sampler')[0]).toBe('channel4');
    expect(pluginAudioChannels('instrument')[0]).toBe('channel5');
    expect(pluginAudioChannels('voice')[0]).toBe('channel6');
    expect(pluginAudioChannels('sound')[0]).toBe('channel7');
    expect(pluginAudioChannels('stem')[0]).toBe('channel8');
  });

  it('UI-only-Plugins speisen keine Audio-Quelle ein', () => {
    for (const id of ['mastergraph', 'ai', 'controller', 'library', 'mastering', 'recording', 'performance']) {
      expect(pluginAudioChannels(id)).toEqual([]);
    }
  });

  it('alle registrierten Plugin-IDs haben eine gültige Routing-Matrix', () => {
    expect(validateRoutingMatrix(PLUGIN_ROUTE_IDS)).toEqual([]);
  });

  it('jedes audio-einspeisende Plugin hat einen Main-Feeder-Status', () => {
    for (const id of PLUGIN_ROUTE_IDS) {
      const route = getPluginRoute(id);
      expect(route).toBeDefined();
      if (route!.channels.length > 0) {
        expect(route!.mainFeeder).toBe(true);
      }
    }
  });
});
