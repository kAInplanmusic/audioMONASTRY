import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { io as connectSocket, type Socket } from 'socket.io-client';
import { createRealtimeHub, type RealtimeHub } from '../server/realtime';
import { createSessionRuntime, type SessionRuntime } from '../server/sessionRuntime';

describe('Session-Berechtigung nach leave-session', () => {
  let server: http.Server;
  let hub: RealtimeHub;
  let runtime: SessionRuntime;
  let url: string;
  const clients: Socket[] = [];

  beforeEach(async () => {
    vi.stubEnv('REDIS_URL', '');
    vi.stubEnv('ENABLE_SFU', '0');
    vi.stubEnv('SESSION_STATE_FILE', 'off');
    vi.stubEnv('SIGNALING_ALLOWED_ORIGINS', '');
    runtime = createSessionRuntime({ log: () => {} });
    server = http.createServer();
    hub = await createRealtimeHub(server, {
      sessionRuntime: runtime,
      addServerAudit: () => {},
      resolveSessionMainOutUserId: () => runtime.session.lockOwner('mixer') ?? '',
      pluginLockTtlMs: 60_000,
      studioTokenMissing: false,
      studioAuthOpen: true,
      studioAccessToken: '',
      studioSessionSecret: '',
      safeTokenEqual: (a, b) => a === b,
      looksLikeStudioSession: () => false,
      verifyStudioSession: async () => false,
      log: () => {},
      warn: () => {},
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) client.disconnect();
    await new Promise<void>(resolve => hub.io.close(() => resolve()));
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    runtime.stop();
    vi.unstubAllEnvs();
  });

  async function barrier(socket: Socket) {
    await socket.timeout(2_000).emitWithAck('clock-ping', { t0: 1 });
  }

  async function connect(userId: string): Promise<Socket> {
    const socket = connectSocket(url, {
      path: '/webrtc-signaling', transports: ['websocket'], reconnection: false, forceNew: true,
    });
    clients.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('connect_error', reject);
    });
    await join(socket, userId);
    return socket;
  }

  async function join(socket: Socket, userId: string) {
    const joined = new Promise<void>(resolve => socket.once('session-members', () => resolve()));
    socket.emit('join-session', { userId });
    await joined;
    await barrier(socket);
  }

  it('widerruft nach Leave Zugriffe und erlaubt sie erst nach erneutem Join', async () => {
    const departed = await connect('user-a');
    const peer = await connect('user-b');
    const offersToPeer: unknown[] = [];
    const offersToDeparted: unknown[] = [];
    const snapshots: unknown[] = [];
    peer.on('offer', offer => offersToPeer.push(offer));
    departed.on('offer', offer => offersToDeparted.push(offer));
    departed.on('session-state', snapshot => snapshots.push(snapshot));

    departed.emit('offer', { target: peer.id, offer: { sdp: 'before-leave' } });
    await barrier(departed);
    await barrier(peer);
    expect(offersToPeer).toHaveLength(1);

    departed.emit('leave-session');
    await barrier(departed);
    expect(runtime.session.lockOwner('mixer')).toBe('user-b');

    departed.emit('plugin-lock', { pluginId: 'drumsampler' });
    departed.emit('resync-session');
    departed.emit('offer', { target: peer.id, offer: { sdp: 'after-leave' } });
    await barrier(departed);
    await barrier(peer);
    expect(runtime.session.lockOwner('drumsampler')).toBeNull();
    expect(snapshots).toHaveLength(0);
    expect(offersToPeer).toHaveLength(1);

    peer.emit('offer', { target: departed.id, offer: { sdp: 'to-departed' } });
    await barrier(peer);
    await barrier(departed);
    expect(offersToDeparted).toHaveLength(0);

    await join(departed, 'user-a');
    departed.emit('plugin-lock', { pluginId: 'drumsampler' });
    departed.emit('resync-session');
    departed.emit('offer', { target: peer.id, offer: { sdp: 'after-rejoin' } });
    await barrier(departed);
    await barrier(peer);
    expect(runtime.session.lockOwner('drumsampler')).toBe('user-a');
    expect(snapshots).toHaveLength(2); // Join-Snapshot und Resync
    expect(offersToPeer).toHaveLength(2);
  });

  it('ein alter Socket gibt nach Leave weder erneut noch beim Disconnect spätere Locks frei', async () => {
    const old = await connect('user-a');
    old.emit('leave-session');
    await barrier(old);

    const current = await connect('user-a');
    current.emit('plugin-lock', { pluginId: 'drumsampler' });
    await barrier(current);
    expect(runtime.session.lockOwner('drumsampler')).toBe('user-a');

    old.emit('leave-session');
    await barrier(old);
    expect(runtime.session.lockOwner('drumsampler')).toBe('user-a');
    const serverSocket = hub.io.sockets.sockets.get(old.id);
    const disconnected = new Promise<void>(resolve => serverSocket.once('disconnect', () => resolve()));
    old.disconnect();
    await disconnected;
    expect(runtime.session.lockOwner('drumsampler')).toBe('user-a');
  });
});