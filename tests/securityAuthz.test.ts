import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

/**
 * P0-Security: Autorisierung (ARCH-SEC-001/002).
 * Deckt ab:
 *   - Request ohne/falscher Token → 401
 *   - fehlende Produktions-/Server-Konfiguration → 503 (fail-closed)
 *   - expliziter Dev-Modus (AUDIOMONASTRY_DEV_NO_AUTH=1) → offen
 *   - Produktions-Origin-Allowlist → 403 bei fremder Origin
 *   - MCP-Aufruf ohne ausreichende Permission → permission denied
 *   - Socket.io-Handshake ohne gültige Authentifizierung → unauthorized
 *
 * Rollen-/Session-Autorisierung (Guest→PRO, Cross-Session) ist Teil von P0-2
 * (serverautoritative Kollaboration) und wird dort getestet.
 */

function resetAuthEnv(env: Record<string, string | undefined>) {
  process.env.VITEST = env.VITEST ?? 'true';
  process.env.NODE_ENV = env.NODE_ENV ?? 'test';
  // Verhindert den Auto-Start des Servers beim Import (wir starten selbst).
  process.env.AUDIOMONASTRY_NO_AUTOSTART = '1';
  if (env.STUDIO_ACCESS_TOKEN === undefined) delete process.env.STUDIO_ACCESS_TOKEN;
  else process.env.STUDIO_ACCESS_TOKEN = env.STUDIO_ACCESS_TOKEN;
  if (env.AUDIOMONASTRY_DEV_NO_AUTH === undefined) delete process.env.AUDIOMONASTRY_DEV_NO_AUTH;
  else process.env.AUDIOMONASTRY_DEV_NO_AUTH = env.AUDIOMONASTRY_DEV_NO_AUTH;
  if (env.API_ALLOWED_ORIGINS === undefined) delete process.env.API_ALLOWED_ORIGINS;
  else process.env.API_ALLOWED_ORIGINS = env.API_ALLOWED_ORIGINS;
  if (env.SIGNALING_ALLOWED_ORIGINS === undefined) delete process.env.SIGNALING_ALLOWED_ORIGINS;
  else process.env.SIGNALING_ALLOWED_ORIGINS = env.SIGNALING_ALLOWED_ORIGINS;
}

let server: Server;
let baseUrl = '';

async function startAppServer(): Promise<void> {
  vi.resetModules();
  const mod = await import('../server');
  server = mod.app.listen(0);
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('kein Port');
  baseUrl = `http://127.0.0.1:${addr.port}`;
}

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  process.env.NODE_ENV = 'test';
  delete process.env.STUDIO_ACCESS_TOKEN;
  delete process.env.AUDIOMONASTRY_DEV_NO_AUTH;
  delete process.env.API_ALLOWED_ORIGINS;
  delete process.env.SIGNALING_ALLOWED_ORIGINS;
  delete process.env.AUDIOMONASTRY_NO_AUTOSTART;
});

describe('P0-1 · API-Authentifizierung', () => {
  beforeEach(() => {
    resetAuthEnv({ NODE_ENV: 'test', STUDIO_ACCESS_TOKEN: 'test-studio-token' });
  });

  it('Request ohne Token → 401', async () => {
    await startAppServer();
    const res = await fetch(`${baseUrl}/api/metrics`);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('STUDIO_TOKEN_REQUIRED');
  });

  it('falscher Token → 401', async () => {
    await startAppServer();
    const res = await fetch(`${baseUrl}/api/metrics`, {
      headers: { 'x-studio-token': 'falsch' },
    });
    expect(res.status).toBe(401);
  });

  it('korrekter Token → Zugriff erlaubt', async () => {
    await startAppServer();
    const res = await fetch(`${baseUrl}/api/metrics`, {
      headers: { 'x-studio-token': 'test-studio-token' },
    });
    expect(res.status).toBe(200);
  });

  it('Health bleibt ohne Token offen', async () => {
    await startAppServer();
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
  });
});

