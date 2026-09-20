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
    if (req.url?.includes('/runsync')) {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        try {
          const body = JSON.parse(raw) as { input?: { task?: string } };
          const task = body.input?.task ?? '';
          if (task === 'audio.transcribe') return json(res, 200, { status: 'COMPLETED', output: { text: 'test transcription' } });
          if (task === 'audio.embed') return json(res, 200, { status: 'COMPLETED', output: { embedding: [0.1, 0.2], dim: 2 } });
          if (task === 'audio.generate') return json(res, 200, { status: 'COMPLETED', output: { audioBase64: 'UklGRg==', sampleRate: 32000 } });
          return json(res, 200, { status: 'COMPLETED', output: { labels: ['Music'], scores: [0.9] } });
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
  process.env.RUNPOD_API_BASE = hfBase;
  process.env.RUNPOD_ENDPOINT_ID_EARS = 'ears-ep';
  process.env.RUNPOD_ENDPOINT_ID_VOICE = 'voice-ep';
  process.env.RUNPOD_ENDPOINT_ID_BRAIN = 'brain-ep';
  process.env.RUNPOD_API_KEY = 'test-key';
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

  it('POST /api/ai/orchestrate führt audio.transcribe über die RunPod-Rolle ears aus', async () => {
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

  it('POST /api/ai/voice/mos validiert Hörerwertungen (400 statt 500)', async () => {
    const bad = await fetch(`${baseUrl}/api/ai/voice/mos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelId: 'mms-tts-deu', language: 'DE', score: 9, evaluatorId: 'u1' }),
    });
    expect(bad.status).toBe(400);
  });

  it('POST /api/ai/voice/mos nimmt eine gültige Wertung an (201)', async () => {
    const ok = await fetch(`${baseUrl}/api/ai/voice/mos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelId: 'mms-tts-deu', language: 'DE', score: 5, evaluatorId: 'u1' }),
    });
    expect(ok.status).toBe(201);
    const body = await ok.json() as { summary?: { count?: number; evaluators?: number } };
    expect(body.summary?.count).toBeGreaterThanOrEqual(1);
    // Das Gate zaehlt Hoerer, nicht Wertungen - das Feld muss auf der Leitung liegen.
    expect(body.summary?.evaluators).toBeGreaterThanOrEqual(1);
  });

  it('INFRA-AI-007: MOS-Gate wechselt das TTS-Modell, wenn das angeforderte durchgefallen ist', async () => {
    // Drei VERSCHIEDENE Hörer, Score 1 → `qwen3-tts-17b` fällt durch das Gate.
    for (const hearer of ['h1', 'h2', 'h3']) {
      const rated = await fetch(`${baseUrl}/api/ai/voice/mos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId: 'qwen3-tts-17b', language: 'DE', score: 1, evaluatorId: hearer }),
      });
      expect(rated.status).toBe(201);
    }

    const res = await fetch(`${baseUrl}/api/ai/orchestrate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'u1', task: 'tts', model: 'qwen3-tts-17b', input: { text: 'Hallo' } }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as {
      mosGate?: { model?: string; requested?: string; switched?: boolean; status?: string };
      job?: { status?: string; model?: string };
    };
    expect(body.mosGate?.requested).toBe('qwen3-tts-17b');
    expect(body.mosGate?.switched).toBe(true);
    expect(body.mosGate?.model).toBe('qwen3-tts-voicedesign');
    // Das durchgefallene Modell darf auch im Job nicht auftauchen.
    expect(body.job?.model).toBe('qwen3-tts-voicedesign');
  });

  it('INFRA-AI-007: MOS-Gate lehnt ab (409), wenn alle TTS-Modelle durchgefallen sind', async () => {
    for (const modelId of ['qwen3-tts-17b', 'qwen3-tts-voicedesign']) {
      for (const hearer of ['h1', 'h2', 'h3']) {
        await fetch(`${baseUrl}/api/ai/voice/mos`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ modelId, language: 'DE', score: 2, evaluatorId: hearer }),
        });
      }
    }

    const res = await fetch(`${baseUrl}/api/ai/orchestrate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'u1', task: 'tts', model: 'qwen3-tts-17b', input: { text: 'Hallo' } }),
    });

    expect(res.status).toBe(409);
    const body = await res.json() as { code?: string; reason?: string; considered?: Array<{ status?: string }> };
    expect(body.code).toBe('MOS_GATE_BLOCKED');
    expect(body.reason).toMatch(/alle TTS-Modelle/);
    expect(body.considered?.every((entry) => entry.status === 'blocked')).toBe(true);
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

/**
 * INFRA-FEAT-001..003 über die ECHTE HTTP-Kante: Der Betriebsmodus ist die
 * Einstellung, die den GPU-Verkehr stoppt – hier gegen den laufenden Server
 * (RunPod-Basis zeigt im Test auf den lokalen Mock, es geht also nichts nach
 * draußen). Der Modus wird nach jedem Test auf den Ausgangswert zurückgesetzt,
 * damit die übrigen Routen-Tests unbeeinflusst bleiben.
 */
describe('AI-Betriebsmodus + Budget (INFRA-FEAT-001..003, HTTP)', () => {
  let originalMode = 'on-no-visuals';

  beforeAll(async () => {
    const res = await fetch(`${baseUrl}/api/ai/mode`);
    const body = await res.json() as { mode?: string };
    originalMode = body.mode ?? 'on-no-visuals';
  });

  afterAll(async () => {
    await fetch(`${baseUrl}/api/ai/mode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: originalMode, source: 'test-restore' }),
    });
  });

  it('GET /api/ai/mode liefert Modus, Rollen und Kostenrahmen', async () => {
    const res = await fetch(`${baseUrl}/api/ai/mode`);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      mode: string;
      aiEnabled: boolean;
      visualsEnabled: boolean;
      allowedRoles: string[];
      blockedRoles: string[];
      budget: {
        totalEurPerHour: number;
        hourly: { withinLimit: boolean };
        storage: { withinLimit: boolean };
      };
    };
    expect(['off', 'on-no-visuals', 'on-with-visuals']).toContain(body.mode);
    expect(body.allowedRoles.length + body.blockedRoles.length).toBe(8);
    expect(typeof body.budget.totalEurPerHour).toBe('number');
    expect(body.budget.hourly.withinLimit).toBe(true);
    expect(body.budget.storage.withinLimit).toBe(true);
  });

  it('POST /api/ai/mode weist unbekannte Modi ab (422)', async () => {
    const res = await fetch(`${baseUrl}/api/ai/mode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'halb-an' }),
    });
    expect(res.status).toBe(422);
  });

  it('POST /api/ai/fleet/wake verweigert bei „AI aus“ ohne Netzwerkaufruf (409)', async () => {
    await fetch(`${baseUrl}/api/ai/mode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'off', source: 'test' }),
    });

    const status = await (await fetch(`${baseUrl}/api/ai/fleet/status`)).json() as { aiEnabled: boolean; aiMode: string };
    expect(status.aiMode).toBe('off');
    expect(status.aiEnabled).toBe(false);

    const wake = await fetch(`${baseUrl}/api/ai/fleet/wake`, { method: 'POST' });
    expect(wake.status).toBe(409);
    const report = await wake.json() as { blocked: string | null; roles: Array<{ workersMinSet: boolean }> };
    expect(report.blocked).toBe('ai-off');
    expect(report.roles.every((r) => r.workersMinSet === false)).toBe(true);
  });

  it('POST /api/ai/fleet/wake verweigert Visual-Rollen im Modus „ohne Visuals“ (409)', async () => {
    await fetch(`${baseUrl}/api/ai/mode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'on-no-visuals', source: 'test' }),
    });

    const wake = await fetch(`${baseUrl}/api/ai/fleet/wake`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roles: ['imageHq'] }),
    });
    expect(wake.status).toBe(409);
    const report = await wake.json() as { blocked: string | null; reason?: string };
    expect(report.blocked).toBe('visuals-off');
    expect(report.reason).toMatch(/bild|visual|ImageHq|imageHq/i);

    // Unbekannte Rolle bleibt eine Validierungsfrage (422), kein 409.
    const bogus = await fetch(`${baseUrl}/api/ai/fleet/wake`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roles: ['nichtvorhanden'] }),
    });
    expect(bogus.status).toBe(422);
  });

  it('POST /api/ai/budget/check meldet eine Speicher-Überschreitung als 409', async () => {
    const ok = await fetch(`${baseUrl}/api/ai/budget/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(ok.status).toBe(200);
    expect((await ok.json() as { ok: boolean }).ok).toBe(true);

    const over = await fetch(`${baseUrl}/api/ai/budget/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ storageEurPerMonth: 99 }),
    });
    expect(over.status).toBe(409);
    const body = await over.json() as { ok: boolean; violations: string[] };
    expect(body.ok).toBe(false);
    expect(body.violations.join(' ')).toMatch(/€\/Monat/);
  });
});
