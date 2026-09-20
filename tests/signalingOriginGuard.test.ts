/**
 * F7-Fix: Signalisierungs-Origins hart gesetzt (kein CORS-Wildcard).
 * ==================================================================
 * Befund am 2026-09-20 (externe Instanz):
 *   curl -H "Origin: https://evil.example" http://<app>/webrtc-signaling/?EIO=4&transport=polling
 *   -> `Access-Control-Allow-Origin: *`
 * Ursache: `SIGNALING_ALLOWED_ORIGINS=*` (der Portal-Worker schrieb die Wildcard
 * fest in die Knoten-.env) – der einzige verbliebene Schutz war das
 * Handshake-Token.
 *
 * Geprüft wird an einem echten Serverstart (Production-Modus, feste Allowlist):
 *   - eigene Origin: CORS reflektiert GENAU diese Origin (niemals `*`),
 *   - fremde Origin: kein `*`, Handshake scheitert mit `origin-not-allowed`,
 *   - mit gültigem Token verbindet die erlaubte Origin.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { vi } from 'vitest';

const ALLOWED = 'http://allowed.example';
const FOREIGN = 'https://evil.example';

let httpServer: Server;
let baseUrl = '';
let port = 0;

function pollingHeaders(origin: string): Record<string, string> {
  return { origin, // Engine.IO-Handshake wie ihn ein Browser sendet
  };
}

beforeAll(async () => {
  process.env.NODE_ENV = 'production';
  process.env.VITEST = 'true';
  process.env.STUDIO_ACCESS_TOKEN = 'test-studio-token';
  // Genau die Konfiguration, die der Portal-Worker jetzt schreibt.
  process.env.SIGNALING_ALLOWED_ORIGINS = ALLOWED;
  vi.resetModules();
  const mod = await import('../server');
  const started = await mod.startServer(0);
  if (!started) throw new Error('Server startete nicht');
  httpServer = started.httpServer;
  const addr = httpServer.address() as AddressInfo;
  port = addr.port;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  delete process.env.SIGNALING_ALLOWED_ORIGINS;
  delete process.env.STUDIO_ACCESS_TOKEN;
});

describe('F7: Signaling-Origin-Allowlist', () => {
  it('erlaubte Origin bekommt CORS für genau diese Origin (kein Wildcard)', async () => {
    const res = await fetch(`${baseUrl}/webrtc-signaling/?EIO=4&transport=polling`, {
      headers: pollingHeaders(ALLOWED),
    });
    expect(res.headers.get('access-control-allow-origin')).toBe(ALLOWED);
    expect(res.headers.get('access-control-allow-origin')).not.toBe('*');
  });

  it('fremde Origin bekommt kein `*` (Befund von 2026-09-20 behoben)', async () => {
    const res = await fetch(`${baseUrl}/webrtc-signaling/?EIO=4&transport=polling`, {
      headers: pollingHeaders(FOREIGN),
    });
    const allowOrigin = res.headers.get('access-control-allow-origin');
    expect(allowOrigin).not.toBe('*');
    expect(allowOrigin).not.toBe(FOREIGN);
  });

  it('fremde Origin wird beim Handshake mit `origin-not-allowed` abgelehnt', async () => {
    const { io: ioc } = await import('socket.io-client');
    const client = ioc(`http://127.0.0.1:${port}`, {
      path: '/webrtc-signaling',
      transports: ['websocket'],
      reconnection: false,
      timeout: 3000,
      auth: { token: 'test-studio-token' },
      extraHeaders: { origin: FOREIGN },
    });
    const outcome = await new Promise<string>((resolve) => {
      client.on('connect', () => resolve('connected'));
      client.on('connect_error', (e: Error) => resolve(e.message));
      setTimeout(() => resolve('timeout'), 5000);
    });
    expect(outcome).toBe('origin-not-allowed');
    client.close();
  });

  it('eigene Origin verbindet mit gültigem Token', async () => {
    const { io: ioc } = await import('socket.io-client');
    const client = ioc(`http://127.0.0.1:${port}`, {
      path: '/webrtc-signaling',
      transports: ['websocket'],
      reconnection: false,
      timeout: 3000,
      auth: { token: 'test-studio-token' },
      extraHeaders: { origin: ALLOWED },
    });
    const outcome = await new Promise<string>((resolve) => {
      client.on('connect', () => resolve('connected'));
      client.on('connect_error', (e: Error) => resolve(e.message));
      setTimeout(() => resolve('timeout'), 5000);
    });
    expect(outcome).toBe('connected');
    client.close();
  });
});
