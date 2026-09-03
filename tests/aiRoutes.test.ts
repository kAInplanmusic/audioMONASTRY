import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

/**
 * Integrationstests der /api/ai/*-Routen (Hetzner-Code-Pfad).
 * Der HF-Endpoint wird durch einen lokalen Mock ersetzt – so testen wir
 * Validation, Job-/Session-Lifecycle und MCP-Routen ohne echte GPU.
 */
let appServer: Server;
let hfMock: Server;
let baseUrl = '';
let hfBase = '';

const json = (res: http.ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

beforeAll(async () => {
  process.env.VITEST = 'true';
  delete process.env.STUDIO_ACCESS_TOKEN;
  process.env.API_EXPENSIVE_RATE_LIMIT_MAX = '1000';
  // LLM-Fallback deterministisch halten: Provider-Keys leeren (dotenv.config()
  // in server.ts würde gelöschte Keys sonst wieder einspielen), Ollama auf
  // einen sofort abweisenden Port zeigen.
  process.env.DEEPSEEK_API_KEY = '';
  process.env.OPENAI_API_KEY = '';
  process.env.MISTRAL_API_KEY = '';
  process.env.GEMINI_API_KEY = '';
  process.env.HF_API_KEY = '';
  process.env.REPLICATE_API_TOKEN = '';
  process.env.OLLAMA_URL = 'http://127.0.0.1:1';
  // Supabase-RPC im Test deaktivieren → /api/library/search nutzt Keyword-Fallback.
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_SERVICE_ROLE = '';

  // HF-Mock: /health, /ready und /infer.
  hfMock = http.createServer((req, res) => {
    if (req.url?.startsWith('/health')) return json(res, 200, { status: 'ok' });
    if (req.url?.startsWith('/ready')) return json(res, 200, { status: 'ready' });
    if (req.url?.startsWith('/infer')) {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        try {
          const body = JSON.parse(raw) as { task?: string; model?: string };
          if (body.task === 'audio.transcribe') return json(res, 200, { status: 'success', result: { text: 'test transcription' } });
          if (body.task === 'audio.embed') return json(res, 200, { status: 'success', result: { embedding: [0.1, 0.2], dim: 2 } });
          if (body.task === 'audio.generate') return json(res, 200, { status: 'success', result: { audioBase64: 'UklGRg==', sampleRate: 32000 } });
          return json(res, 200, { status: 'success', result: { labels: ['Music'], scores: [0.9] } });
        } catch {
          return json(res, 422, { detail: 'bad json' });
        }
      });
      return;
    }
    return json(res, 404, { error: 'not found' });
  });
  await new Promise<void>((resolve) => hfMock.listen(0, '127.0.0.1', resolve));
  const hfAddr = hfMock.address() as AddressInfo;
  hfBase = `http://127.0.0.1:${hfAddr.port}`;
  process.env.HF_ENDPOINT_URL = hfBase;
  process.env.HF_TOKEN = 'test-token';
  process.env.AI_TIMEOUT_MS = '5000';

  const mod = await import('../server');
  appServer = mod.app.listen(0);
  const addr = appServer.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => appServer.close(() => resolve()));
  await new Promise<void>((resolve) => hfMock.close(() => resolve()));
});

describe('/api/ai/*-Routen (Integration)', () => {
  it('POST /api/ai/orchestrate validiert task/model', async () => {
    const res = await fetch(`${baseUrl}/api/ai/orchestrate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(422);
  });

  it('POST /api/ai/orchestrate führt audio.transcribe über HF-Endpoint aus', async () => {
    const res = await fetch(`${baseUrl}/api/ai/orchestrate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: 'u1',
        task: 'audio.transcribe',
        model: 'whisper-large-v3',
        input: { audioBase64: 'UklGRg==', language: 'de' },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { job?: { status?: string }; result?: { text?: string } };
    expect(body.job?.status).toBe('COMPLETED');
    expect(body.result?.text).toBe('test transcription');
  });

  it('POST /api/ai/generate-drop verlangt einen Prompt', async () => {
    const res = await fetch(`${baseUrl}/api/ai/generate-drop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('POST /api/ai/generate-drop liefert ohne LLM einen validen lokalen Drop', async () => {
    const res = await fetch(`${baseUrl}/api/ai/generate-drop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userPrompt: 'Techno buildup mit Bass-Drop',
        context: { bpm: 128, activePlugins: ['synthesizer', 'effect'], currentEnergy: 0.7 },
        style: 'extreme',
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      name?: string;
      parameterSequence?: Array<{ pluginId: string; parameterId: string; startValue: number; endValue: number }>;
      confidence?: number;
      provider?: string;
    };
    expect(typeof body.name).toBe('string');
    expect((body.parameterSequence ?? []).length).toBeGreaterThan(0);
    for (const step of body.parameterSequence ?? []) {
      expect(step.startValue).toBeGreaterThanOrEqual(0);
      expect(step.endValue).toBeLessThanOrEqual(1);
    }
    expect(body.confidence).toBeGreaterThan(0);
    expect(body.provider).toBeTruthy();
  });

  it('GET /api/ai/models liefert die Registry', async () => {
    const res = await fetch(`${baseUrl}/api/ai/models`);
    expect(res.status).toBe(200);
    const body = await res.json() as { models?: Array<{ id: string }> };
    expect(body.models?.some((m) => m.id === 'whisper-large-v3')).toBe(true);
  });

  it('GET /api/ai/mcp/tools liefert Tools', async () => {
    const res = await fetch(`${baseUrl}/api/ai/mcp/tools`);
    expect(res.status).toBe(200);
    const body = await res.json() as { tools?: unknown[] };
    expect(Array.isArray(body.tools)).toBe(true);
  });

  it('Job-Lifecycle: GET /api/ai/jobs + 404 für unbekannte Job-ID', async () => {
    const res = await fetch(`${baseUrl}/api/ai/jobs`);
    expect(res.status).toBe(200);
    const body = await res.json() as { jobs?: unknown[] };
    expect(Array.isArray(body.jobs)).toBe(true);

    const miss = await fetch(`${baseUrl}/api/ai/jobs/gibtsnicht`);
    expect(miss.status).toBe(404);
  });

  it('Session-Heartbeat aktualisiert die AI-Session', async () => {
    const res = await fetch(`${baseUrl}/api/ai/session/heartbeat`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json() as { sessionId?: string };
    expect(typeof body.sessionId).toBe('string');
  });

  it('POST /api/library/search liefert Ergebnisse mit Score (lokaler Fallback)', async () => {
    const ok = await fetch(`${baseUrl}/api/library/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'kick', limit: 5 }),
    });
    expect(ok.status).toBe(200);
    const body = await ok.json() as { results?: Array<{ id: string; name: string; score: number }> };
    expect(Array.isArray(body.results)).toBe(true);
    expect(body.results!.length).toBeGreaterThan(0);
    expect(body.results![0].score).toBeGreaterThan(0);

    const empty = await fetch(`${baseUrl}/api/library/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(empty.status).toBe(400);
  });
});
