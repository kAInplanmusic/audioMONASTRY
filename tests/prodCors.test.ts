// PROD-P2-002: CORS-Allowlist gegen die Produktionsdomain (fail-closed).
// In Produktion mit API_ALLOWED_ORIGINS werden fremde Origins abgewiesen,
// die eigene Domain und Anfragen ohne Origin (curl, LB-Probe) passieren.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';

let server: Server;
let baseUrl = '';

const ALLOWED = 'https://anunnakitools.de';
const FOREIGN = 'https://evil.example';

beforeAll(async () => {
  process.env.NODE_ENV = 'production';
  process.env.VITEST = 'true';
  delete process.env.STUDIO_ACCESS_TOKEN;
  process.env.API_ALLOWED_ORIGINS = ALLOWED;
  process.env.SCRAPE_TOKEN = 'scrape-cors-2026';
  process.env.API_EXPENSIVE_RATE_LIMIT_MAX = '1000';
  const mod = await import('../server');
  server = mod.app.listen(0);
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('kein Port');
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('PROD-P2-002 CORS-Allowlist', () => {
  it('lässt die erlaubte Produktionsdomain durch', async () => {
    const res = await fetch(`${baseUrl}/api/health`, { headers: { origin: ALLOWED } });
    expect(res.status).toBe(200);
  });

  it('weist eine fremde Origin mit 403 ab', async () => {
    const res = await fetch(`${baseUrl}/api/health`, { headers: { origin: FOREIGN } });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('ORIGIN_NOT_ALLOWED');
  });

  it('lässt Anfragen ohne Origin zu (curl/LB-Probe)', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
  });
});
