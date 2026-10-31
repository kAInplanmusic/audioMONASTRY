import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { signStudioSession } from '../src/core/session/studioSession';

const master = 'audit-test-master';
const secret = 'audit-test-session-secret';
const scrape = 'audit-test-scrape';
let server: Server;
let baseUrl: string;
let session: string;
const originalFetch = globalThis.fetch;

beforeAll(asyncSetup, 120_000);

async function asyncSetup() {
  process.env.VITEST = 'true';
  process.env.NODE_ENV = 'production';
  process.env.STUDIO_ACCESS_TOKEN = master;
  process.env.SESSION_SECRET = secret;
  process.env.SCRAPE_TOKEN = scrape;
  // server.ts wires the fleet during import; never allow that network request.
  vi.stubGlobal('fetch', async () => { throw new Error('outbound network disabled'); });
  const mod = await import('../server');
  server = mod.app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no test port');
  baseUrl = `http://127.0.0.1:${address.port}`;
  session = await signStudioSession(secret, { ttlS: 60 });
}

afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  vi.unstubAllGlobals();
  delete process.env.STUDIO_ACCESS_TOKEN;
  delete process.env.SESSION_SECRET;
  delete process.env.SCRAPE_TOKEN;
});

const get = (path: string, headers: Record<string, string> = {}) => originalFetch(`${baseUrl}${path}`, { headers });

describe('audit operator authorization on the actual server', () => {
  it('rejects a valid ordinary session while allowing normal API access', async () => {
    const credentials: Record<string, string>[] = [
      { 'x-studio-token': session },
      { cookie: `studio=${encodeURIComponent(session)}` },
    ];
    for (const headers of credentials) {
      expect((await get('/api/online', headers)).status).toBe(200);
      const audit = await get('/api/audit', headers);
      expect(audit.status).toBe(403);
      expect(await audit.json()).toMatchObject({ code: 'AUDIT_OPERATOR_ONLY' });
    }
  });

  it('allows the master token via the existing header, bearer and cookie mechanisms', async () => {
    const credentials: Record<string, string>[] = [
      { 'x-studio-token': master },
      { authorization: `Bearer ${master}` },
      { cookie: `studio=${encodeURIComponent(master)}` },
    ];
    for (const headers of credentials) {
      const audit = await get('/api/audit', headers);
      expect(audit.status).toBe(200);
      expect(await audit.json()).toMatchObject({ entries: expect.any(Array), total: expect.any(Number) });
    }
  });

  it('does not allow unauthenticated, invalid, or scrape-only credentials', async () => {
    const credentials: Record<string, string>[] = [{}, { 'x-studio-token': 'invalid' }, { 'x-scrape-token': scrape }, { authorization: `Bearer ${scrape}` }];
    for (const headers of credentials) {
      expect((await get('/api/audit', headers)).status).toBe(401);
    }
    expect((await get('/api/online', { 'x-scrape-token': scrape })).status).toBe(200);
  });
});
