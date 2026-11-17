import { describe, expect, it } from 'vitest';
import { BackendMainSourceRing } from '../src/core/audio/backendMainSourceTap';
import { BackendMainAdapter, BACKEND_MAIN_ADAPTERS } from '../src/core/audio/backendMainAdapter';
import { CONTRACT_BY_ID } from '../src/plugins/pluginContract';
import { V2SinkEngine } from '../src/core/audio/live/V2SinkEngine';

describe('real V2 source capture', () => {
  it('maps source channels to the existing canonical audio contract', () => {
    for (const [id, entry] of Object.entries(BACKEND_MAIN_ADAPTERS)) {
      if (entry.status === 'available') expect(entry.tapSource).toBe(`channel${CONTRACT_BY_ID[id].channel}`);
    }
  });
  it('captures the actual V2 synth source while leaving rendered monitor samples identical', () => {
    const plain = new V2SinkEngine(48000, 128), tapped = new V2SinkEngine(48000, 128);
    const ring = new BackendMainSourceRing(); ring.enable('channel4', true);
    let capturedEnergy = 0;
    for (let n = 0; n < 30; n++) {
      if (n === 0) { plain.scheduleSynth('channel4', 0, .8); tapped.scheduleSynth('channel4', 0, .8); }
      const ctx = { sampleRate: 48000, bufferSize: 128, quantum: 128 / 48000, currentTime: n * 128 / 48000 };
      const before = plain.render(ctx), after = tapped.render(ctx);
      ring.write(3, tapped.studio.sources.get('channel4')?.sourceBuffer, 128);
      expect(after).toEqual(before);
      const source = ring.read('channel4', 48000)!;
      capturedEnergy += source.channels[0].reduce((sum, value) => sum + value * value, 0);
    }
    expect(capturedEnergy).toBeGreaterThan(0);
  });
  it('never publishes a disabled lane and fails visibly on overflow', () => {
    const ring = new BackendMainSourceRing();
    ring.write(0, [new Float32Array([1])], 1); expect(ring.read('channel1', 48000)).toBeNull();
    ring.enable('channel1', true);
    for (let n = 0; n < 257; n++) ring.write(0, [new Float32Array(128)], 128);
    expect(() => ring.read('channel1', 48000)).toThrow('overflow');
    ring.enable('channel1', true); ring.write(0, [new Float32Array([.25])], 1);
    expect(ring.read('channel1', 48000)?.channels[1][0]).toBe(.25);
  });
  it('moves actual rendered audio through the ON adapter without fabricating an output block', async () => {
    const engine = new V2SinkEngine(96000, 128), ring = new BackendMainSourceRing();
    let onBlock: ((block: ReturnType<BackendMainSourceRing['read']> & {}) => void) | undefined;
    let energy = 0;
    const adapter = new BackendMainAdapter('syntisampler', {
      openTransport: async () => ({ send: block => { energy += block.channels[0].reduce((sum, value) => sum + value * value, 0); }, close: () => {} }),
      openTap: (channel, callback) => { ring.enable(channel, true); onBlock = callback; return () => { ring.enable(channel, false); onBlock = undefined; }; },
    });
    adapter.updateAuthority({ mode: 'PRO', userId: 'u', holderId: 'u', delegation: null });
    await Promise.resolve(); engine.scheduleSynth('channel4', 0, .8);
    engine.render({ sampleRate: 96000, bufferSize: 128, quantum: 128 / 96000, currentTime: 0 });
    ring.write(3, engine.studio.sources.get('channel4')?.sourceBuffer, 128);
    onBlock?.(ring.read('channel4', 96000)!); expect(energy).toBeGreaterThan(0);
    adapter.dispose(); expect(onBlock).toBeUndefined();
  });
});
