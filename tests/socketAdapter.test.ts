import { describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { attachRedisSocketAdapter } from '../server/socketAdapter';
import { createRealtimeHub } from '../server/realtime';
import { createSessionRuntime } from '../server/sessionRuntime';

/**
 * AUDIT-2026-10-30 P1-008 · Socket.IO-Redis-Adapter
 * =====================================================================
 * Der Adapter ist die Voraussetzung dafuer, dass zwei Instanzen dieselben
 * Socket-Raeume sehen. Geprueft wird hier nur die Verdrahtung - ohne echten
 * Redis, ohne echten Socket.io-Server:
 *
 *   - ohne REDIS_URL passiert NICHTS (Single-Instance unveraendert),
 *   - falsches Schema und Verbindungsfehler landen sichtbar im Memory-Adapter,
 *   - erfolgreicher Aufbau ruft `io.adapter(...)` und laesst sich sauber schliessen.
 */

function fakeClient() {
  const client = {
    isOpen: false,
    connect: vi.fn(async () => { client.isOpen = true; }),
    quit: vi.fn(async () => { client.isOpen = false; return 'OK'; }),
    on: vi.fn(),
    duplicate: vi.fn(() => fakeClient()),
  };
  return client;
}

function fakeIo() {
  const adapter = vi.fn();
  return { io: { adapter }, adapter };
}

describe('P1-008 · Socket.IO-Redis-Adapter', () => {
  it('ohne REDIS_URL wird kein Client erzeugt (Single-Instance-Pfad)', async () => {
    const { io, adapter } = fakeIo();
    const createClient = vi.fn();
    const log = vi.fn();
    const warn = vi.fn();

    const handle = await attachRedisSocketAdapter(io, { createClient, createAdapter: vi.fn(), log, warn });

    expect(handle.active).toBe(false);
    expect(handle.reason).toBe('no-redis');
    expect(adapter).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    await expect(handle.close()).resolves.toBeUndefined();
  });

  it('falsches URL-Schema bleibt Memory-Adapter und warnt', async () => {
    const { io, adapter } = fakeIo();
    const warn = vi.fn();

    const handle = await attachRedisSocketAdapter(io, {
      redisUrl: 'http://redis:6379',
      createClient: vi.fn(),
      createAdapter: vi.fn(),
      warn,
    });

    expect(handle).toMatchObject({ active: false, reason: 'invalid-url' });
    expect(adapter).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('Memory');
  });

  it('Verbindungsfehler werden sauber aufgeraeumt und gemeldet', async () => {
    const { io, adapter } = fakeIo();
    const pub = fakeClient();
    const sub = fakeClient();
    pub.duplicate = vi.fn(() => sub);
    pub.connect = vi.fn(async () => { pub.isOpen = true; throw new Error('ECONNREFUSED'); });
    const warn = vi.fn();

    const handle = await attachRedisSocketAdapter(io, {
      redisUrl: 'redis://redis:6379',
      createClient: async () => pub,
      createAdapter: vi.fn(),
      warn,
    });

    expect(handle).toMatchObject({ active: false, reason: 'connect-failed' });
    expect(adapter).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0][0])).toContain('prozesslokal');
    // Kein halb aufgebauter Client bleibt offen.
    expect(sub.quit).toHaveBeenCalled();
    expect(pub.quit).toHaveBeenCalled();
  });

  it('baut den Adapter auf und schliesst Adapter und Clients wieder', async () => {
    const { io, adapter } = fakeIo();
    const pub = fakeClient();
    const sub = fakeClient();
    pub.duplicate = vi.fn(() => sub);
    const redisAdapter = { close: vi.fn(async () => {}) };
    const createAdapter = vi.fn(() => redisAdapter);
    const log = vi.fn();

    const handle = await attachRedisSocketAdapter(io, {
      redisUrl: 'redis://redis:6379',
      createClient: async () => pub,
      createAdapter,
      log,
    });

    expect(handle.active).toBe(true);
    expect(handle.client).toBe(pub);
    expect(createAdapter).toHaveBeenCalledWith(pub, sub);
    expect(adapter).toHaveBeenCalledWith(redisAdapter);
    expect(log.mock.calls[0][0]).toContain('Redis-Adapter aktiv');

    await handle.close();

    expect(redisAdapter.close).toHaveBeenCalled();
    expect(sub.quit).toHaveBeenCalled();
    expect(pub.quit).toHaveBeenCalled();
  });

  it('Hub ohne REDIS_URL: Lock-Backend bleibt Memory, close() ist folgenlos', async () => {
    // Beweist den Single-Instance-Pfad am echten Hub: kein Redis, kein Adapter,
    // kein Lock-Store - und ein close(), das nichts kaputt macht.
    const previous = process.env.REDIS_URL;
    delete process.env.REDIS_URL;
    const server = http.createServer();
    const runtime = createSessionRuntime({ log: () => { /* still */ } });
    try {
      const hub = await createRealtimeHub(server, {
        sessionRuntime: runtime,
        addServerAudit: () => { /* still */ },
        resolveSessionMainOutUserId: () => runtime.session.lockOwner('mixer') ?? '',
        pluginLockTtlMs: 60_000,
        studioTokenMissing: false,
        studioAuthOpen: true,
        studioAccessToken: '',
        studioSessionSecret: '',
        safeTokenEqual: (a, b) => a === b,
        looksLikeStudioSession: () => false,
        verifyStudioSession: async () => false,
        log: () => { /* still */ },
        warn: () => { /* still */ },
      });

      expect(runtime.lockBackend()).toBe('memory');
      expect(hub.io.sockets.adapter.constructor.name).not.toBe('RedisAdapter');
      await expect(hub.close()).resolves.toBeUndefined();
      await expect(hub.close()).resolves.toBeUndefined();
      await new Promise<void>((resolve) => hub.io.close(() => resolve()));
    } finally {
      runtime.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (previous !== undefined) process.env.REDIS_URL = previous;
    }
  });

  it('close ist idempotent (Shutdown ruft es ggf. doppelt)', async () => {
    const { io } = fakeIo();
    const pub = fakeClient();
    const sub = fakeClient();
    pub.duplicate = vi.fn(() => sub);
    const handle = await attachRedisSocketAdapter(io, {
      redisUrl: 'redis://redis:6379',
      createClient: async () => pub,
      createAdapter: vi.fn(() => ({ close: vi.fn(async () => { throw new Error('already closed'); }) })),
      warn: vi.fn(),
    });

    await expect(handle.close()).resolves.toBeUndefined();
    await expect(handle.close()).resolves.toBeUndefined();
  });
});
