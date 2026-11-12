import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SpatialCluster, SpatialNode } from '../src/audio/spatial/node';

class FakeAudioWorkletNode {
  readonly port = { postMessage: vi.fn(), close: vi.fn(), onmessage: null as ((event: unknown) => void) | null };
  connect = vi.fn();
  disconnect = vi.fn();
  constructor(_ctx: BaseAudioContext, _name: string, _opts?: AudioWorkletNodeOptions) {}
}

const createContext = () => ({
  audioWorklet: { addModule: vi.fn(async () => undefined) },
  createGain: vi.fn(() => ({
    gain: { value: 1 },
    connect: vi.fn(), disconnect: vi.fn(),
  })),
}) as unknown as AudioContext;

beforeEach(() => { vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('spatial AudioWorklet lifetime', () => {
  it('loads a processor once per AudioContext, not once per window', async () => {
    const a = createContext(), b = createContext();
    const first = await SpatialNode.create(a);
    const second = await SpatialNode.create(a);
    const third = await SpatialNode.create(b);
    expect(a.audioWorklet.addModule).toHaveBeenCalledTimes(1);
    expect(b.audioWorklet.addModule).toHaveBeenCalledTimes(1);
    first.dispose(); second.dispose(); third.dispose();
  });

  it('retries when addModule fails for a context', async () => {
    const ctx = createContext();
    ctx.audioWorklet.addModule = vi.fn()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValue(undefined);
    await expect(SpatialNode.create(ctx)).rejects.toThrow('temporary failure');
    const recovered = await SpatialNode.create(ctx);
    expect(ctx.audioWorklet.addModule).toHaveBeenCalledTimes(2);
    recovered.dispose();
  });

  it('keeps unsafe manual cluster splits off by default', async () => {
    const ctx = createContext();
    const cluster = await SpatialCluster.create(ctx, { maxSources: 4, maxInstances: 4 });
    expect(cluster.instanceCount).toBe(1);
    expect(await cluster.splitNow()).toBe(1);
    expect(cluster.instanceCount).toBe(1);
    cluster.dispose();
  });
});
