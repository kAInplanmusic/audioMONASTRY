// PROD-P1-001: /api/separate-stems darf ohne Datei kein simuliertes Ergebnis
// liefern; der Fallback-Stub ist nur bei STEM_AI_PROVIDER=fallback aktiv und
// immer mit simulated: true markiert.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';

let server: Server;
let baseUrl = '';

beforeAll(async () => {
  process.env.VITEST = 'true';
  delete process.env.STUDIO_ACCESS_TOKEN;
  delete process.env.ENABLE_STEMS;
  delete process.env.STEM_AI_URL;
  delete process.env.REPLICATE_API_TOKEN;
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

function multipartWithFile(): FormData {
  const fd = new FormData();
  fd.append('file', new Blob([new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0])], { type: 'audio/wav' }), 'probe.wav');
  return fd;
}

describe('PROD-P1-001 separate-stems Stub-Gate', () => {
  it('lehnt JSON-Body ohne multipart mit 400 ab (kein Fake-Stream)', async () => {
    const res = await fetch(`${baseUrl}/api/separate-stems`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(400);
  });

  it('lehnt multipart ohne konfigurierten Provider mit 503 ab', async () => {
    delete process.env.STEM_AI_PROVIDER;
    const res = await fetch(`${baseUrl}/api/separate-stems`, {
      method: 'POST',
      body: multipartWithFile(),
    });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe('NO_STEM_PROVIDER');
  });

  it('streamt den Fallback nur bei STEM_AI_PROVIDER=fallback und markiert simulated: true', async () => {
    process.env.STEM_AI_PROVIDER = 'fallback';
    const res = await fetch(`${baseUrl}/api/separate-stems`, {
      method: 'POST',
      body: multipartWithFile(),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('"progress"');
    expect(text).toContain('"simulated":true');
  }, 10_000);
});
