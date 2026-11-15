import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackendMainPlayback } from '../src/core/transport/backendMainClient';
import type { BackendMainChunk } from '../src/core/transport/backendMainProtocol';

class FakeContext {
  sampleRate = 48000;
  currentTime = 0;
  state: AudioContextState = 'suspended';
  destination = {};
  sources: { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>; connect: ReturnType<typeof vi.fn>; onended: (() => void) | null; buffer: unknown }[] = [];
  resume = async () => { this.state = 'running'; };
  close = async () => { this.state = 'closed'; };
  createBuffer(_channels: number, frames: number, sampleRate: number) {
    const channels = [new Float32Array(frames), new Float32Array(frames)];
    return { sampleRate, numberOfChannels: 2, length: frames, duration: frames / sampleRate, getChannelData: (channel: number) => channels[channel] };
  }
  createBufferSource() {
    const source = { start: vi.fn(), stop: vi.fn(), disconnect: vi.fn(), connect: vi.fn(), onended: null, buffer: null };
    this.sources.push(source);
    return source;
  }
}

let context: FakeContext;
vi.mock('../src/utils/audioContextFactory', () => ({ createMainOutputAudioContext: () => context }));
afterEach(() => vi.restoreAllMocks());
const chunk = (sequence: number, startFrame: number): BackendMainChunk => ({ type: 'chunk', sequence, startFrame, frames: 48000, sampleRate: 48000, format: 's24le' });

describe('BackendMainPlayback progress', () => {
  it('tracks the audio clock across scheduled chunks, preserving the initial lead', async () => {
    context = new FakeContext();
    const player = new BackendMainPlayback();
    expect(player.progress()).toBeNull();
    await player.activate(48000);
    await player.play(chunk(0, 1000), new ArrayBuffer(48000 * 6));
    await player.play(chunk(1, 49000), new ArrayBuffer(48000 * 6));
    expect(context.sources.map(source => source.start.mock.calls[0][0])).toEqual([0.5, 1.5]);
    expect(player.progress()).toEqual({ type: 'playback-progress', playedFrame: 1000, queuedFrames: 96000, scheduledEndFrame: 97000, sampleRate: 48000, active: false });
    context.currentTime = 0.75;
    expect(player.progress()).toMatchObject({ playedFrame: 13000, queuedFrames: 84000, active: true });
    context.sources[0].onended?.();
    expect(player.progress()?.playedFrame).toBe(13000);
    context.currentTime = 1.75;
    expect(player.progress()).toMatchObject({ playedFrame: 61000, queuedFrames: 36000, active: true });
    context.currentTime = 3;
    expect(player.progress()).toMatchObject({ playedFrame: 97000, queuedFrames: 0, active: false });
    context.currentTime = 1;
    expect(player.progress()?.playedFrame).toBe(97000);
    await player.close();
    expect(player.progress()).toBeNull();
  });

  it('reports a suspended context as inactive without advancing its clock', async () => {
    context = new FakeContext();
    const player = new BackendMainPlayback();
    await player.activate(48000);
    await player.play(chunk(0, 0), new ArrayBuffer(48000 * 6));
    context.currentTime = 0.75;
    expect(player.progress()?.playedFrame).toBe(12000);
    context.state = 'suspended';
    expect(player.progress()).toMatchObject({ playedFrame: 12000, active: false });
    await player.close();
  });
});
