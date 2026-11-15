import { describe, expect, it } from 'vitest';
import { BackendMainMixer } from '../server/backendMainMixer';

const pcm = (value: number, frames = 480) => {
  const b = Buffer.alloc(frames * 6);
  for (let i = 0; i < frames * 2; i++) b.writeIntLE(value, i * 3, 3);
  return b;
};

describe('R16 §P3 backend waveform telemetry', () => {
  it('reports L/R peak and RMS for the finished master block', () => {
    const mixer = new BackendMainMixer(48000, () => ({ master: { active: true, parameters: { gain: 1 }, epoch: 1 } }));
    mixer.enqueue('song', 0, 0, pcm(4000000));
    const result = mixer.mix(480);
    expect(result.waveform.sampleRate).toBe(48000);
    expect(result.waveform.frames).toBe(480);
    expect(result.waveform.frame).toBe(0);
    expect(result.waveform.peakL).toBeCloseTo(4000000 / 8388608, 5);
    expect(result.waveform.peakR).toBeCloseTo(4000000 / 8388608, 5);
    expect(result.waveform.rmsL).toBeCloseTo(4000000 / 8388608, 5);
    expect(result.waveform.clipped).toBe(0);
  });

  it('exposes clipping and the frame position without shipping audio frames', () => {
    const mixer = new BackendMainMixer(48000, () => ({ master: { active: true, parameters: { gain: 2 }, epoch: 1 } }));
    mixer.enqueue('song', 0, 0, pcm(6000000));
    const first = mixer.mix(480);
    expect(first.waveform.clipped).toBe(960);
    expect(first.waveform.peakL).toBeLessThanOrEqual(1);
    expect(first.waveform.peakL).toBeGreaterThan(0.9999);
    const second = mixer.mix(480);
    expect(second.waveform.frame).toBe(480);
    // the telemetry object carries numbers only - no buffers, no samples
    for (const value of Object.values(second.waveform)) expect(['number', 'string']).toContain(typeof value);
  });

  it('reports silence instead of inventing energy when a block is empty', () => {
    const mixer = new BackendMainMixer(48000);
    const result = mixer.mix(480);
    expect(result.waveform.peakL).toBe(0);
    expect(result.waveform.rmsR).toBe(0);
    expect(result.waveform.clipped).toBe(0);
  });
});
