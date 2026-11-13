import http from 'node:http';
import { io, type Socket } from 'socket.io-client';
import { expect, it } from 'vitest';
import { createSessionRuntime } from '../server/sessionRuntime';
import { createRealtimeHub } from '../server/realtime';
function event(socket: Socket, name: string) {
  return new Promise<any>((resolve, reject) => { const timer = setTimeout(() => reject(new Error(name + ' timeout')), 5000);
    socket.once(name, data => { clearTimeout(timer); resolve(data); }); });
}
function request(socket: Socket, data: object) { return new Promise<any>(resolve => socket.emit('plugin-delegation-request', data, resolve)); }
it('real signaling attests/revokes generations and rejects stale settings and forged delegation', async () => {
  const runtime = createSessionRuntime(), server = http.createServer();
  const hub = await createRealtimeHub(server, { sessionRuntime: runtime, addServerAudit: () => {}, resolveSessionMainOutUserId: () => runtime.session.lockOwner('mixer') ?? '',
    studioTokenMissing: false, studioAuthOpen: true, studioAccessToken: '', studioSessionSecret: '', safeTokenEqual: () => false,
    looksLikeStudioSession: () => false, verifyStudioSession: async () => false, log: () => {}, warn: () => {} });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); const address = server.address() as import('node:net').AddressInfo;
  const sockets: Socket[] = [];
  try {
    for (const userId of ['human-a', 'human-b']) {
      const socket = io(`http://127.0.0.1:${address.port}`, { path: '/webrtc-signaling/', transports: ['websocket'], forceNew: true, autoConnect: false });
      sockets.push(socket); const connected = event(socket, 'connect'); socket.connect(); await connected;
      const joined = event(socket, 'session-members'); socket.emit('join-session', { userId, mode: 'member' }); await joined;
    }
    const [a, b] = sockets;
    expect((await request(a, { action: 'start', pluginId: 'eq' })).ok).toBe(false);
    const acquired = event(a, 'plugin-lock'); a.emit('plugin-lock', { pluginId: 'eq' }); await acquired;
    const granted = await request(a, { action: 'start', pluginId: 'eq' }); expect(granted.ok).toBe(true);
    expect(await runtime.resolveLockOwner('eq')).toBeNull();
    const saved = event(b, 'plugin-settings');
    a.emit('plugin-settings', { pluginId: 'eq', settings: { gain: 1 }, delegationGeneration: granted.record.generationId });
    expect((await saved).settings).toEqual({ gain: 1 });
    expect((await request(b, { action: 'validate', pluginId: 'eq', generationId: granted.record.generationId, target: 'eq' })).ok).toBe(false);
    const takeover = event(b, 'plugin-lock'); b.emit('plugin-lock', { pluginId: 'eq' }); await takeover;
    expect(runtime.delegations.get('eq')).toBeNull();
    const denied = event(a, 'plugin-settings-rejected');
    a.emit('plugin-settings', { pluginId: 'eq', settings: { gain: 999 }, delegationGeneration: granted.record.generationId });
    expect((await denied).reason).toContain('delegation'); expect(runtime.session.getPluginSettings('eq')?.settings).toEqual({ gain: 1 });
    const second = await request(b, { action: 'start', pluginId: 'eq' }); expect(second.ok).toBe(true);
    expect(second.record.generationId).not.toBe(granted.record.generationId);
    expect((await request(a, { action: 'revoke', pluginId: 'eq', generationId: second.record.generationId })).ok).toBe(false);
  } finally { sockets.forEach(s => s.disconnect()); await hub.close(); hub.io.close(); runtime.stop(); await new Promise<void>(r => server.close(() => r())); }
});
