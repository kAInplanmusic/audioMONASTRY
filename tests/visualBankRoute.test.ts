process.env.NODE_ENV ??= 'test';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

/**
 * Route `/api/ai/vision/bank/:id`: Whitelist, Streaming, Range, Cache-Header.
 *
 * Der Upstream (R2) wird gemockt — der Test darf nicht ins Netz. Geprüft wird
 * genau das, was im Audit gefehlt hat: 404 statt Prototyp-Treffer, 206/Content-
 * Range bei Range, `immutable`-Cache, Fehlerabbildung (R2-429 → 503) und HEAD.
 */
type Upstream = { status: number; headers?: Record<string, string>; body?: string };

let server: Server;
let baseUrl = '';
let respond: Upstream = { status: 200, body: 'CLIP' };
const fetchMock = vi.fn(async () => new Response(respond.body ?? '', {
  status: respond.status,
  headers: respond.headers ?? {},
}));

beforeAll(async () => {
  vi.stubGlobal('fetch', fetchMock);
  const app = express();
  const { registerAiRoutes } = await import('../server/routes/aiRoutes');
  registerAiRoutes(app, {
    metrics: { aiRequests: 0, aiFailures: 0, aiCacheHits: 0, aiCacheMisses: 0 },
  });
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.unstubAllGlobals();
});

beforeEach(() => {
  fetchMock.mockClear();
  respond = { status: 200, body: 'CLIP' };
});

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

const get = (path: string, headers: Record<string, string> = {}) => request(path, 'GET', headers);
const h = (r: { headers: http.IncomingHttpHeaders }, name: string) => String(r.headers[name] ?? '');

describe('GET /api/ai/vision/bank/:id', () => {
  it('liefert einen bekannten Clip mit Cache- und Range-Headern', async () => {
    respond = { status: 200, headers: { 'content-type': 'video/mp4', 'content-length': '4' }, body: 'CLIP' };
    const res = await get('/api/ai/vision/bank/neon_stage');
    expect(res.status).toBe(200);
    expect(res.body).toBe('CLIP');
    expect(h(res, 'content-type')).toBe('video/mp4');
    expect(h(res, 'accept-ranges')).toBe('bytes');
    expect(String(h(res, 'cache-control'))).toContain('immutable');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('liefert Startbilder mit image/jpeg', async () => {
    respond = { status: 200, headers: { 'content-length': '4' }, body: 'JPG!' };
    const res = await get('/api/ai/vision/bank/m01a_start');
    expect(res.status).toBe(200);
    expect(h(res, 'content-type')).toBe('image/jpeg');
  });

  it('unbekannte ID -> 404, ohne R2 zu fragen', async () => {
    const res = await get('/api/ai/vision/bank/gibt-es-nicht');
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Prototyp-Schlüssel (constructor) -> 404 statt 502', async () => {
    const res = await get('/api/ai/vision/bank/constructor');
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reicht Range durch (206 + Content-Range)', async () => {
    respond = {
      status: 206,
      headers: { 'content-range': 'bytes 0-3/4', 'content-length': '4' },
      body: 'CLIP',
    };
    const res = await get('/api/ai/vision/bank/neon_stage', { Range: 'bytes=0-3' });
    expect(res.status).toBe(206);
    expect(h(res, 'content-range')).toBe('bytes 0-3/4');
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Range).toBe('bytes=0-3');
  });

  it('R2-404 -> 404, R2-429 -> 503 mit Retry-After', async () => {
    respond = { status: 404 };
    expect((await get('/api/ai/vision/bank/neon_stage')).status).toBe(404);

    respond = { status: 429 };
    const throttled = await get('/api/ai/vision/bank/neon_stage');
    expect(throttled.status).toBe(503);
    expect(h(throttled, 'retry-after')).toBe('2');
  });

  it('HEAD liefert die Header ohne Body', async () => {
    respond = { status: 200, headers: { 'content-length': '4' }, body: 'CLIP' };
    const res = await request('/api/ai/vision/bank/neon_stage', 'HEAD');
    expect(res.status).toBe(200);
    expect(String(h(res, 'cache-control'))).toContain('immutable');
    expect(res.body).toBe('');
  });

  /**
   * PROD-BEFUND 2026-11-05: bricht der Client mitten im Stream ab (Tab zu, Seek,
   * Netz weg), feuert `res.on('close')` den AbortController; der Upstream-Body
   * endet dann mit `AbortError`, `Readable.fromWeb(...).pipe(res)` hatte aber
   * KEINEN 'error'-Handler -> unbehandeltes error-Event -> der komplette
   * Node-Prozess stirbt. Gemessen an `node dist/server.cjs`: eine einzige
   * abgebrochene Range-Anfrage beendete den Server (ERR_CONNECTION_RESET, danach
   * Connection refused). Dieser Test haelt fest, dass ein abgebrochener Stream
   * hoechstens die eine Antwort beendet.
   */
  it('Client-Abbruch mitten im Stream toetet den Prozess nicht', async () => {
    const encoder = new TextEncoder();
    const brokenBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('AAA'));
      },
      pull() {
        return new Promise((_resolve, reject) => {
          setTimeout(() => reject(new DOMException('This operation was aborted', 'AbortError')), 10);
        });
      },
    });
    fetchMock.mockImplementationOnce(async () => new Response(brokenBody, {
      status: 200,
      headers: { 'content-type': 'video/mp4' },
    }));

    const uncaught: unknown[] = [];
    const onUncaught = (err: unknown) => { uncaught.push(err); };
    process.on('uncaughtException', onUncaught);
    try {
      await new Promise<void>((resolve) => {
        const req = http.get(`${baseUrl}/api/ai/vision/bank/neon_stage`, (res) => {
          res.once('data', () => { req.destroy(); resolve(); });
          res.on('end', resolve);
          res.on('error', () => resolve());
        });
        req.on('error', () => resolve());
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
    } finally {
      process.off('uncaughtException', onUncaught);
    }

    expect(uncaught).toEqual([]);
    // Der Server lebt weiter: die naechste Anfrage wird normal beantwortet.
    respond = { status: 200, headers: { 'content-length': '4' }, body: 'CLIP' };
    expect((await get('/api/ai/vision/bank/neon_stage')).status).toBe(200);
  });
});
