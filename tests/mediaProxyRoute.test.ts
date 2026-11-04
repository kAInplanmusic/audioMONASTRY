process.env.NODE_ENV ??= 'test';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

/**
 * `GET /api/media/r2/<key>` — same-origin-Auslieferung aus dem privaten Bucket.
 *
 * Der Test mockt den Upstream (presignte R2-URL) und die R2-Konfiguration, damit
 * er offline läuft. Geprüft wird: Präfix-Whitelist, Range/206, MIME, Cache-
 * Header und die Fehlerabbildung.
 */
type Upstream = { status: number; headers?: Record<string, string>; body?: string };
let respond: Upstream = { status: 200, body: 'DATA' };
const fetchMock = vi.fn(async () => new Response(respond.body ?? '', {
  status: respond.status,
  headers: respond.headers ?? {},
}));

let server: Server;
let baseUrl = '';
let register: typeof import('../server/routes/mediaProxyRoutes');
let allowed: typeof import('../server/routes/mediaProxyRoutes').isAllowedR2Key;

const request = (path: string, method = 'GET', headers: Record<string, string> = {}) =>
  new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = http.request(`${baseUrl}${path}`, { method, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });

const h = (r: { headers: http.IncomingHttpHeaders }, name: string) => String(r.headers[name] ?? '');

beforeAll(async () => {
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('CFS3_ACCESS_KEY', '0123456789abcdef0123456789abcdef');
  vi.stubEnv('CFS3_SECRET_KEY', 'f'.repeat(64));
  vi.stubEnv('CFS3_BUCKET', 'test-bucket');
  vi.stubEnv('CFS3_ENDPOINT', 'https://example.r2.cloudflarestorage.com');
  register = await import('../server/routes/mediaProxyRoutes');
  allowed = register.isAllowedR2Key;
  const app = express();
  register.registerMediaProxyRoutes(app);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

beforeEach(() => {
  fetchMock.mockClear();
  respond = { status: 200, body: 'DATA' };
});

describe('Präfix-Whitelist', () => {
  it('erlaubt nur samples/, uploads/, vision/, visuals/, stems/', () => {
    expect(allowed('samples/music/brian/x.mp3')).toBe(true);
    expect(allowed('visuals/bank/m01a.mp4')).toBe(true);
    expect(allowed('vision/artifact.png')).toBe(true);
    expect(allowed('stems/abc/1.wav')).toBe(true);
    expect(allowed('music/track.mp3')).toBe(true);
    expect(allowed('Dj Monachum - VantaBLK.mp3')).toBe(true);   // Wurzel-Medien
    expect(allowed('notes.txt')).toBe(false);                    // Wurzel, kein Medium
    expect(allowed('weights/model.safetensors')).toBe(false);
    expect(allowed('autosaves/state.json')).toBe(false);
  });

  it('blockt Traversal, Backslashes und überlange Schlüssel', () => {
    expect(allowed('samples/../secrets.env')).toBe(false);
    expect(allowed('samples\\music\\x.mp3')).toBe(false);
    expect(allowed('samples/' + 'a'.repeat(600))).toBe(false);
    expect(allowed('')).toBe(false);
  });
});

describe('GET /api/media/r2/:key', () => {
  it('liefert eine Datei mit MIME und privatem Cache', async () => {
    respond = { status: 200, headers: { 'content-length': '4' }, body: 'DATA' };
    const res = await request('/api/media/r2/samples/music/brian/x.mp3');
    expect(res.status).toBe(200);
    expect(res.body).toBe('DATA');
    expect(h(res, 'content-type')).toBe('audio/mpeg');
    expect(h(res, 'accept-ranges')).toBe('bytes');
    expect(h(res, 'cache-control')).toContain('private');
  });

  it('verweigert Schlüssel außerhalb der Whitelist ohne R2-Aufruf', async () => {
    const res = await request('/api/media/r2/weights/model.safetensors');
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reicht Range durch (206 + Content-Range)', async () => {
    respond = { status: 206, headers: { 'content-range': 'bytes 0-3/4' }, body: 'DATA' };
    const res = await request('/api/media/r2/samples/music/x.mp3', 'GET', { Range: 'bytes=0-3' });
    expect(res.status).toBe(206);
    expect(h(res, 'content-range')).toBe('bytes 0-3/4');
  });

  it('R2-404 -> 404, R2-429 -> 503 mit Retry-After', async () => {
    respond = { status: 404 };
    expect((await request('/api/media/r2/vision/a.png')).status).toBe(404);
    respond = { status: 429 };
    const throttled = await request('/api/media/r2/vision/a.png');
    expect(throttled.status).toBe(503);
    expect(h(throttled, 'retry-after')).toBe('2');
  });

  it('HEAD liefert Header ohne Body', async () => {
    respond = { status: 200, headers: { 'content-length': '4' }, body: 'DATA' };
    const res = await request('/api/media/r2/visuals/bank/m01a.mp4', 'HEAD');
    expect(res.status).toBe(200);
    expect(res.body).toBe('');
  });
});
