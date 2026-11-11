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

/**
 * SEC-2026-11-06-001: Die /api-Auth-Middleware hatte eine Ausnahme, die den
 * Studio-Master-Token als `?token=` durchliess (VISUAL-P1-001, Beamer-Fallback).
 * Seit AUDIT-2026-10-30-P1-006 weisen die Visual-Routen Query-Tokens selbst ab
 * und der Beamer laeuft ueber `/visual-stream/mjpeg` (ausserhalb von `/api`,
 * Nachweis = Einmal-Ticket). Die Ausnahme war damit ein toter Durchlass, der
 * auf JEDER anderen /api-Route den Master-Token in URL, Access-Log, Referer und
 * Browser-History brachte. Hier steht der Nachweis: Query-Token -> 401,
 * Header/Bearer/Cookie -> unveraendert 200, Ticket-Strom -> 200 multipart.
 */
describe('SEC-2026-11-06-001 · Master-Token nie als Query auf /api', () => {
  const TOKEN = 'test-studio-token';
  const QUERY = `token=${encodeURIComponent(TOKEN)}`;

  beforeEach(() => {
    resetAuthEnv({ NODE_ENV: 'test', STUDIO_ACCESS_TOKEN: TOKEN });
  });

  it('weist den Master-Token im Query auf /api-Routen ab (401)', async () => {
    await startAppServer();
    for (const path of ['/api/metrics', '/api/store', '/api/visual/mjpeg']) {
      const res = await fetch(`${baseUrl}${path}?${QUERY}`);
      expect(res.status, `${path} mit Query-Token`).toBe(401);
      // Einheitliche Ablehnung der GLOBALEN Auth. Vor dem Fix kam die 401 auf
      // /api/visual/mjpeg aus der Route ({error:'STUDIO_TOKEN_REQUIRED'} ohne
      // `code`) - Beweis, dass die Middleware die Anfrage durchgelassen hat.
      expect(await res.json(), path).toMatchObject({
        error: 'unauthorized',
        code: 'STUDIO_TOKEN_REQUIRED',
      });
    }
  });

  it('Query-Token oeffnet die Routenlogik nicht (kein Ticket-Orakel)', async () => {
    await startAppServer();
    // Vor dem Fix: Middleware liess den Query-Token durch, die ROUTE prueft das
    // (falsche) Ticket und antwortete 403 - ein Unauthentifizierter konnte damit
    // Ticket-Zustaende ausprobieren. Jetzt endet es an der globalen Auth (401).
    const res = await fetch(`${baseUrl}/api/visual/mjpeg?${QUERY}&ticket=falsch`);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'unauthorized', code: 'STUDIO_TOKEN_REQUIRED' });
  });

  it('laesst /api/health offen (auch mit Query-Token)', async () => {
    await startAppServer();
    const plain = await fetch(`${baseUrl}/api/health`);
    expect(plain.status).toBe(200);
    const withQuery = await fetch(`${baseUrl}/api/health?${QUERY}`);
    expect(withQuery.status).toBe(200);
  });

  it('akzeptiert Header, Bearer und Cookie weiterhin (200)', async () => {
    await startAppServer();
    const viaHeader = await fetch(`${baseUrl}/api/metrics`, {
      headers: { 'x-studio-token': TOKEN },
    });
    expect(viaHeader.status).toBe(200);
    const viaBearer = await fetch(`${baseUrl}/api/metrics`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(viaBearer.status).toBe(200);
    const viaCookie = await fetch(`${baseUrl}/api/metrics`, {
      headers: { cookie: `studio=${TOKEN}` },
    });
    expect(viaCookie.status).toBe(200);
  });

  it('Beamer-Ticket unter /visual-stream/mjpeg (ausserhalb /api) liefert 200 multipart', async () => {
    await startAppServer();
    // Ein Frame im Hub, sonst schreibt der Strom seine Kopfzeilen erst spaeter.
    const frame = await fetch(`${baseUrl}/api/visual/frame`, {
      method: 'POST',
      headers: { 'x-studio-token': TOKEN, 'Content-Type': 'image/jpeg' },
      body: Buffer.alloc(64, 5),
    });
    expect(frame.status).toBe(200);

    const issued = await fetch(`${baseUrl}/api/visual/mjpeg-ticket`, {
      method: 'POST',
      headers: { 'x-studio-token': TOKEN },
    });
    expect(issued.status).toBe(200);
    const { ticket } = (await issued.json()) as { ticket?: string };
    expect(typeof ticket).toBe('string');

    const controller = new AbortController();
    const stream = await fetch(`${baseUrl}/visual-stream/mjpeg?ticket=${encodeURIComponent(String(ticket))}`, {
      signal: controller.signal,
    });
    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toContain('multipart/x-mixed-replace');
    controller.abort();
  }, 20_000);

  it('/api/visual/mjpeg mit Header bleibt 200 (Stream), Query-Ticket bleibt ungueltig ohne Credentials', async () => {
    await startAppServer();
    await fetch(`${baseUrl}/api/visual/frame`, {
      method: 'POST',
      headers: { 'x-studio-token': TOKEN, 'Content-Type': 'image/jpeg' },
      body: Buffer.alloc(64, 5),
    });
    const controller = new AbortController();
    const withHeader = await fetch(`${baseUrl}/api/visual/mjpeg`, {
      headers: { 'x-studio-token': TOKEN },
      signal: controller.signal,
    });
    expect(withHeader.status).toBe(200);
    expect(withHeader.headers.get('content-type')).toContain('multipart/x-mixed-replace');
    controller.abort();

    const issued = await fetch(`${baseUrl}/api/visual/mjpeg-ticket`, {
      method: 'POST',
      headers: { 'x-studio-token': TOKEN },
    });
    const { ticket } = (await issued.json()) as { ticket?: string };
    const anonymous = await fetch(
      `${baseUrl}/api/visual/mjpeg?ticket=${encodeURIComponent(String(ticket))}`,
    );
    expect(anonymous.status).toBe(401);
  }, 20_000);
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
      API_ALLOWED_ORIGINS: 'https://hallerbans.de',
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
        origin: 'https://hallerbans.de',
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
