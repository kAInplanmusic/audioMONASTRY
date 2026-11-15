import { describe, expect, it } from 'vitest';
import { createSessionRuntime } from '../server/sessionRuntime';
import { mainProcessorSnapshot } from '../server/backendMainProcessorControl';

describe('R16 §P4 master authority is independent of the mixer holder', () => {
  it('lets the masterMONK holder shape the Main without holding the mixerMONK', async () => {
    const runtime = createSessionRuntime();
    await runtime.acquirePluginLock('master', 'a');
    runtime.session.applyEvent({ id: crypto.randomUUID(), type: 'plugin-state', senderUserId: 'a', pluginId: 'master', state: 'PRO' });
    expect(runtime.session.lockOwner('mixer')).toBeNull();
    expect(runtime.session.setPluginSettings('master', 'a', { backendMain: { gain: 0.5, bands: [3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] } }).ok).toBe(true);
    const snapshot = mainProcessorSnapshot(runtime.session, runtime.delegations);
    expect(snapshot.master?.active).toBe(true);
    expect(snapshot.master?.parameters.gain).toBe(0.5);
  });

  it('keeps every foreign write refused while the master holder works alone', async () => {
    const runtime = createSessionRuntime();
    await runtime.acquirePluginLock('master', 'a');
    runtime.session.applyEvent({ id: crypto.randomUUID(), type: 'plugin-state', senderUserId: 'a', pluginId: 'master', state: 'PRO' });
    expect(runtime.session.setPluginSettings('master', 'b', { backendMain: { gain: 2 } }).ok).toBe(false);
    expect(mainProcessorSnapshot(runtime.session, runtime.delegations).master?.parameters.gain).toBeUndefined();
  });

  it('does not revoke a master delegation when the mixer changes hands', async () => {
    const runtime = createSessionRuntime();
    await runtime.acquirePluginLock('mixer', 'a');
    await runtime.acquirePluginLock('master', 'b');
    runtime.session.applyEvent({ id: crypto.randomUUID(), type: 'plugin-state', senderUserId: 'b', pluginId: 'master', state: 'PRO' });
    const grant = runtime.delegations.start('master', 'b');
    expect(runtime.delegations.valid(grant, 'b', 'master')).toBe(true);
    const moved = await runtime.transferPluginLock('mixer', 'a', 'c');
    expect(moved.ok).toBe(true);
    expect(runtime.delegations.valid(grant, 'b', 'master')).toBe(true);
  });

  it('still refuses a master state change by a non-holder and still protects the mixer invariant', async () => {
    const runtime = createSessionRuntime();
    await runtime.acquirePluginLock('master', 'a');
    await runtime.acquirePluginLock('mixer', 'a');
    const foreign = runtime.session.applyEvent({ id: crypto.randomUUID(), type: 'plugin-state', senderUserId: 'b', pluginId: 'master', state: 'OFF' });
    expect(foreign.accepted).toBe(false);
    // mixer delegation keeps requiring the mixer holder itself
    runtime.session.applyEvent({ id: crypto.randomUUID(), type: 'plugin-state', senderUserId: 'b', pluginId: 'mixer', state: 'PRO' });
    await expect(async () => runtime.delegations.start('mixer', 'b')).rejects.toThrow();
  });
});
