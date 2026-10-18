/**
 * DA-2026-10-17-013 · Client-Modell-Override wird wirklich benutzt
 * ===============================================================
 * Der Befund: `model` wurde aus dem Body gelesen, per Regex geprueft und dann
 * verworfen - das effektive Modell kam ausschliesslich aus `process.env`.
 *
 * Entscheidung (im Code dokumentiert): DURCHREICHEN, aber gegen eine
 * serverseitige Allowlist. Diese Tests messen am echten `/infer`-Aufruf,
 * welches Modell ankommt - und dass ein fremdes Modell 400 ergibt.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

process.env.API_RATE_LIMIT_MAX = '10000';
process.env.API_EXPENSIVE_RATE_LIMIT_MAX = '10000';
process.env.STUDIO_ACCESS_TOKEN = '';
process.env.NODE_ENV = 'test';
delete process.env.RP_ENDPOINT_ID_VOICE;
delete process.env.RP_ENDPOINT_ID_MUSIC;

const runtimeCalls: { task: string; model: string }[] = [];
const runtime = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    try {
      const parsed = JSON.parse(body || '{}') as { task?: string; model?: string };
      runtimeCalls.push({ task: String(parsed.task ?? ''), model: String(parsed.model ?? '') });
    } catch { /* egal */ }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ result: { audioBase64: Buffer.alloc(44, 1).toString('base64'), sampleRate: 24000 } }));
  });
});

const { startServer } = await import('../server');
const { resolveVoiceRuntimeModel, allowedVoiceModels } = await import('../server/routes/voiceRoutes');

let baseUrl = '';
let httpServer: { close(cb: () => void): void } | null = null;

beforeAll(async () => {
  await new Promise<void>((resolve) => runtime.listen(0, '127.0.0.1', resolve));
  const port = (runtime.address() as AddressInfo).port;
  process.env.VOICE_AI_RUNTIME_URL = `http://127.0.0.1:${port}`;
  const started = await startServer(0);
  httpServer = started?.httpServer ?? null;
  const address = httpServer && (httpServer as unknown as { address(): AddressInfo | null }).address();
  baseUrl = `http://127.0.0.1:${address?.port ?? 0}`;
}, 60_000);

afterAll(() => {
  httpServer?.close(() => {});
  runtime.close();
  delete process.env.VOICE_AI_RUNTIME_URL;
  delete process.env.VOICE_AI_MODEL_ALLOWLIST;
  delete process.env.VOICE_AI_RUNTIME_TTS_MODEL;
});

async function post(path: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('DA-2026-10-17-013 · Modell-Override', () => {
  it('Loest den Override ohne Angabe auf das Env-/Konstanten-Modell auf', () => {
    const choice = resolveVoiceRuntimeModel('tts');
    expect(choice).toEqual({ model: 'qwen3-tts-06b', override: false });
  });

  it('lehnt ein Modell ausserhalb der Allowlist ab (kein Regex-Routing)', () => {
    expect(resolveVoiceRuntimeModel('tts', 'evil/model')).toBeNull();
    expect(resolveVoiceRuntimeModel('tts', 'qwen3-tts-17b')).toEqual({ model: 'qwen3-tts-17b', override: true });
    expect(allowedVoiceModels('tts')).toContain('qwen3-tts-17b');
  });

  it('schickt das vom Client gewaehlte Modell an die Runtime', async () => {
    runtimeCalls.length = 0;
    const res = await post('/api/voice/tts', { text: 'Hallo', model: 'qwen3-tts-17b' });
    expect(res.status).toBe(200);
    expect(runtimeCalls).toEqual([{ task: 'tts', model: 'qwen3-tts-17b' }]);
  }, 30_000);

  it('ohne Override bleibt es beim Default-Modell', async () => {
    runtimeCalls.length = 0;
    const res = await post('/api/voice/tts', { text: 'Hallo' });
    expect(res.status).toBe(200);
    expect(runtimeCalls[0]?.model).toBe('qwen3-tts-06b');
  }, 30_000);

  it('nutzt VOICE_AI_RUNTIME_TTS_MODEL als Default (Env gewinnt)', async () => {
    process.env.VOICE_AI_RUNTIME_TTS_MODEL = 'qwen3-tts-17b';
    try {
      runtimeCalls.length = 0;
      const res = await post('/api/voice/tts', { text: 'Hallo' });
      expect(res.status).toBe(200);
      expect(runtimeCalls[0]?.model).toBe('qwen3-tts-17b');
    } finally {
      delete process.env.VOICE_AI_RUNTIME_TTS_MODEL;
    }
  }, 30_000);

  it('erlaubt Zusatzmodelle nur per VOICE_AI_MODEL_ALLOWLIST', async () => {
    process.env.VOICE_AI_MODEL_ALLOWLIST = 'qwen3-tts-experimental';
    try {
      runtimeCalls.length = 0;
      const res = await post('/api/voice/tts', { text: 'Hallo', model: 'qwen3-tts-experimental' });
      expect(res.status).toBe(200);
      expect(runtimeCalls[0]?.model).toBe('qwen3-tts-experimental');
    } finally {
      delete process.env.VOICE_AI_MODEL_ALLOWLIST;
    }
  }, 30_000);

  it('unbekanntes Modell -> 400 MODEL_NOT_ALLOWED, ohne Runtime-Aufruf', async () => {
    runtimeCalls.length = 0;
    const res = await post('/api/voice/tts', { text: 'Hallo', model: 'nicht-erlaubt' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string; error?: string };
    expect(body.code).toBe('MODEL_NOT_ALLOWED');
    expect(runtimeCalls).toHaveLength(0);
  }, 30_000);

  it('gilt auch fuer /api/voice/song', async () => {
    runtimeCalls.length = 0;
    const res = await post('/api/voice/song', { prompt: 'dark techno', model: 'musicgen-medium', durationSeconds: 8 });
    expect(res.status).toBe(200);
    expect(runtimeCalls[0]).toMatchObject({ task: 'song', model: 'musicgen-medium' });
  }, 30_000);
});
