import { describe, it, expect } from 'vitest';
import { createSessionRuntime } from '../server/sessionRuntime';
import { mainProcessorSnapshot, MAIN_PROCESSOR_IDS } from '../server/backendMainProcessorControl';
import { BackendMainMixer } from '../server/backendMainMixer';
import { preserveMainSettings } from '../src/core/audio/backendMainProcessorSettings';

const pcm = (value: number, frames = 480) => { const b = Buffer.alloc(frames * 6); for (let i = 0; i < frames * 2; i++) b.writeIntLE(value, i * 3, 3); return b; };
describe('Main processors consume existing authoritative state', () => {
  it.each(MAIN_PROCESSOR_IDS)('%s stops at OFF/authority loss and accepts only current holder settings', async id => {
    const runtime = createSessionRuntime();
    if (id === 'master') await runtime.acquirePluginLock('mixer', 'a');
    await runtime.acquirePluginLock(id, 'a');
    const mode = (state: string, actor = 'a') => runtime.session.applyEvent({ id: crypto.randomUUID(), type: 'plugin-state', senderUserId: actor, pluginId: id, state });
    mode('PRO');
    expect(runtime.session.setPluginSettings(id, 'a', { backendMain: { gain: 0.5 } }).ok).toBe(true);
    expect(runtime.session.setPluginSettings(id, 'viewer', { backendMain: { gain: 2 } }).ok).toBe(false);
    const read = () => mainProcessorSnapshot(runtime.session, runtime.delegations);
    const first = read()[id]; expect(first.active).toBe(true); expect(first.parameters.gain).toBe(0.5);
    const mixer = new BackendMainMixer(48000, read);
    const block = () => { mixer.enqueue('drop', mixer.frame, mixer.frame, pcm(1000000)); return mixer.mix(480); };
    expect(block().pcm.some(Boolean)).toBe(true);
    mode('OFF'); await runtime.releasePluginLock(id, 'a');
    expect(read()[id].active).toBe(false); expect(block().pcm.some(Boolean)).toBe(true);
    if (id === 'master') await runtime.transferPluginLock('mixer', 'a', 'b');
    await runtime.acquirePluginLock(id, 'b'); mode('PRO', 'b');
    expect(read()[id].active).toBe(true); expect(read()[id].epoch).not.toBe(first.epoch);
    expect(runtime.session.setPluginSettings(id, 'a', { backendMain: { gain: 2 } }).ok).toBe(false);
    expect(block().pcm.some(Boolean)).toBe(true);
  });
  it.each(['eq', 'dsp', 'effect', 'spatial', 'master'] as const)('%s bypasses after delegation revocation during audio', async id => {
    const runtime = createSessionRuntime();
    if (id === 'master') await runtime.acquirePluginLock('mixer', 'a');
    await runtime.acquirePluginLock(id, 'a');
    runtime.session.setPluginSettings(id, 'a', { backendMain: { gain: 0.5 } });
    const grant = runtime.delegations.start(id, 'a');
    const read = () => mainProcessorSnapshot(runtime.session, runtime.delegations);
    const mixer = new BackendMainMixer(48000, read);
    expect(read()[id].active).toBe(true);
    mixer.enqueue('song', 0, 0, pcm(1000000)); expect(mixer.mix(480).pcm.some(Boolean)).toBe(true);
    runtime.delegations.revoke(id);
    expect(runtime.delegations.valid(grant, 'a', id)).toBe(false); expect(read()[id].active).toBe(false);
    mixer.enqueue('song', 1, 480, pcm(1000000)); expect(mixer.mix(480).pcm.some(Boolean)).toBe(true);
  });
  it('preserves the independent Main section when a monitor panel saves, without modifying source settings', () => {
    const previous = { backendMain: { gain: 0.4 }, fx: { wet: 0.3 } };
    expect(preserveMainSettings('effect', { fx: { wet: 0.5 } }, previous)).toEqual({ backendMain: { gain: 0.4 }, fx: { wet: 0.5 } });
    expect(preserveMainSettings('effect', { backendMain: { gain: 1 } }, previous)).toEqual({ backendMain: { gain: 1 } });
    expect(preserveMainSettings('song', {}, previous)).toEqual({});
  });
});

it('clips only after the master, retaining pre-master headroom at gain0.5 and clipping at gain2', () => {
  for (const gain of [0.5, 2]) {
    const mixer = new BackendMainMixer(48000, () => ({ master: { active: true, epoch: 1, parameters: { gain } } }));
    mixer.enqueue('song', 0, 0, pcm(6000000)); mixer.enqueue('drop', 0, 0, pcm(6000000));
    const out = mixer.mix(480);
    expect(out.pcm.readIntLE(0, 3)).toBe(gain === 0.5 ? 6000000 : 8388607);
    expect(out.clippedSamples).toBe(gain === 0.5 ? 0 : 960);
  }
});
