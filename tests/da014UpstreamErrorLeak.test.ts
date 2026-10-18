/**
 * DA-2026-10-17-014 · Keine Upstream-Bodies an den Client
 * ======================================================
 * Der Befund: `detail` war der (gekuerzte) Body des internen AI-Runtimes -
 * Stacktraces, interne Hostnamen, Pfade und Modellangaben landeten im Browser.
 *
 * Geprueft am echten Aufruf: ein Stub antwortet mit 500 und einem klar
 * erkennbaren Geheimnis. Die Antwort darf es NICHT enthalten, das Server-Log
 * schon; der Client bekommt Meldung + Code + Correlation-ID.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

process.env.API_RATE_LIMIT_MAX = '10000';
process.env.API_EXPENSIVE_RATE_LIMIT_MAX = '10000';
process.env.STUDIO_ACCESS_TOKEN = '';
process.env.NODE_ENV = 'test';
delete process.env.RP_ENDPOINT_ID_VOICE;

const INTERNAL_SECRET = 'INTERNAL-DB-PASSWORD=hunter2 host=prod-db.internal:5432';
let mode: 'http500' | 'no-audio' = 'http500';

const runtime = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    if (mode === 'no-audio') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ result: { sampleRate: 24000 } }));
    }
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    return res.end(`Traceback (most recent call last): ${INTERNAL_SECRET}`);
  });
});

const { startServer } = await import('../server');

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
});

describe('DA-2026-10-17-014 · Upstream-Fehler leaken nicht', () => {
  it('500 der Runtime: generische Meldung, kein Body im JSON', async () => {
    mode = 'http500';
    const logged: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => String(a)).join(' '));
    });
    try {
      const res = await fetch(`${baseUrl}/api/voice/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Hallo' }),
      });
      const raw = await res.text();
      expect(res.status).toBe(502);
      expect(raw).not.toContain('hunter2');
      expect(raw).not.toContain('prod-db.internal');
      expect(raw).not.toContain('Traceback');

      const body = JSON.parse(raw) as { error?: string; code?: string; correlationId?: string; detail?: string };
      expect(body.error).toBe('tts fehlgeschlagen');
      expect(body.code).toBe('UPSTREAM_HTTP');
      expect(body.detail).toBeUndefined();
      expect(body.correlationId).toMatch(/^ai-/);

      // Das Detail steht im Server-Log (Nachvollziehbarkeit bleibt).
      expect(logged.join('\n')).toContain('hunter2');
      // Dieselbe Correlation-ID im Log wie in der Antwort.
      expect(logged.join('\n')).toContain(String(body.correlationId));
    } finally {
      spy.mockRestore();
    }
  }, 30_000);

  it('Antwort ohne audioBase64: generisch statt Runtime-Interna', async () => {
    mode = 'no-audio';
    const res = await fetch(`${baseUrl}/api/voice/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Hallo' }),
    });
    const raw = await res.text();
    expect(res.status).toBe(502);
    expect(raw).not.toContain('audioBase64');
    const body = JSON.parse(raw) as { error?: string; code?: string; detail?: string };
    expect(body.error).toBe('tts fehlgeschlagen');
    expect(body.code).toBe('NO_AUDIO');
    expect(body.detail).toBeUndefined();
  }, 30_000);
});
