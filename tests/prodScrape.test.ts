// PROD-P0-001: Monitoring-Scrape (SCRAPE_TOKEN) für /api/metrics und /api/online.
// Nachweis, dass die Lese-Metriken für Prometheus erreichbar sind, während alle
// übrigen Routen fail-closed bleiben (Studie 2026-09-14: ohne Token alles 401).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';

let server: Server;
let baseUrl = '';

beforeAll(async () => {
  // Produktionsmodus, damit der Test die ECHTE fail-closed-Auth prueft: ohne
  // NODE_ENV=production wuerde Vitest (NODE_ENV=test) die Auth global oeffnen
  // und die 503-Assertions kaemen nie zum Tragen.
  process.env.NODE_ENV = 'production';
  delete process.env.STUDIO_ACCESS_TOKEN;
  process.env.SCRAPE_TOKEN = 'scrape-geheim-2026';
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

describe('PROD-P0-001 Scrape-Token', () => {
  it('liefert /api/metrics mit x-scrape-token', async () => {
    const res = await fetch(`${baseUrl}/api/metrics`, {
      headers: { 'x-scrape-token': 'scrape-geheim-2026' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.uptimeSec).toBe('number');
  });

  it('liefert /api/online mit Authorization: Bearer', async () => {
    const res = await fetch(`${baseUrl}/api/online`, {
      headers: { authorization: 'Bearer scrape-geheim-2026' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.online).toBe('number');
  });

  it('bleibt ohne Token fail-closed (503, STUDIO_TOKEN_MISSING)', async () => {
    const res = await fetch(`${baseUrl}/api/metrics`);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe('STUDIO_TOKEN_MISSING');
  });

  it('lässt /api/health weiterhin offen', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
  });

  it('gibt KEINE Scrape-Ausnahme für andere Routen', async () => {
    const res = await fetch(`${baseUrl}/api/stem/status`, {
      headers: { 'x-scrape-token': 'scrape-geheim-2026' },
    });
    expect(res.status).toBe(503); // kein Studio-Token konfiguriert -> fail-closed
  });
});
