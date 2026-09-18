/**
 * VOICE-P1-001 · Was die Sprach-Flotte wirklich zu lesen bekommt
 * =====================================================================
 * Der Punkt ist nicht "es gibt eine Funktion", sondern: der Text, der an die
 * Runtime (Qwen3-TTS) bzw. an den HF-Fallback geht, ist normalisiert. Genau das
 * wird hier gegen die ECHTE Route gemessen - mit einem Stub, der den
 * `/infer`-Aufruf mitschreibt (so wie es das lokale Runtime-Image tut).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

process.env.API_RATE_LIMIT_MAX = '10000';
process.env.API_EXPENSIVE_RATE_LIMIT_MAX = '10000';
process.env.STUDIO_ACCESS_TOKEN = '';
process.env.NODE_ENV = 'test';

/** Stub der AI-Runtime: schreibt mit, welcher Text ankommt, und liefert WAV. */
const runtimeCalls: { task: string; model: string; input: Record<string, unknown> }[] = [];
const runtime = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    try {
      const parsed = JSON.parse(body || '{}');
      runtimeCalls.push({ task: parsed.task, model: parsed.model, input: parsed.input });
    } catch { /* egal */ }
    const audio = Buffer.alloc(44, 1); // winziger WAV-Platzhalter
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ result: { audioBase64: audio.toString('base64'), sampleRate: 24000 } }));
  });
});

const { startServer } = await import('../server');

let baseUrl = '';
let httpServer: { close(cb: () => void): void } | null = null;

beforeAll(async () => {
  await new Promise<void>((resolve) => runtime.listen(0, '127.0.0.1', resolve));
  const runtimePort = (runtime.address() as AddressInfo).port;
  process.env.VOICE_AI_RUNTIME_URL = `http://127.0.0.1:${runtimePort}`;

  const started = await startServer(0);
  httpServer = started?.httpServer ?? null;
  const address = httpServer && (httpServer as http.Server).address() as AddressInfo | null;
  baseUrl = `http://127.0.0.1:${address?.port ?? 0}`;
}, 60_000);

afterAll(() => {
  httpServer?.close(() => {});
  runtime.close();
});

describe('VOICE-P1-001 · Normalisierung in der Sprach-Kette', () => {
  it('schickt der TTS-Runtime ausgeschriebenen Text (Ziffern, Betrag, Abkuerzung)', async () => {
    runtimeCalls.length = 0;
    const res = await fetch(`${baseUrl}/api/voice/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Am 17.09.2026 um 14:30 kostet es 19,99 €, z.B. für 3,5 kg.' }),
    });

    expect(res.status).toBe(200);
    expect(runtimeCalls).toHaveLength(1);
    const spoken = String(runtimeCalls[0].input.text);
    expect(spoken).toContain('siebzehnte September zweitausendsechsundzwanzig');
    expect(spoken).toContain('vierzehn Uhr dreißig');
    expect(spoken).toContain('neunzehn Komma neun neun Euro');
    expect(spoken).toContain('zum Beispiel');
    expect(spoken).toContain('drei Komma fünf Kilogramm');
    // Nichts Rohes darf mehr durchkommen.
    expect(spoken).not.toMatch(/\d,\d\d €/);
    // Der gesprochene Text steht nachvollziehbar im Antwort-Header.
    expect(decodeURIComponent(res.headers.get('x-voice-speech-text') ?? '')).toContain('neunzehn');
  }, 30_000);

  it('laesst technische Angaben unangetastet (kein Vorlesen von Ports)', async () => {
    runtimeCalls.length = 0;
    await fetch(`${baseUrl}/api/voice/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Port 8080, Version 1.210.001, MP3' }),
    });
    const spoken = String(runtimeCalls[0].input.text);
    expect(spoken).toContain('8080');
    expect(spoken).toContain('1.210.001');
    expect(spoken).toContain('M P drei');
  }, 30_000);

  it('normalisiert auch den Singtext', async () => {
    runtimeCalls.length = 0;
    await fetch(`${baseUrl}/api/voice/sing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '7 Spuren, 3x lauter' }),
    });
    const spoken = String(runtimeCalls[0]?.input?.text ?? '');
    expect(spoken).toContain('sieben Spuren');
    expect(spoken).toContain('dreimal lauter');
  }, 30_000);

  it('liefert bei /api/generate-voice den normalisierten Text fuer Web-Speech mit', async () => {
    const res = await fetch(`${baseUrl}/api/generate-voice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Test um 14:30 mit 12 %' }),
    });
    const body = await res.json();
    expect(body.status).toBe('local');
    expect(body.text).toBe('Test um 14:30 mit 12 %'); // Original bleibt erhalten
    expect(body.speechText).toContain('vierzehn Uhr dreißig');
    expect(body.speechText).toContain('zwölf Prozent');
  }, 30_000);
});
