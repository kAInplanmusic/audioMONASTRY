import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

/**
 * GAP-4: Rate-Limit der /api/ai/*-Routen (expensiveLimiter).
 * Eigene Server-Instanz mit API_EXPENSIVE_RATE_LIMIT_MAX=3, damit der
 * Test deterministisch ist und andere Integrationstests nicht beeinflusst.
 */
let appServer: Server;
let baseUrl = '';

beforeAll(async () => {
  process.env.VITEST = 'true';
  delete process.env.STUDIO_ACCESS_TOKEN;
  process.env.API_EXPENSIVE_RATE_LIMIT_MAX = '3';

  const mod = await import('../server');
  appServer = mod.app.listen(0);
  const addr = appServer.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => appServer.close(() => resolve()));
});

describe('GAP-4: /api/ai/* Rate-Limit', () => {
  it('erlaubt max. 3 Requests pro Fenster, danach 429', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`${baseUrl}/api/ai/models`);
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
    expect(statuses.slice(3)).toEqual([429, 429]);
  });

  it('teure Routen (orchestrate) unterliegen demselben Limit', async () => {
    // Das Limit der Instanz ist bereits ausgeschöpft → 429 ohne Netzaufruf.
    const res = await fetch(`${baseUrl}/api/ai/orchestrate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: 'audio.transcribe', model: 'whisper-large-v3' }),
    });
    expect(res.status).toBe(429);
  });
});
