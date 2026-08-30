import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';

// P-1: Studio-Token-Modus in einer eigenen Server-Instanz testen.
process.env.VITEST = 'true';
process.env.STUDIO_ACCESS_TOKEN = 'test-studio-token';

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
});

describe('Security (Studio-Token, P-1/P-9/P-12)', () => {
  it('GET /api/health bleibt offen (Loadbalancer/Monitoring)', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
  });

  it('GET /api/metrics ohne Token → 401', async () => {
    const res = await fetch(`${baseUrl}/api/metrics`);
    expect(res.status).toBe(401);
  });

  it('GET /api/metrics mit Token → 200', async () => {
    const res = await fetch(`${baseUrl}/api/metrics`, {
      headers: { 'x-studio-token': 'test-studio-token' },
    });
    expect(res.status).toBe(200);
  });

  it('POST /api/telemetry: ohne Token 401, mit Token 202', async () => {
    const body = JSON.stringify({ events: [{ type: 'x', source: 'y', message: 'z' }] });
    const noToken = await fetch(`${baseUrl}/api/telemetry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    expect(noToken.status).toBe(401);

    const withToken = await fetch(`${baseUrl}/api/telemetry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-studio-token': 'test-studio-token' },
      body,
    });
    expect(withToken.status).toBe(202);
  });

  it('POST /api/cloud/upload: ohne Token 401', async () => {
    const res = await fetch(`${baseUrl}/api/cloud/upload?key=uploads/ok.wav`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(4),
    });
    expect(res.status).toBe(401);
  });

  it('POST /api/cloud/upload: mit Token + ungültigem Key → 400 (Whitelist)', async () => {
    const res = await fetch(`${baseUrl}/api/cloud/upload?key=../evil.wav`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'x-studio-token': 'test-studio-token' },
      body: new Uint8Array(4),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(String(body.error)).toContain('invalid key');
  });
});
