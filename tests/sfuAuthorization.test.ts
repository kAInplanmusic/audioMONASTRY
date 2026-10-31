import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { io as connectSocket, type Socket } from 'socket.io-client';
import { createRealtimeHub, type RealtimeHub } from '../server/realtime';
import { createSessionRuntime } from '../server/sessionRuntime';

// Socket.IO and the actual SFU registration are exercised over loopback. The
// worker is replaced only because the native mediasoup binary is not installed.
vi.mock('mediasoup', () => ({
  createWorker: async () => ({
    createRouter: async () => ({ rtpCapabilities: { codecs: [] } }),
  }),
}));

describe('SFU signaling authorization', () => {
  let server: http.Server;
  let hub: RealtimeHub;
  let baseUrl: string;
  const clients: Socket[] = [];

  beforeAll(async () => {
    vi.stubEnv('ENABLE_SFU', '1');
    vi.stubEnv('SFU_ANNOUNCED_IP', '203.0.113.1'); // avoids any external IP lookup
    vi.stubEnv('REDIS_URL', '');
    vi.stubEnv('SESSION_STATE_FILE', 'off');
    vi.stubEnv('SIGNALING_ALLOWED_ORIGINS', 'https://allowed.example');
    server = http.createServer();
    hub = await createRealtimeHub(server, {
      sessionRuntime: createSessionRuntime({ log: () => {} }),
      addServerAudit: () => {},
      resolveSessionMainOutUserId: () => '',
      pluginLockTtlMs: 60_000,
      studioTokenMissing: false,
      studioAuthOpen: false,
      studioAccessToken: 'local-test-token',
      studioSessionSecret: 'local-test-secret',
      safeTokenEqual: (a, b) => a === b,
      looksLikeStudioSession: () => false,
      verifyStudioSession: async () => false,
      log: () => {},
      warn: () => {},
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    for (const client of clients) client.disconnect();
    await new Promise<void>(resolve => hub.io.close(() => resolve()));
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    vi.unstubAllEnvs();
  });

  function makeClient(path: string, token?: string, sessionId = 'studio-session', origin?: string): Socket {
    const socket = connectSocket(baseUrl, {
      path,
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
      timeout: 2_000,
      query: { sessionId },
      ...(token ? { auth: { token } } : {}),
      ...(origin ? { extraHeaders: { origin } } : {}),
    });
    clients.push(socket);
    return socket;
  }

  function outcome(socket: Socket): Promise<string> {
    return new Promise(resolve => {
      socket.once('connect', () => resolve('connected'));
      socket.once('connect_error', error => resolve(error.message));
    });
  }

  async function attempt(path: string, token?: string, sessionId = 'studio-session', origin?: string): Promise<string> {
    return outcome(makeClient(path, token, sessionId, origin));
  }

  it('normal signaling rejects an unauthenticated websocket', async () => {
    expect(await attempt('/webrtc-signaling')).toBe('unauthorized');
  });

  it('SFU rejects unauthenticated websocket access even with a disallowed origin', async () => {
    expect(await attempt('/sfu-signaling', undefined, 'studio-session', 'https://attacker.example')).not.toBe('connected');
  });

  it('SFU rejects a valid studio credential without a session membership', async () => {
    expect(await attempt('/sfu-signaling', 'local-test-token')).not.toBe('connected');
  });

  it('SFU rejects arbitrary unapproved session IDs', async () => {
    expect(await attempt('/sfu-signaling', 'local-test-token', 'unapproved-room')).not.toBe('connected');
  });

  it('does not expose router capabilities to an unauthenticated client', async () => {
    const attacker = makeClient('/sfu-signaling');
    const result = await outcome(attacker);
    if (result === 'connected') {
      const response = await attacker.timeout(2_000).emitWithAck('getRouterRtpCapabilities', {});
      expect(response, 'unauthenticated client reached SFU router capabilities').toBeUndefined();
    } else {
      expect(result).not.toBe('connected');
    }
  });

  it('admits normal signaling with a valid studio credential', async () => {
    expect(await attempt('/webrtc-signaling', 'local-test-token')).toBe('connected');
  });
});
