process.env.NODE_ENV ??= 'test';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { BANK_R2_SOURCES } from '../src/visuals/visualBank';

/**
 * Route `/api/ai/vision/bank/:id`: Whitelist, Streaming, Range, Cache-Header.
 *
 * Der Upstream (R2) wird gemockt — der Test darf nicht ins Netz. Geprüft wird
 * genau das, was im Audit gefehlt hat: 404 statt Prototyp-Treffer, 206/Content-
 * Range bei Range, `immutable`-Cache, Fehlerabbildung (R2-429 → 503) und HEAD.
 *
 * Seit der Bucket privat ist (Lizenzbedingung), darf die Route das Objekt nur
 * noch über den signierten S3-Endpunkt holen: `BANK_R2_SOURCES` enthält
 * Objekt-Keys, und KEINE Datei unter `src/`/`server/` darf eine
 * `pub-*.r2.dev`-URL nennen.
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
  // Privater Bucket: die Route signiert selbst, Zugangsdaten kommen aus der Env.
  vi.stubEnv('CFS3_ACCESS_KEY', '0123456789abcdef0123456789abcdef');
  vi.stubEnv('CFS3_SECRET_KEY', 'f'.repeat(64));
  vi.stubEnv('CFS3_BUCKET', 'test-bucket');
  vi.stubEnv('CFS3_ENDPOINT', 'https://example.r2.cloudflarestorage.com');
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
  vi.unstubAllEnvs();
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

/**
 * Lizenzbedingung: der Bucket ist privat. Deshalb darf die Route das Objekt
 * nicht mehr per oeffentlicher `pub-*.r2.dev`-URL holen (die liefert nach dem
 * Abschalten des Public Access 403 -> 502), sondern muss den Objekt-Key
 * serverseitig mit SigV4 signieren und ueber den S3-Endpunkt lesen.
 */
describe('privater Bucket: S3-Signatur statt r2.dev', () => {
  it('holt den Clip signiert vom Bucket-Endpunkt (kein r2.dev)', async () => {
    const res = await get('/api/ai/vision/bank/neon_stage');
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const upstream = new URL(url);
    expect(upstream.host).toBe('example.r2.cloudflarestorage.com');
    expect(upstream.pathname).toBe('/test-bucket/visuals/vorlagen/neon_stage.mp4');
    expect(upstream.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(upstream.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    expect(url).not.toContain('r2.dev');
    expect(String((init.headers as Record<string, string> | undefined)?.Range ?? '')).toBe('');
  });

  it('signiert auch Varianten und Startbilder (Key aus der Bank-ID)', async () => {
    const variantId = Object.keys(BANK_R2_SOURCES).find((id) => id.startsWith('m01a_') && !id.endsWith('_start'));
    expect(variantId, 'Variante von m01a in der Whitelist').toBeTruthy();
    await get(`/api/ai/vision/bank/${variantId}`);
    const [variantUrl] = fetchMock.mock.calls[0] as unknown as [string];
    const variant = new URL(variantUrl);
    expect(variant.pathname).toBe(`/test-bucket/visuals/bank/${variantId}.mp4`);
    expect(variant.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);

    fetchMock.mockClear();
    await get('/api/ai/vision/bank/m01a_start');
    const [startUrl] = fetchMock.mock.calls[0] as unknown as [string];
    expect(new URL(startUrl).pathname).toBe('/test-bucket/visuals/bank/m01a_start.jpg');
  });

  it('BANK_R2_SOURCES enthaelt Objekt-Keys, keine URLs', () => {
    const entries = Object.entries(BANK_R2_SOURCES);
    expect(entries.length).toBeGreaterThan(0);
    for (const [id, source] of entries) {
      expect(source, `${id} darf keine URL sein`).not.toMatch(/^[a-z]+:\/\//i);
      expect(source, `${id} muss ein visuals/-Key sein`).toMatch(/^visuals\/[a-z]+\/[A-Za-z0-9_-]+\.(mp4|jpg|jpeg|png)$/);
    }
    expect(BANK_R2_SOURCES.neon_stage).toBe('visuals/vorlagen/neon_stage.mp4');
    expect(BANK_R2_SOURCES.m01a).toBe('visuals/bank/m01a.mp4');
  });

  it('keine oeffentliche r2.dev-URL mehr in src/ und server/', () => {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const rel = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(rel);
        else if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry.name)
          && readFileSync(join(root, rel), 'utf8').includes('pub-663ece9f')) hits.push(rel);
      }
    };
    walk('src');
    walk('server');
    expect(hits).toEqual([]);
  });
});
