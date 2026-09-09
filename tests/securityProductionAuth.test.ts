import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';

/**
 * P0-Security: Production Auth fail-closed.
 * In Produktion (NODE_ENV=production) darf die API OHNE STUDIO_ACCESS_TOKEN
 * NICHT ungeschützt laufen. Nur /api/health bleibt offen (Loadbalancer/Monitoring).
 */
process.env.VITEST = 'true';
process.env.NODE_ENV = 'production';
delete process.env.STUDIO_ACCESS_TOKEN;

let server: Server;
let baseUrl = '';

beforeAll(async () => {
  const mod = await import('../server');
  server = mod.app.listen(0);
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('kein Port');
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  // ARCH-PERF-001: Env-Leak verhindern. Diese Datei setzt NODE_ENV=production
  // global; im selben Vitest-Worker würde das nachfolgende Testdateien
  // verfälschen (Production-Auth-Guard). Zurücksetzen auf den Test-Default.
  process.env.NODE_ENV = 'test';
  delete process.env.STUDIO_ACCESS_TOKEN;
});

describe('Security Production Auth fail-closed (ARCH-SEC-001)', () => {
  it('GET /api/health bleibt offen (Loadbalancer/Monitoring)', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
  });

  it('GET /api/metrics ohne Token in Production → 503 (fail-closed, kein stiller Dev-Modus)', async () => {
    const res = await fetch(`${baseUrl}/api/metrics`);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('STUDIO_TOKEN_MISSING');
  });

  it('POST /api/telemetry ohne Token in Production → 503', async () => {
    const res = await fetch(`${baseUrl}/api/telemetry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: [{ type: 'x', source: 'y', message: 'z' }] }),
    });
    expect(res.status).toBe(503);
  });

  it('POST /api/cloud/samples ohne Token in Production → 503 (kein Auth-Bypass)', async () => {
    const res = await fetch(`${baseUrl}/api/cloud/samples`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(503);
  });
});
