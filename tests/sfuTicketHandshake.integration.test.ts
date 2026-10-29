/**
 * DB-005 — real local Socket.IO handshake against the separate SFU instance.
 * Mediasoup is mocked: no real media, GPU, external address or production data.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { createRealtimeHub, type RealtimeHub } from '../server/realtime';
import { createSessionRuntime } from '../server/sessionRuntime';
import { issueSfuTicket } from '../server/sfuTicket';
import { signStudioSession } from '../src/core/session/studioSession';

vi.mock('mediasoup', () => ({
  createWorker: vi.fn(async () => ({
    createRouter: vi.fn(async () => ({
      rtpCapabilities: { codecs: [], headerExtensions: [] },
    })),
  })),
}));

const testSecret = 'test-only-shared-sfu-secret';
describe('DB-005: SFU signaling denies unauthenticated Socket.IO clients', () => {
  let server: http.Server;
  let hub: RealtimeHub;
  let baseUrl = '';
  const clients: ClientSocket[] = [];
  const original = {
    ENABLE_SFU: process.env.ENABLE_SFU,
    SFU_ANNOUNCED_IP: process.env.SFU_ANNOUNCED_IP,
    SFU_SIGNALING_PATH: process.env.SFU_SIGNALING_PATH,
    REDIS_URL: process.env.REDIS_URL,
  };

  beforeEach(async () => {
    process.env.ENABLE_SFU = '1';
    process.env.SFU_ANNOUNCED_IP = '49.13.65.150';
    process.env.SFU_SIGNALING_PATH = '/sfu-signaling';
    delete process.env.REDIS_URL;
    server = http.createServer();
    hub = await createRealtimeHub(server, {
      sessionRuntime: createSessionRuntime({ log: () => {} }),
      addServerAudit: () => {},
      resolveSessionMainOutUserId: () => '',
      pluginLockTtlMs: 60_000,
      studioTokenMissing: true, // standalone SFU has no studio master token
      studioAuthOpen: false,
      studioAccessToken: '',
      studioSessionSecret: testSecret,
      safeTokenEqual: (a, b) => a === b,
      looksLikeStudioSession: () => false,
      verifyStudioSession: async () => false,
      log: () => {},
      warn: () => {},
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 15_000);

  afterEach(async () => {
    clients.splice(0).forEach((client) => client.disconnect());
    await new Promise<void>((resolve) => hub.io.close(() => resolve()));
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  function connect(token?: string, sessionId = 'main'): Promise<{ ok: boolean; reason?: string; socket: ClientSocket }> {
    const socket = ioClient(baseUrl, {
      path: '/sfu-signaling',
      query: { sessionId },
      auth: token ? { token } : {},
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
      timeout: 4_000,
    });
    clients.push(socket);
    return new Promise((resolve) => {
      socket.once('connect', () => resolve({ ok: true, socket }));
      socket.once('connect_error', (error: Error) => resolve({ ok: false, reason: error.message, socket }));
    });
  }

  it('rejects anonymous SFU clients', async () => {
    const result = await connect();
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('unauthorized-sfu');
  });

  it('rejects a valid portal token that is not an SFU ticket', async () => {
    const token = await signStudioSession(testSecret, { sub: 'user123' });
    const result = await connect(token);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('unauthorized-sfu');
  });

  it('rejects an SFU ticket for a different session', async () => {
    const { ticket } = await issueSfuTicket(testSecret, 'session-a');
    const result = await connect(ticket, 'session-b');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('unauthorized-sfu');
  });

  it('admits a properly signed ticket and can read router capabilities', async () => {
    const { ticket } = await issueSfuTicket(testSecret, 'main');
    const result = await connect(ticket);
    expect(result.ok).toBe(true);
    const capabilities = await new Promise<Record<string, unknown>>((resolve) => {
      result.socket.emit('getRouterRtpCapabilities', {}, resolve);
    });
    expect(capabilities).toHaveProperty('rtpCapabilities');
  });
});
