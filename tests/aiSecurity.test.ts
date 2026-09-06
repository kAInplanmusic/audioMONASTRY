import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

/**
 * GAP-4: Pen-Test-Abdeckung der /api/ai/*-Routen (automatisierter Teil).
 * Prüft Auth (Studio-Token), Eingangs-Validierung und SSRF-Härtung
 * (Modell-IDs dürfen keine URLs/Pfadtraversal enthalten). Rate-Limit-Tests
 * liegen in `tests/aiRateLimitRoutes.test.ts` (eigene Server-Instanz mit
 * kleinem Limit).
 */
let appServer: Server;
let baseUrl = '';

beforeAll(async () => {
  process.env.VITEST = 'true';
  process.env.STUDIO_ACCESS_TOKEN = 'pen-test-secret';
  process.env.API_EXPENSIVE_RATE_LIMIT_MAX = '1000';
  // Orchestrate-Validierungstests dürfen keinen echten HF-Endpoint ansprechen;
  // die 422er werden VOR dem Provider-Routing erzeugt.
  process.env.HF_ENDPOINT_URL = 'http://127.0.0.1:1';

  const mod = await import('../server');
  appServer = mod.app.listen(0);
  const addr = appServer.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => appServer.close(() => resolve()));
});

describe('GAP-4: /api/ai/* Auth (Studio-Token)', () => {
  it('GET /api/ai/models ohne Token → 401', async () => {
    const res = await fetch(`${baseUrl}/api/ai/models`);
    expect(res.status).toBe(401);
    const body = await res.json() as { code?: string };
    expect(body.code).toBe('STUDIO_TOKEN_REQUIRED');
  });

  it('GET /api/ai/models mit gültigem x-studio-token → 200', async () => {
    const res = await fetch(`${baseUrl}/api/ai/models`, {
      headers: { 'x-studio-token': 'pen-test-secret' },
    });
    expect(res.status).toBe(200);
  });

  it('GET /api/ai/models mit gültigem studio-Cookie → 200', async () => {
    const res = await fetch(`${baseUrl}/api/ai/models`, {
      headers: { cookie: 'studio=pen-test-secret' },
    });
    expect(res.status).toBe(200);
  });

  it('POST /api/ai/session/heartbeat ohne Token → 401', async () => {
    const res = await fetch(`${baseUrl}/api/ai/session/heartbeat`, { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('GET /api/ai/mcp/tools mit falschem Token → 401', async () => {
    const res = await fetch(`${baseUrl}/api/ai/mcp/tools`, {
      headers: { 'x-studio-token': 'wrong-token' },
    });
    expect(res.status).toBe(401);
  });
});

describe('GAP-4: /api/ai/* Eingangs-Validierung (Orchestrate)', () => {
  const post = (body: unknown) =>
    fetch(`${baseUrl}/api/ai/orchestrate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-studio-token': 'pen-test-secret' },
      body: JSON.stringify(body),
    });

  it('unbekannter Task → 422 (kein freies Provider-Routing)', async () => {
    const res = await post({ task: '../../etc/passwd', model: 'whisper-large-v3' });
    expect(res.status).toBe(422);
    const body = await res.json() as { error?: string };
    expect(body.error).toBe('unknown task');
  });

  it('Modell-ID als URL → 422 (SSRF-Härtung)', async () => {
    const res = await post({ task: 'audio.transcribe', model: 'http://169.254.169.254/latest/meta-data' });
    expect(res.status).toBe(422);
    const body = await res.json() as { error?: string };
    expect(body.error).toBe('invalid model id');
  });

  it('Modell-ID mit Pfadtraversal → 422', async () => {
    const res = await post({ task: 'audio.transcribe', model: '../secret/model' });
    expect(res.status).toBe(422);
  });

  it('Modell-ID mit Whitespace/Steuerzeichen → 422', async () => {
    const res = await post({ task: 'audio.transcribe', model: 'whisper large\nv3' });
    expect(res.status).toBe(422);
  });

  it('fehlende task/model-Felder → 422', async () => {
    expect((await post({})).status).toBe(422);
    expect((await post({ task: 'audio.transcribe' })).status).toBe(422);
  });
});
