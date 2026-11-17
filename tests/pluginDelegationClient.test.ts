// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
const { handlers, socket } = vi.hoisted(() => {
  const handlers = new Map<string, (...args: any[]) => void>();
  return { handlers, socket: { connected: true, on: vi.fn((name, cb) => handlers.set(name, cb)), emit: vi.fn(), connect: vi.fn() } };
});
vi.mock('socket.io-client', () => ({ io: () => socket }));
vi.mock('../src/config/webrtc', () => ({ rtcConfig: {}, refreshIceConfig: vi.fn() }));
import { webRTCManager as manager } from '../src/utils/WebRTCManager';
import { setPluginSettingsHolderCheck, writePluginSettings, flushPluginSettings } from '../src/utils/pluginSettings';
it('asynchronous settings effects retain authority outside a command scope, and pending writes retain the original generation', async () => {
  const record = { pluginId: 'eq', delegatedBy: manager.userId, aiRole: 'audio-brain', generationId: 'first', issuedAt: Date.now(), expiresAt: Date.now() + 10000 };
  const receive = (records: typeof record[]) => handlers.get('plugin-delegations')!({ records });
  receive([record]); setPluginSettingsHolderCheck(id => !!manager.delegationProof(id));
  const original = manager.getPluginDelegation('eq');
  receive([{ ...record }]);
  expect(manager.getPluginDelegation('eq')).toBe(original); // No unrelated broadcast restarts its controller.
  expect(manager.delegationProof('eq')).toEqual(record);
  writePluginSettings('eq', { gain: 1 }); // A React effect after the command returns.
  receive([{ ...record, generationId: 'second' }]); flushPluginSettings('eq');
  expect(socket.emit).toHaveBeenCalledWith('plugin-settings', { pluginId: 'eq', settings: { gain: 1 }, delegationGeneration: 'first' });
  await manager.runDelegated(record, async () => {
    expect(manager.delegationProof('eq')).toBeNull(); // Old in-flight action cannot adopt second.
    socket.emit.mockClear(); writePluginSettings('eq', { gain: 2 }); flushPluginSettings('eq');
    expect(socket.emit).not.toHaveBeenCalled();
  });
  expect(manager.delegationProof('eq')?.generationId).toBe('second');
  receive([]); expect(manager.delegationProof('eq')).toBeNull();
  socket.emit.mockClear(); handlers.get('plugin-settings-rejected')!({ pluginId: 'eq', reason: 'valid delegation required' });
  expect(socket.emit).toHaveBeenCalledWith('resync-session');
});
