/**
 * DAW-Breaker real Socket.IO regressions: listener writes, leave revocation,
 * and same-socket identity changes. Local ephemeral HTTP server; no production
 * URLs, credentials, Redis, or RunPod requests.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { createSessionRuntime, type SessionRuntime } from '../server/sessionRuntime';
import { createRealtimeHub, type RealtimeHub } from '../server/realtime';

describe('DAW-Breaker — actual Socket.IO session authorization', () => {
  let server: http.Server;
  let hub: RealtimeHub;
  let runtime: SessionRuntime;
  let baseUrl: string;
  const clients: ClientSocket[] = [];

  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  const waitFor = async (pred: () => boolean, timeoutMs = 3_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (pred()) return;
      await sleep(15);
    }
    throw new Error('Socket.IO assertion timed out');
  };

  beforeEach(async () => {
    delete process.env.REDIS_URL;
    server = http.createServer();
    runtime = createSessionRuntime({ log: () => { /* silent */ } });
    hub = await createRealtimeHub(server, {
      sessionRuntime: runtime,
      addServerAudit: () => { /* silent */ },
      resolveSessionMainOutUserId: () => runtime.session.lockOwner('mixer') ?? '',
      pluginLockTtlMs: 60_000,
      studioTokenMissing: false,
      studioAuthOpen: true,
      studioAccessToken: '',
      studioSessionSecret: '',
      safeTokenEqual: (a, b) => a === b,
      looksLikeStudioSession: () => false,
      verifyStudioSession: async () => false,
      log: () => { /* silent */ },
      warn: () => { /* silent */ },
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 30_000);

  afterEach(async () => {
    for (const client of clients.splice(0)) client.disconnect();
    await new Promise<void>((resolve) => hub?.io?.close?.(() => resolve()) ?? resolve());
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function join(userId: string, mode: 'member' | 'master-out' | 'visual-out' = 'member') {
    const socket = ioClient(baseUrl, {
      path: '/webrtc-signaling',
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
    });
    clients.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('connect_error', reject);
    });
    let joined = false;
    socket.once('session-members', () => { joined = true; });
    socket.emit('join-session', { userId, mode });
    await waitFor(() => joined);
    return socket;
  }

  it('prevents a listener from deleting store entries or acquiring plugin locks', async () => {
    const alice = await join('alice');
    const output = await join('output-1', 'visual-out');
    const key = 'dawbreaker-listener-key';
    alice.emit('store-set', { key, value: JSON.stringify({ owner: 'alice' }) });
    await waitFor(() => runtime.session.storeAll()[key] !== undefined);
    output.emit('store-remove', { key });
    output.emit('plugin-lock', { pluginId: 'effect' });
    await sleep(120);
    expect(runtime.session.storeAll()[key]).toBe(JSON.stringify({ owner: 'alice' }));
    expect(runtime.session.lockOwner('effect')).toBeNull();
  });

  it('revokes mutation rights immediately after leave-session', async () => {
    const alice = await join('alice');
    const key = 'dawbreaker-leave-key';
    alice.emit('store-set', { key, value: JSON.stringify({ v: 1 }) });
    await waitFor(() => runtime.session.storeAll()[key] !== undefined);
    alice.emit('leave-session');
    alice.emit('store-remove', { key });
    alice.emit('plugin-lock', { pluginId: 'effect' });
    await sleep(120);
    expect(runtime.session.storeAll()[key]).toBe(JSON.stringify({ v: 1 }));
    expect(runtime.session.lockOwner('effect')).toBeNull();
  });

  it('rejects same-socket identity switches and preserves the original owner', async () => {
    const alice = await join('alice');
    let denied: Record<string, unknown> | null = null;
    alice.on('session-join-denied', (data: Record<string, unknown>) => { denied = data; });
    alice.emit('join-session', { userId: 'mallory', mode: 'member' });
    await waitFor(() => denied !== null);
    expect(denied).toMatchObject({ reason: 'already-joined' });
    alice.emit('plugin-lock', { pluginId: 'effect' });
    await waitFor(() => runtime.session.lockOwner('effect') !== null);
    expect(runtime.session.lockOwner('effect')).toBe('alice');
  });

  it('keeps editor locks when a passive output joins with the same reported userId', async () => {
    const alice = await join('alice');
    alice.emit('plugin-lock', { pluginId: 'effect' });
    await waitFor(() => runtime.session.lockOwner('effect') === 'alice');
    const output = await join('alice', 'visual-out');
    output.emit('leave-session');
    await sleep(80);
    expect(runtime.session.lockOwner('effect')).toBe('alice');
  });

  it('keeps editor locks until the last editor socket with that identity leaves', async () => {
    const alice1 = await join('alice');
    alice1.emit('plugin-lock', { pluginId: 'effect' });
    await waitFor(() => runtime.session.lockOwner('effect') === 'alice');
    const alice2 = await join('alice');
    alice2.emit('leave-session');
    await sleep(80);
    expect(runtime.session.lockOwner('effect')).toBe('alice');
    alice1.emit('leave-session');
    await waitFor(() => runtime.session.lockOwner('effect') === null);
  });

});
