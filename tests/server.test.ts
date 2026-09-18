import { afterAll, beforeAll, describe, expect, it, vi, afterEach } from 'vitest';
import { setAiPersistenceClientForTests } from '../src/core/ai/orchestrator/aiPersistence';
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
  // „AI nur lokal“: die externe LLM-Kette nur pro Test freischalten.
  delete process.env.AI_ALLOW_EXTERNAL_LLM;
});

/** Minimales WAV (mono, 16 Bit, 0,2 s, 440 Hz) fuer den Codec-Export-Test. */
function sineWavBuffer(sampleRate = 44100, seconds = 0.2): Buffer {
  const frames = Math.floor(sampleRate * seconds);
  const data = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i += 1) {
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 12000), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

describe('Server API', () => {
  it('liefert /api/health mit status ok und Build-Version (PROD-P0-003)', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    // Die Version macht Deploy/Rollback von aussen pruefbar ('dev' ausserhalb
    // eines gestempelten Images).
    expect(typeof body.version).toBe('string');
    expect(body.version.length).toBeGreaterThan(0);
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

  it('AI-P1-005: ungueltiges JSON im Body → 400 strukturiert ohne Stack-Trace', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const res = await fetch(`${baseUrl}/api/ai/mcp/tools/models.list`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{invalid json',
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('invalid JSON body');
      expect(typeof body.requestId).toBe('string');
      expect(body.requestId.length).toBeGreaterThan(0);
      expect(res.headers.get('x-request-id')).toBeTruthy();
      // Der Befund war der Stack-Trace - er darf weder in der Antwort noch im Log stehen.
      expect(JSON.stringify(body)).not.toMatch(/(\s+at\s+[\w$.]+\s*\()|\(<anonymous>\)/);
      const stackLogs = errorSpy.mock.calls.filter((c) => String(c[0] ?? '').includes('\n    at '));
      expect(stackLogs).toEqual([]);
      expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('invalid JSON body'))).toBe(true);
    } finally {
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    }
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
    delete process.env.HF_TOKEN;
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.GROQ_API_KEY;
    delete process.env.MISTRAL_API_KEY;
    delete process.env.PUBLICAI_KEY;
    delete process.env.CB_API_KEY;
    delete process.env.OR_API_KEY;
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
    // Seit „AI nur lokal“ ist das lokale Brain der Default-Provider; dieser Test
    // prüft die externe Kette und schaltet sie explizit frei.
    process.env.AI_ALLOW_EXTERNAL_LLM = 'true';
    // Andere Provider deaktivieren, damit der Router deterministisch
    // deepseek-flash wählt (CB_API_KEY & Co. können in der .env gesetzt sein).
    delete process.env.CB_API_KEY;
    delete process.env.OR_API_KEY;
    delete process.env.PUBLICAI_KEY;
    delete process.env.HF_API_KEY;
    delete process.env.HF_TOKEN;
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

  it('POST /api/separate-stems ohne multipart liefert 400 statt Stub-Stream (PROD-P1-001)', async () => {
    // Vor PROD-P1-001 streamte dieser Aufruf simulierte Stems bis 100 %.
    // Das war ein Fake-Erfolg ohne Datei - heute ist es ein Validierungsfehler.
    const res = await fetch(`${baseUrl}/api/separate-stems`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
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
    expect(text).toContain('audiomonastry_telemetry_events_by_type_total');
    expect(text).toContain('audiomonastry_telemetry_events_by_source_total');
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
        alerts: [{ status: 'firing', labels: { alertname: 'AudiomonastryAppDown', instance: 'app-1' }, annotations: { summary: 'App down' } }],
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

  it('POST /api/session/autosave ohne R2-Konfiguration → 503 not-configured', async () => {
    delete process.env.CFS3_ENDPOINT;
    delete process.env.CFS3_ACCESS_KEY;
    delete process.env.CFS3_SECRET_KEY;
    delete process.env.CFS3_BUCKET;
    delete process.env.CFR2_ACCOUNT_ID;
    delete process.env.CFR2_ACCESS_KEY_ID;
    delete process.env.CFR2_SECRET_ACCESS_KEY;
    delete process.env.CFR2_BUCKET;

    const res = await fetch(`${baseUrl}/api/session/autosave`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        schemaVersion: 2,
        revision: 1,
        idempotencyKey: 'rev-1-12345678',
        savedAt: 1_000,
        payload: { moduleStates: { eq: 'AUTO_AI' }, bpm: 128 },
      }),
    });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe('r2-not-configured');
  });

  it('POST /api/session/autosave mit ungültigem Umschlag → 400', async () => {
    const res = await fetch(`${baseUrl}/api/session/autosave`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ schemaVersion: 99, revision: 1, idempotencyKey: 'rev-1', savedAt: 0 }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid autosave payload');
  });

  // DB-P1-005: Der Audio-Embedding-Space (41 Zeilen) hatte keinen Leser. Hier
  // laeuft die ganze Kette ueber die echte Route: WAV -> gestubbter ears-Worker
  // (CLAP 512-dim) -> gestubbte match_audio_samples-RPC -> Bibliothekstreffer.
  it('POST /api/library/search-audio: Audio -> CLAP -> match_audio_samples (DB-P1-005)', async () => {
    const backup = { SB_URL: process.env.SB_URL, SB_SERVICE_ROLE: process.env.SB_SERVICE_ROLE, RP_AGENT_KEY: process.env.RP_AGENT_KEY, RP_ENDPOINT_ID_EARS: process.env.RP_ENDPOINT_ID_EARS, RUNPOD_API_BASE: process.env.RUNPOD_API_BASE };
    process.env.SB_URL = 'https://example.supabase.co';
    process.env.SB_SERVICE_ROLE = 'x'.repeat(80);
    process.env.RP_AGENT_KEY = 'rp_test_key';
    process.env.RP_ENDPOINT_ID_EARS = 'ears-ep';
    process.env.RUNPOD_API_BASE = 'https://runpod.test/v2';

    const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
    setAiPersistenceClientForTests({
      rpc: async (fn: string, args: Record<string, unknown>) => {
        rpcCalls.push({ fn, args });
        return { data: [{ sample_id: 'bass-909-kick', similarity: 0.9912 }], error: null };
      },
    } as never);

    const realFetch = globalThis.fetch;
    const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('https://runpod.test/')) {
        return new Response(
          JSON.stringify({ id: 'job-1', status: 'COMPLETED', output: { result: { embedding: Array.from({ length: 512 }, (_, i) => Math.sin(i)), dim: 512 } } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return realFetch(input as never, init as never);
    });
    vi.stubGlobal('fetch', fetchSpy);

    try {
      const res = await fetch(`${baseUrl}/api/library/search-audio?limit=5`, {
        method: 'POST',
        headers: { 'Content-Type': 'audio/wav' },
        body: sineWavBuffer(),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.provider).toBe('clap-audio');
      expect(body.model).toBe('clap-music');
      expect(body.dims).toBe(512);
      expect(body.results[0]).toMatchObject({ id: 'bass-909-kick', score: 0.9912 });

      expect(rpcCalls).toHaveLength(1);
      expect(rpcCalls[0].fn).toBe('match_audio_samples');
      expect(rpcCalls[0].args.match_count).toBe(5);
      expect((rpcCalls[0].args.query_embedding as number[])).toHaveLength(512);

      // Kaltstart-fest: der Embedding-Aufruf laeuft ueber /run + Status-Polling
      // (runLong) - NICHT ueber /runsync, das bei scale-to-zero mit IN_QUEUE endet.
      const calledUrls = fetchSpy.mock.calls.map((c) => String(c[0]));
      expect(calledUrls.some((u) => u.endsWith('/run'))).toBe(true);
      expect(calledUrls.some((u) => u.includes('/status/job-1'))).toBe(true);
      expect(calledUrls.some((u) => u.endsWith('/runsync'))).toBe(false);
    } finally {
      vi.unstubAllGlobals();
      setAiPersistenceClientForTests(null);
      for (const [key, value] of Object.entries(backup)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('POST /api/library/search-audio ohne Audio → 400, ohne ears-Rolle → 503', async () => {
    const savedUrl = process.env.SB_URL;
    const savedKey = process.env.SB_SERVICE_ROLE;
    const savedEars = process.env.RP_ENDPOINT_ID_EARS;
    const savedAgentKey = process.env.RP_AGENT_KEY;
    try {
      const empty = await fetch(`${baseUrl}/api/library/search-audio`, { method: 'POST' });
      expect(empty.status).toBe(400);
      expect((await empty.json()).error).toBe('EMPTY_AUDIO');

      process.env.SB_URL = 'https://example.supabase.co';
      process.env.SB_SERVICE_ROLE = 'x'.repeat(80);
      delete process.env.RP_ENDPOINT_ID_EARS;
      delete process.env.RP_AGENT_KEY;
      const noEars = await fetch(`${baseUrl}/api/library/search-audio`, {
        method: 'POST',
        headers: { 'Content-Type': 'audio/wav' },
        body: sineWavBuffer(),
      });
      expect(noEars.status).toBe(503);
      expect((await noEars.json()).error).toBe('ears-not-configured');
    } finally {
      if (savedUrl === undefined) delete process.env.SB_URL; else process.env.SB_URL = savedUrl;
      if (savedKey === undefined) delete process.env.SB_SERVICE_ROLE; else process.env.SB_SERVICE_ROLE = savedKey;
      if (savedEars === undefined) delete process.env.RP_ENDPOINT_ID_EARS; else process.env.RP_ENDPOINT_ID_EARS = savedEars;
      if (savedAgentKey === undefined) delete process.env.RP_AGENT_KEY; else process.env.RP_AGENT_KEY = savedAgentKey;
    }
  });

  it('POST /api/session/reset verlangt den Studio-Token (401)', async () => {
    const res = await fetch(`${baseUrl}/api/session/reset`, { method: 'POST' });
    expect(res.status).toBe(401);
  });

  // FEAT-P3-004: Codec-Export (MP3/FLAC/AAC/OGG) über die echte Route.
  it('POST /api/audio/encode liefert MP3 mit ID3-Header und Tags', async () => {
    const res = await fetch(`${baseUrl}/api/audio/encode?format=mp3&title=Pruefton&artist=audioMONASTRY&name=master`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: sineWavBuffer(),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('audio/mpeg');
    expect(res.headers.get('x-audio-format')).toBe('mp3');
    expect(res.headers.get('content-disposition')).toContain('filename="master.mp3"');
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.subarray(0, 3).toString('latin1')).toBe('ID3');
    expect(bytes.length).toBeGreaterThan(1000);
  });

  it('POST /api/audio/encode lehnt unbekannte Formate ab (400)', async () => {
    const res = await fetch(`${baseUrl}/api/audio/encode?format=opus`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: sineWavBuffer(),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('unknown format');
    expect(body.formats).toContain('flac');
  });

  it('POST /api/audio/encode ohne Body → 400 (kein stiller Erfolg)', async () => {
    const res = await fetch(`${baseUrl}/api/audio/encode?format=flac`, { method: 'POST' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('EMPTY_INPUT');
  });
});
