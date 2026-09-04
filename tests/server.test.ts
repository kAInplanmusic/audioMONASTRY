import { afterAll, beforeAll, describe, expect, it, vi, afterEach } from 'vitest';
import type { Server } from 'node:http';

let server: Server;
let baseUrl = '';

beforeAll(async () => {
  process.env.VITEST = 'true';
  // Test-Baseline: HF-Voice + stem-ai-Proxy statt Replicate (die echte .env
  // kann Replicate aktiviert haben; dotenv überschreibt bestehende Env nicht).
  process.env.VOICE_PROVIDER = 'hf';
  process.env.STEM_AI_PROVIDER = '';
  delete process.env.REPLICATE_API_TOKEN;
  // Test-Baseline: keine Studio-Token-Pflicht + hohes Test-Rate-Limit.
  delete process.env.STUDIO_ACCESS_TOKEN;
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Server API', () => {
  it('liefert /api/health mit status ok', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
  });

  it('liefert /api/cloud/health ohne Konfiguration als not-configured', async () => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE;
    delete process.env.SUPABASE_ANON_PUB;
    delete process.env.SUPABASE_PUBLISHABLE;
    delete process.env.CFR2_ACCOUNT_ID;
    delete process.env.CFR2_ACCESS_KEY_ID;
    delete process.env.CFR2_SECRET_ACCESS_KEY;
    delete process.env.CFR2_BUCKET;

    const res = await fetch(`${baseUrl}/api/cloud/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.supabase).toBe('not-configured');
    expect(body.r2.status).toBe('not-configured');
  });

  it('POST /api/ai/complete ohne prompt → 400', async () => {
    const res = await fetch(`${baseUrl}/api/ai/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('POST /api/ai/complete ohne Keys → 502 mit Fehlerdetails', async () => {
    delete process.env.HF_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.GROQ_API_KEY;
    delete process.env.MISTRAL_API_KEY;
    delete process.env.OLLAMA_URL;
    delete process.env.OLLAMA_MODEL;
    delete process.env.GEMINI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const res = await fetch(`${baseUrl}/api/ai/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'Hallo', complexity: 'simple' }),
    });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe('ai complete fehlgeschlagen');
  });

  it('POST /api/voice/tts ohne text → 400', async () => {
    const res = await fetch(`${baseUrl}/api/voice/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('POST /api/voice/tts mit ungültigem Modell → 400', async () => {
    const res = await fetch(`${baseUrl}/api/voice/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Hallo', model: '!! ungültig !!' }),
    });
    expect(res.status).toBe(400);
  });

  it('POST /api/voice/tts ohne HF_API_KEY → 502', async () => {
    delete process.env.HF_API_KEY;
    delete process.env.GROQ_API_KEY;
    const res = await fetch(`${baseUrl}/api/voice/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Hallo' }),
    });
    expect(res.status).toBe(502);
  });

  it('POST /api/voice/tts ohne HF_API_KEY → 502 (kein Groq-Fallback mehr)', async () => {
    delete process.env.HF_API_KEY;
    delete process.env.GROQ_API_KEY;
    const res = await fetch(`${baseUrl}/api/voice/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Hallo' }),
    });
    expect(res.status).toBe(502);
  });

  it('POST /api/voice/sing ohne text → 400', async () => {
    const res = await fetch(`${baseUrl}/api/voice/sing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('POST /api/voice/song ohne prompt → 400', async () => {
    const res = await fetch(`${baseUrl}/api/voice/song`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('POST /api/voice/song ohne HF_API_KEY → 502', async () => {
    delete process.env.HF_API_KEY;
    const res = await fetch(`${baseUrl}/api/voice/song`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'Dark techno' }),
    });
    expect(res.status).toBe(502);
  });

  it('POST /api/voice/tts mit gemocktem HF-Fetch → 200 Audio', async () => {
    const realFetch = globalThis.fetch.bind(globalThis);
    process.env.HF_API_KEY = 'test-key';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(44), {
      status: 200,
      headers: { 'content-type': 'audio/wav' },
    })));
    const res = await realFetch(`${baseUrl}/api/voice/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Hallo' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/wav');
  });

  it('POST /api/voice/song mit gemocktem HF-Fetch → 200 Audio', async () => {
    const realFetch = globalThis.fetch.bind(globalThis);
    process.env.HF_API_KEY = 'test-key';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(44), {
      status: 200,
      headers: { 'content-type': 'audio/wav' },
    })));
    const res = await realFetch(`${baseUrl}/api/voice/song`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'Dark techno', style: 'dark', bpm: 128, durationSeconds: 8 }),
    });
    expect(res.status).toBe(200);
  });

  it('POST /api/voice/sing mit gemocktem HF-Fetch → 200 Audio', async () => {
    const realFetch = globalThis.fetch.bind(globalThis);
    process.env.HF_API_KEY = 'test-key';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(44), {
      status: 200,
      headers: { 'content-type': 'audio/wav' },
    })));
    const res = await realFetch(`${baseUrl}/api/voice/sing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Hallo' }),
    });
    expect(res.status).toBe(200);
  });

  it('POST /api/ai/complete mit gemocktem DeepSeek-Fetch → 200 + Provider', async () => {
    const realFetch = globalThis.fetch.bind(globalThis);
    process.env.DEEPSEEK_API_KEY = 'test-key';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ choices: [{ message: { content: 'Hallo aus DeepSeek' } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )));
    const res = await realFetch(`${baseUrl}/api/ai/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'Hi', complexity: 'moderate' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.provider).toBe('deepseek-flash');
    expect(body.text).toBe('Hallo aus DeepSeek');
  });

  it('POST /api/upload/sample ohne multipart → 415', async () => {
    const res = await fetch(`${baseUrl}/api/upload/sample`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(415);
  });

  it('POST /api/upload/sample mit ungültigem Dateiformat → 415', async () => {
    const fd = new FormData();
    fd.append('file', new Blob(['kein audio'], { type: 'text/plain' }), 'test.txt');
    const res = await fetch(`${baseUrl}/api/upload/sample`, { method: 'POST', body: fd });
    expect(res.status).toBe(415);
  });

  it('POST /api/separate-stems (Fallback) liefert SSE mit progress + success', async () => {
    const res = await fetch(`${baseUrl}/api/separate-stems`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    expect(text).toContain('progress');
    expect(text).toContain('success');
  });

  it('POST /api/separate-stems (Failure-Injection: stem-ai nicht erreichbar) → 502', async () => {
    const realFetch = globalThis.fetch.bind(globalThis);
    process.env.ENABLE_STEMS = '1';
    process.env.STEM_AI_URL = 'http://127.0.0.1:9';
    // fetch des stem-ai-Proxys schlägt fehl (Verbindung abgelehnt) → 502.
    const fd = new FormData();
    fd.append('file', new Blob(['audio'], { type: 'audio/wav' }), 'test.wav');
    const res = await realFetch(`${baseUrl}/api/separate-stems`, { method: 'POST', body: fd });
    expect(res.status).toBe(502);
    delete process.env.ENABLE_STEMS;
    delete process.env.STEM_AI_URL;
  });

  it('GET /api/metrics liefert Metriken ohne Secrets', async () => {
    const res = await fetch(`${baseUrl}/api/metrics`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.uptimeSec).toBeGreaterThanOrEqual(0);
    expect(body.requests).toBeGreaterThanOrEqual(0);
    expect(body.ai).toBeTruthy();
    expect(body.stem).toBeTruthy();
  });

  it('GET /api/audit liefert Audit-Log ohne Secrets (P4-2)', async () => {
    const res = await fetch(`${baseUrl}/api/audit`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.entries)).toBe(true);
    expect(body.total).toBeGreaterThanOrEqual(0);
  });

  it('POST /api/cloud/upload (binär) ohne Key → 400', async () => {
    const res = await fetch(`${baseUrl}/api/cloud/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(4),
    });
    expect(res.status).toBe(400);
  });

  it('POST /api/cloud/upload (binär) mit Path-Traversal-Key → 400', async () => {
    const res = await fetch(`${baseUrl}/api/cloud/upload?key=../evil.wav`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(4),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(String(body.error)).toContain('invalid key');
  });

  it('POST /api/telemetry zählt Events nach type/source', async () => {
    const res = await fetch(`${baseUrl}/api/telemetry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        events: [
          { type: 'dropout', source: 'analyzer', message: 'underflow' },
          { type: 'dropout', source: 'mastering', message: 'underflow' },
          { type: 'error', source: 'analyzer', message: 'boom' },
        ],
      }),
    });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.accepted).toBe(3);

    const metricsRes = await fetch(`${baseUrl}/api/metrics`);
    const metrics = await metricsRes.json();
    expect(metrics.telemetryByType.dropout).toBeGreaterThanOrEqual(2);
    expect(metrics.telemetryByType.error).toBeGreaterThanOrEqual(1);
    expect(metrics.telemetryBySource.analyzer).toBeGreaterThanOrEqual(2);
  });

  it('GET /api/metrics?format=prometheus liefert Telemetrie-Breakdown-Labels', async () => {
    const res = await fetch(`${baseUrl}/api/metrics?format=prometheus`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('samplemonk_telemetry_events_by_type_total');
    expect(text).toContain('samplemonk_telemetry_events_by_source_total');
    expect(text).toContain('type="dropout"');
  });

  it('POST /api/alerts/webhook ohne konfigurierte Webhooks → 202, keine Side-Effects', async () => {
    delete process.env.DISCORD_WEBHOOK;
    delete process.env.SLACK_WEBHOOK;
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;

    const res = await fetch(`${baseUrl}/api/alerts/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        alerts: [{ status: 'firing', labels: { alertname: 'SamplemonkAppDown', instance: 'app-1' }, annotations: { summary: 'App down' } }],
      }),
    });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.received).toBe(1);
    expect(body.targets).toEqual([]);
    expect(body.forwarded).toBe(0);
  });

  it('POST /api/alerts/webhook leitet an Discord-Webhook weiter', async () => {
    const realFetch = globalThis.fetch.bind(globalThis);
    process.env.DISCORD_WEBHOOK = 'https://discord.example/webhook';
    const mockFetch = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', mockFetch);

    const res = await realFetch(`${baseUrl}/api/alerts/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        alerts: [{ status: 'firing', labels: { alertname: 'NodeHighCpu', instance: 'edge-1' }, annotations: { summary: 'CPU hoch' } }],
      }),
    });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.targets).toContain('discord');
    expect(body.forwarded).toBe(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://discord.example/webhook');
    expect(JSON.parse(String(init.body)).content).toContain('CPU hoch');
    delete process.env.DISCORD_WEBHOOK;
  });
});
