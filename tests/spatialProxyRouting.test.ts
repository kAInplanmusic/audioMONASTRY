import { describe, expect, it, vi } from 'vitest';
import { createSpatialRoutingPlanV2, verifySpatialRoutingPartitionV2 } from '../src/core/spatial/v2/routingPlan';
import { NonDestructiveSpatialTapRegistry } from '../src/core/spatial/v2/nonDestructiveTap';

const channels = ['channel1', 'channel2', 'channel3', 'channel4'];
const capabilities = { deviceId: 'verified-16ch', verifiedDiscreteOutputs: 16, isVerified: true };

describe('Spatial-Main proxy routing contract', () => {
  function plan(selectedMixerChannels: string[], extra = {}) {
    return createSpatialRoutingPlanV2({
      availableMixerChannels: channels,
      selectedMixerChannels,
      enableSpatialMain: true,
      mainOutputCapabilities: capabilities,
      requiredMainOutputChannels: 16,
      ...extra,
    });
  }

  it('leaves all stereo audiences and mixerMONK untouched', () => {
    const p = plan(['channel1', 'channel3']);
    expect(p.canonicalStereoMaster).toBe('mixerMONK');
    expect(p.mixerStereoUnmodified).toBe(true);
    expect(p.stereoAudiences).toEqual(['dj', 'monitor', 'stream', 'recorder', 'collaborator']);
    expect(p.main.mode).toBe('spatial-main-exclusive');
  });

  it('separates positional dry signal from the stereo bed without duplicates', () => {
    const p = plan(['channel1', 'channel3']);
    expect(p.selectedDrySpatialObjects).toEqual(['channel1', 'channel3']);
    expect(p.stereoBedChannels).toEqual(['channel2', 'channel4']);
    expect(p.spatialMainDrySemantics).toBe('replace-selected-dry');
    expect(p.includeStereoFxReturnsInBed).toBe(true);
    expect(verifySpatialRoutingPartitionV2(p, channels)).toBe(true);
  });

  it('allows any single or multiple active mixer channels, or none', () => {
    expect(plan(['channel4']).selectedDrySpatialObjects).toEqual(['channel4']);
    expect(plan([]).stereoBedChannels).toEqual(channels);
    expect(plan([...channels]).stereoBedChannels).toEqual([]);
  });

  it('accepts extra sound only through separate spatial-only injections', () => {
    const p = plan(['channel1'], {
      injections: [
        { id: 'ambience-forest', format: 'stereo', destination: 'spatial-only' },
        { id: 'click-1', format: 'mono', destination: 'spatial-only' },
      ],
    });
    expect(p.spatialOnlyInjections.map((i) => i.id)).toEqual(['ambience-forest', 'click-1']);
    expect(verifySpatialRoutingPartitionV2(p, channels)).toBe(true);
  });

  it('rejects duplicate, unknown, or colliding sources', () => {
    expect(() => plan(['channel1', 'channel1'])).toThrow();
    expect(() => plan(['channel8'])).toThrow();
    expect(() => plan([], {
      injections: [{ id: 'channel1', format: 'mono', destination: 'spatial-only' }],
    })).toThrow();
  });

  it('falls back to stereo when physical outputs are unverified', () => {
    const p = plan(['channel1'], { mainOutputCapabilities: null });
    expect(p.main.mode).toBe('stereo-main');
    expect(p.stereoAudiences).toContain('dj');
  });
});

describe('NonDestructiveSpatialTapRegistry', () => {
  function node() {
    return { connect: vi.fn(), disconnect: vi.fn() } as unknown as AudioNode;
  }

  it('never disconnects the existing mixer main connection', () => {
    const source = node(), main = node(), spatial = node();
    source.connect(main);
    const send = { ...node(), gain: { value: 0 } } as unknown as GainNode;
    const ctx = { createGain: vi.fn(() => send) } as unknown as BaseAudioContext;
    const proxy = new NonDestructiveSpatialTapRegistry(ctx);
    proxy.attach('channel1', source, spatial);
    proxy.attach('channel1', source, spatial);
    expect(ctx.createGain).toHaveBeenCalledTimes(1);
    expect(source.connect).toHaveBeenCalledWith(main);
    expect(source.connect).toHaveBeenCalledWith(send);
    expect(send.connect).toHaveBeenCalledWith(spatial);
    expect(source.disconnect).not.toHaveBeenCalled();
    proxy.detach('channel1');
    expect(source.disconnect).toHaveBeenCalledWith(send);
    expect(source.disconnect).not.toHaveBeenCalledWith(main);
    expect(proxy.size).toBe(0);
  });

  it('can remove every proxy without changing the source normal output', () => {
    const source = node(), main = node(), target1 = node(), target2 = node();
    source.connect(main);
    const ctx = { createGain: vi.fn(() => ({
      ...node(), gain: { value: 1 },
    })) } as unknown as BaseAudioContext;
    const proxy = new NonDestructiveSpatialTapRegistry(ctx);
    proxy.attach('a', source, target1);
    proxy.attach('b', source, target2);
    expect(proxy.size).toBe(2);
    proxy.dispose();
    expect(proxy.size).toBe(0);
    expect(source.disconnect).not.toHaveBeenCalledWith(main);
  });
});
