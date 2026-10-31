import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { io as connectSocket, type Socket } from 'socket.io-client';
import { createRealtimeHub, type RealtimeHub } from '../server/realtime';
import { createSessionRuntime } from '../server/sessionRuntime';

// Real Socket.IO connections on distinct loopback nodes; only the unavailable
// native mediasoup worker is substituted. No Redis or external service is used.
vi.mock('mediasoup', () => ({
  createWorker: async () => ({
    createRouter: async () => ({
      rtpCapabilities: { codecs: [] },
      createWebRtcTransport: async () => ({
        id: 'transport-1', appData: {}, iceParameters: {}, iceCandidates: [], dtlsParameters: {},
        on: () => {}, close: () => {},
        produce: async () => ({ id: 'producer-1', kind: 'audio' }),
      }),
    }),
  }),
}));

describe('cross-node SFU membership lifecycle', () => {
  const servers: http.Server[] = [];
  const hubs: RealtimeHub[] = [];
  const clients: Socket[] = [];
  let appUrl: string;
  let sfuUrl: string;

  async function startNode(): Promise<string> {
    const server = http.createServer();
    servers.push(server);
    const hub = await createRealtimeHub(server, {
      sessionRuntime: createSessionRuntime({ log: () => {} }),
      addServerAudit: () => {}, resolveSessionMainOutUserId: () => '', pluginLockTtlMs: 60_000,
      studioTokenMissing: false, studioAuthOpen: false, studioAccessToken: 'test-token',
      studioSessionSecret: 'test-secret', safeTokenEqual: (a, b) => a === b,
      looksLikeStudioSession: () => false, verifyStudioSession: async () => false,
      log: () => {}, warn: () => {},
    });
    hubs.push(hub);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  beforeAll(async () => {
    vi.stubEnv('ENABLE_SFU', '1');
    vi.stubEnv('SFU_ANNOUNCED_IP', '203.0.113.1');
    vi.stubEnv('REDIS_URL', '');
    vi.stubEnv('SESSION_STATE_FILE', 'off');
    appUrl = await startNode();
    sfuUrl = await startNode();
  });

  afterAll(async () => {
    for (const client of clients) client.disconnect();
    for (const hub of hubs) await new Promise<void>(resolve => hub.io.close(() => resolve()));
    for (const server of servers) if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    vi.unstubAllEnvs();
  });

  async function connect(url: string, path: string): Promise<Socket> {
    const client = connectSocket(url, {
      path, transports: ['websocket'], reconnection: false, forceNew: true, timeout: 2000,
      auth: { token: 'test-token' }, query: { sessionId: 'studio-session' },
    });
    clients.push(client);
    await new Promise<void>((resolve, reject) => {
      client.once('connect', () => resolve());
      client.once('connect_error', reject);
    });
    return client;
  }

  async function join(mode: 'member' | 'master-out'): Promise<Socket> {
    const app = await connect(appUrl, '/webrtc-signaling');
    const joined = new Promise<void>(resolve => app.once('session-members', () => resolve()));
    app.emit('join-session', { userId: `test-${mode}`, mode });
    await joined;
    return app;
  }

  it('disconnects the SFU connection on the other node when the member leaves', async () => {
    const app = await join('member');
    const sfu = await connect(sfuUrl, '/sfu-signaling');
    const result = await sfu.timeout(2000).emitWithAck('getRouterRtpCapabilities', {});
    expect(result.rtpCapabilities).toEqual({ codecs: [] });
    app.emit('leave-session');
    // Same Socket.IO connection: ping acknowledgement is a processing barrier.
    await app.timeout(2000).emitWithAck('clock-ping', { t0: 0 });
    const disconnected = await new Promise<boolean>(resolve => {
      if (!sfu.connected) return resolve(true);
      const timer = setTimeout(() => { sfu.off('disconnect', onDisconnect); resolve(false); }, 300);
      const onDisconnect = () => { clearTimeout(timer); resolve(true); };
      sfu.once('disconnect', onDisconnect);
    });
    expect(disconnected, 'a departed member retained cross-node SFU access').toBe(true);
  });

  it('disconnects cross-node SFU access when the member signaling socket drops', async () => {
    const app = await join('member');
    const sfu = await connect(sfuUrl, '/sfu-signaling');
    const appSocket = hubs[0].io.sockets.sockets.get(app.id);
    expect(appSocket).toBeTruthy();
    const appDisconnected = new Promise<void>(resolve => appSocket.once('disconnect', () => resolve()));
    app.disconnect();
    await appDisconnected;
    const disconnected = await new Promise<boolean>(resolve => {
      if (!sfu.connected) return resolve(true);
      const timer = setTimeout(() => { sfu.off('disconnect', onDisconnect); resolve(false); }, 300);
      const onDisconnect = () => { clearTimeout(timer); resolve(true); };
      sfu.once('disconnect', onDisconnect);
    });
    expect(disconnected, 'a disconnected member retained cross-node SFU access').toBe(true);
  });

  it('keeps the accepted output listener receive-only on the SFU node', async () => {
    await join('master-out');
    const sfu = await connect(sfuUrl, '/sfu-signaling');
    const transport = await sfu.timeout(2000).emitWithAck('createTransport', { direction: 'send' });
    if (transport.error) {
      expect(transport.error).toBeTruthy();
      return;
    }
    const produced = await sfu.timeout(2000).emitWithAck('produce', {
      transportId: transport.id, kind: 'audio', rtpParameters: {},
    });
    expect(produced.error, 'an output listener was able to publish audio').toBeTruthy();
  });
});