describe('P0-1 · Fail-closed ohne Token/Dev-Flag', () => {
  it('ohne Token und ohne Dev-Flag (NODE_ENV=test, VITEST aus) → 503', async () => {
    resetAuthEnv({ NODE_ENV: 'development', VITEST: 'false', STUDIO_ACCESS_TOKEN: '' });
    await startAppServer();
    const res = await fetch(`${baseUrl}/api/metrics`);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('STUDIO_TOKEN_MISSING');
  });

  it('expliziter Dev-Modus (AUDIOMONASTRY_DEV_NO_AUTH=1) → offen', async () => {
    resetAuthEnv({
      NODE_ENV: 'development',
      VITEST: 'false',
      STUDIO_ACCESS_TOKEN: '',
      AUDIOMONASTRY_DEV_NO_AUTH: '1',
    });
    await startAppServer();
    const res = await fetch(`${baseUrl}/api/metrics`);
    expect(res.status).toBe(200);
  });

  it('Production ignoriert AUDIOMONASTRY_DEV_NO_AUTH=1 → 503', async () => {
    resetAuthEnv({
      NODE_ENV: 'production',
      VITEST: 'false',
      STUDIO_ACCESS_TOKEN: '',
      AUDIOMONASTRY_DEV_NO_AUTH: '1',
    });
    await startAppServer();
    const res = await fetch(`${baseUrl}/api/metrics`);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('STUDIO_TOKEN_MISSING');
  });
});

describe('P0-1 · Produktions-Origin-Allowlist', () => {
  beforeEach(() => {
    resetAuthEnv({
      NODE_ENV: 'production',
      STUDIO_ACCESS_TOKEN: 'test-studio-token',
      API_ALLOWED_ORIGINS: 'https://anunnakitools.de',
    });
  });

  it('fremde Origin in Production → 403', async () => {
    await startAppServer();
    const res = await fetch(`${baseUrl}/api/metrics`, {
      headers: {
        'x-studio-token': 'test-studio-token',
        origin: 'http://evil.example',
      },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('ORIGIN_NOT_ALLOWED');
  });

  it('erlaubte Origin in Production → 200', async () => {
    await startAppServer();
    const res = await fetch(`${baseUrl}/api/metrics`, {
      headers: {
        'x-studio-token': 'test-studio-token',
        origin: 'https://anunnakitools.de',
      },
    });
    expect(res.status).toBe(200);
  });
});

describe('P0-1 · MCP-Permission', () => {
  beforeEach(() => {
    resetAuthEnv({ NODE_ENV: 'test', STUDIO_ACCESS_TOKEN: 'test-studio-token' });
  });

  it('MCP-Aufruf mit READ auf WRITE-Tool → permission denied', async () => {
    await startAppServer();
    const res = await fetch(`${baseUrl}/api/ai/mcp/tools/plugin.command`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-studio-token': 'test-studio-token',
      },
      body: JSON.stringify({ pluginId: 'mixer', action: 'gain', permission: 'READ' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok?: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain('permission denied');
  });
});

describe('P0-1 · Socket.io-Handshake', () => {
  it('Handshake ohne gültigen Token → unauthorized (Production)', async () => {
    resetAuthEnv({
      NODE_ENV: 'production',
      STUDIO_ACCESS_TOKEN: 'test-studio-token',
    });
    vi.resetModules();
    const mod = await import('../server');
    const started = await mod.startServer(0);
    expect(started).not.toBeNull();
    const httpServer = started!.httpServer;
    const addr = httpServer.address();
    if (!addr || typeof addr === 'string') throw new Error('kein Port');
    const port = (addr as AddressInfo).port;

    const { io: ioc } = await import('socket.io-client');
    const client = ioc(`http://127.0.0.1:${port}`, {
      path: '/webrtc-signaling',
      transports: ['websocket'],
      reconnection: false,
      timeout: 3000,
    });
    const error = await new Promise<string | null>((resolve) => {
      client.on('connect_error', (e: Error) => resolve(e.message));
      client.on('connect', () => resolve(null));
      setTimeout(() => resolve('timeout'), 5000);
    });
    expect(error).toBe('unauthorized');
    client.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  it('Handshake mit gültigem Token verbindet (Production)', async () => {
    resetAuthEnv({
      NODE_ENV: 'production',
      STUDIO_ACCESS_TOKEN: 'test-studio-token',
    });
    vi.resetModules();
    const mod = await import('../server');
    const started = await mod.startServer(0);
    expect(started).not.toBeNull();
    const httpServer = started!.httpServer;
    const addr = httpServer.address();
    if (!addr || typeof addr === 'string') throw new Error('kein Port');
    const port = (addr as AddressInfo).port;

    const { io: ioc } = await import('socket.io-client');
    const client = ioc(`http://127.0.0.1:${port}`, {
      path: '/webrtc-signaling',
      transports: ['websocket'],
      reconnection: false,
      timeout: 3000,
      auth: { token: 'test-studio-token' },
    });
    const outcome = await new Promise<'connected' | string>((resolve) => {
      client.on('connect', () => resolve('connected'));
      client.on('connect_error', (e: Error) => resolve(e.message));
      setTimeout(() => resolve('timeout'), 5000);
    });
    expect(outcome).toBe('connected');
    client.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });
});
