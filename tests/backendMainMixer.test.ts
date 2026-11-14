import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { BackendMainMixer } from '../server/backendMainMixer';
import { encodeMainFlac } from '../server/backendMainTransport';

function samples(...values: number[]): Buffer { const b = Buffer.alloc(values.length * 3); values.forEach((v, i) => b.writeIntLE(v, i * 3, 3)); return b; }
describe('backend Main mixer', () => {
  it('sums four sources, clips explicitly, and fills gaps with silence', () => {
    const mixer = new BackendMainMixer(48000);
    for (const id of ['one', 'two', 'three', 'four']) mixer.enqueue(id, 0, 1, samples(3000000, -3000000));
    const out = mixer.mix(3);
    expect(out.pcm).toEqual(samples(0, 0, 8388607, -8388608, 0, 0));
    expect(out.clippedSamples).toBe(2); expect(out.missingSamples).toBe(16);
  });
  it('retains queued audio across source disconnect and rejects overlap, stale and excess tracks', () => {
    const mixer = new BackendMainMixer();
    mixer.enqueue('a', 1, 3, samples(1, -1));
    expect(() => mixer.enqueue('a', 2, 3, samples(2, 2))).toThrow();
    mixer.enqueue('b', 1, 3, samples(3, -3)); mixer.enqueue('c', 1, 3, samples(2, 2)); mixer.enqueue('d', 1, 3, samples(0, 0));
    expect(() => mixer.enqueue('e', 1, 3, samples(0, 0))).toThrow();
    expect(mixer.mix(3).pcm).toEqual(Buffer.alloc(18));
    expect(mixer.mix(1).pcm).toEqual(samples(6, -2));
    expect(() => mixer.enqueue('a', 3, 0, samples(1, 1))).toThrow();
  });
  it.each([48000, 96000, 192000] as const)('round trips PCM24 exactly through complete FLAC at %i Hz', async rate => {
    const pcm = samples(-8388608, 8388607, -1, 1, 1234567, -7654321, 0, 0);
    const flac = await encodeMainFlac(pcm, rate);
    expect(flac.subarray(0, 4).toString()).toBe('fLaC');
    const decoded = spawnSync('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-f', 's24le', '-acodec', 'pcm_s24le', 'pipe:1'], { input: flac });
    expect(decoded.status).toBe(0); expect(decoded.stdout).toEqual(pcm);
  });
});
