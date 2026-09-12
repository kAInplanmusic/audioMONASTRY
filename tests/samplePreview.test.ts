import { describe, expect, it, vi } from 'vitest';
import { SamplePreview, type AudioPlayerLike, type SamplePreviewDeps } from '../src/audio/samplePreview';

// ---------------------------------------------------------------------------
// AUDIO-P1-002: Sample-Preview/Track-Load. Geprüft wird das Routing (Player,
// V2-Bridge, Kanalzug), der De-Klick-Abbau und der MAIN-Schutz.
// ---------------------------------------------------------------------------

function makePlayer() {
  return {
    volume: { rampTo: vi.fn() },
    start: vi.fn(),
    stop: vi.fn(),
    disconnect: vi.fn(),
    dispose: vi.fn(),
    buffer: { get: () => ({ numberOfChannels: 2 } as unknown as AudioBuffer) },
  } as unknown as AudioPlayerLike;
}

function makeDeps(overrides: Partial<SamplePreviewDeps> = {}) {
  const calls = {
    bridge: vi.fn(), trigger: vi.fn(), ensureInit: vi.fn(), ensureChannel: vi.fn(),
    setPlayer: vi.fn(), deletePlayer: vi.fn(), setUrl: vi.fn(),
  };
  const deps: SamplePreviewDeps = {
    ensureInitialized: calls.ensureInit,
    ensureChannelNode: calls.ensureChannel,
    getChannelInput: () => ({}) as AudioNode,
    canLoadTrack: () => true,
    getSamplePlayer: () => null,
    setSamplePlayer: calls.setPlayer,
    deleteSamplePlayer: calls.deletePlayer,
    getTrackSampleUrl: () => null,
    setTrackSampleUrl: calls.setUrl,
    bridgeBufferToV2: calls.bridge,
    triggerV2Sample: calls.trigger,
    getMusicBuffer: async () => ({ get: () => ({ numberOfChannels: 2 } as unknown as AudioBuffer) }),
    createPlayerFromUrl: () => makePlayer(),
    createPlayerFromBuffer: () => makePlayer(),
    decodeToV2: (_url, onBuffer) => onBuffer({ numberOfChannels: 2 } as unknown as AudioBuffer),
    ...overrides,
  };
  return { deps, calls };
}

describe('SamplePreview', () => {
  it('spielt eine URL-Hörprobe, merkt die URL und triggert den V2-Pfad', () => {
    const { deps, calls } = makeDeps();
    const sp = new SamplePreview(deps);
    sp.previewSample('channel2', undefined, 'a.mp3');
    expect(calls.ensureInit).toHaveBeenCalled();
    expect(sp.getPreviewUrl()).toBe('a.mp3');
    expect(calls.bridge).toHaveBeenCalledWith('channel2', expect.any(Object));
    expect(calls.trigger).toHaveBeenCalledWith('channel2');
  });

  it('entsorgt den vorherigen Preview-Player (kein Leak) und stoppt sauber', () => {
    const dispose = vi.fn();
    const { deps } = makeDeps({ createPlayerFromUrl: () => ({ ...makePlayer(), dispose }) as unknown as AudioPlayerLike });
    const sp = new SamplePreview(deps);
    sp.previewSample('channel2', undefined, 'a.mp3');
    sp.previewSample('channel2', undefined, 'b.mp3');
    expect(dispose).toHaveBeenCalledTimes(1);
    sp.stopPreview();
    expect(sp.getPreviewUrl()).toBeNull();
  });

  it('spielt ohne URL den geladenen Track-Player und triggert V2', () => {
    const player = makePlayer();
    const { deps, calls } = makeDeps({ getSamplePlayer: () => player });
    new SamplePreview(deps).previewSample('channel3');
    expect(player.start).toHaveBeenCalled();
    expect(calls.bridge).toHaveBeenCalledWith('channel3', expect.any(Object));
    expect(calls.trigger).toHaveBeenCalledWith('channel3');
  });

  it('respektiert den MAIN-Schutz beim Laden', async () => {
    const { deps, calls } = makeDeps({ canLoadTrack: () => false });
    await new SamplePreview(deps).loadTrackSample('channel1', 'a.mp3');
    expect(calls.ensureInit).not.toHaveBeenCalled();
    expect(calls.setUrl).not.toHaveBeenCalled();
  });

  it('lädt einen Track über die Kette, cached und registriert V2', async () => {
    const { deps, calls } = makeDeps();
    await new SamplePreview(deps).loadTrackSample('channel4', 'a.mp3');
    expect(calls.ensureChannel).toHaveBeenCalledWith('channel4');
    expect(calls.setPlayer).toHaveBeenCalledWith('channel4', expect.any(Object));
    expect(calls.setUrl).toHaveBeenCalledWith('channel4', 'a.mp3');
    expect(calls.bridge).toHaveBeenCalledWith('channel4', expect.any(Object));
  });

  it('baut einen alten Player weich ab (Rampe, Stop, Delete) und leert die URL', async () => {
    const old = makePlayer();
    const { deps, calls } = makeDeps({ getSamplePlayer: () => old });
    const sp = new SamplePreview(deps);
    await sp.loadTrackSample('channel4', null);
    expect(old.volume.rampTo).toHaveBeenCalledWith(-60, 0.02);
    expect(old.stop).toHaveBeenCalled();
    expect(calls.deletePlayer).toHaveBeenCalledWith('channel4');
    expect(calls.setUrl).toHaveBeenCalledWith('channel4', null);
  });
});
