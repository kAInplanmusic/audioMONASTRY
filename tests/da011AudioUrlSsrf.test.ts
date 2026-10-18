/**
 * DA-2026-10-17-011 · SSRF ueber vom Backend gelieferte URLs
 * ==========================================================
 * Zwei Befunde, ein Modul:
 *   1. ACE-Step/DiffRhythm liefern in `query_result` eine `file`-URL, die der
 *      Server ungeprueft geladen hat (`http://169.254.169.254/...`).
 *   2. `/api/ai/vision/video` lud eine CLIENT-URL ungeprueft (`imageUrl`).
 *
 * Die Unit-Tests pruefen die Pruefstelle, der letzte Test die ECHTE Route gegen
 * einen lokalen ACE-Step-Stub, der eine Metadata-URL zurueckgibt.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  fetchOutboundBuffer,
  hostMatchesPattern,
  isPrivateOrLocalHost,
  OutboundUrlError,
  resolveSafeOutboundUrl,
} from '../src/core/ai/outboundUrl';

process.env.API_RATE_LIMIT_MAX = '10000';
process.env.API_EXPENSIVE_RATE_LIMIT_MAX = '10000';
process.env.STUDIO_ACCESS_TOKEN = '';
process.env.NODE_ENV = 'test';

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(OutboundUrlError);
    expect((error as OutboundUrlError).code).toBe(code);
    return;
  }
  throw new Error(`erwartet: OutboundUrlError ${code}`);
}

describe('DA-2026-10-17-011 · URL-Pruefung (Unit)', () => {
  const base = 'http://ace-step.internal.example:8001';

  it('erkennt private/loopback/link-local Ziele', () => {
    for (const host of [
      '127.0.0.1', '10.1.2.3', '172.16.0.9', '172.31.255.1', '192.168.1.1',
      '169.254.169.254', '100.64.0.1', '0.0.0.0', 'localhost', 'foo.local',
      'metadata.google.internal', '::1', 'fe80::1', 'fd00::1',
    ]) {
      expect(isPrivateOrLocalHost(host), host).toBe(true);
    }
    // Oeffentliche Adressen bleiben erlaubt.
    expect(isPrivateOrLocalHost('93.184.216.34')).toBe(false);
    expect(isPrivateOrLocalHost('ace-step.example.com')).toBe(false);
  });

  it('blockt IPv4-gemappte IPv6-Adressen', () => {
    expect(isPrivateOrLocalHost('[::ffff:127.0.0.1]')).toBe(true);
    expect(isPrivateOrLocalHost('[::ffff:7f00:1]')).toBe(true);
    expect(isPrivateOrLocalHost('[::ffff:8.8.8.8]')).toBe(false);
  });

  it('laesst relative Pfade des Backends zu, fremde Hosts nicht', () => {
    const url = resolveSafeOutboundUrl('/audio/task-1.wav', {
      baseUrl: base,
      allowedHosts: ['ace-step.internal.example'],
    });
    expect(url.toString()).toBe('http://ace-step.internal.example:8001/audio/task-1.wav');

    expectCode(
      () => resolveSafeOutboundUrl('https://fremd.example.com/x.wav', {
        baseUrl: base,
        allowedHosts: ['ace-step.internal.example'],
      }),
      'HOST_NOT_ALLOWED',
    );
  });

  it('blockt Metadata-/Loopback-Ziele und fremde Protokolle', () => {
    expectCode(() => resolveSafeOutboundUrl('http://169.254.169.254/latest/meta-data/', { baseUrl: base }), 'BLOCKED_HOST');
    expectCode(() => resolveSafeOutboundUrl('http://127.0.0.1:5432/', { baseUrl: base }), 'BLOCKED_HOST');
    expectCode(() => resolveSafeOutboundUrl('file:///etc/passwd', { baseUrl: base }), 'BLOCKED_PROTOCOL');
    expectCode(() => resolveSafeOutboundUrl('data:audio/wav;base64,AAAA', { baseUrl: base }), 'BLOCKED_PROTOCOL');
  });

  it('blockt Zugangsdaten in der URL', () => {
    expectCode(
      () => resolveSafeOutboundUrl('http://user:pass@ace-step.example.com/x.wav', { baseUrl: base }),
      'CREDENTIALS_IN_URL',
    );
  });

  it('vergleicht Host-Muster nur auf einer Wildcard-Ebene', () => {
    expect(hostMatchesPattern('pod.example.com', '*.example.com')).toBe(true);
    expect(hostMatchesPattern('a.pod.example.com', '*.example.com')).toBe(false);
    expect(hostMatchesPattern('example.com', '*.example.com')).toBe(false);
  });

  it('folgt KEINEM Redirect in ein privates Netz', async () => {
    const hop = (location: string) => async () => new Response(null, { status: 302, headers: { location } });
    await expect(
      fetchOutboundBuffer('http://ace-step.example.com/x.wav', {
        baseUrl: base,
        fetchImpl: hop('http://169.254.169.254/latest/meta-data/') as unknown as typeof fetch,
        allowedHosts: ['ace-step.example.com'],
      }),
    ).rejects.toMatchObject({ code: 'BLOCKED_HOST' });
  });

  it('bricht bei zu vielen Redirects ab', async () => {
    const loop = async () => new Response(null, { status: 302, headers: { location: '/immer-weiter.wav' } });
    await expect(
      fetchOutboundBuffer('http://ace-step.example.com/x.wav', {
        baseUrl: base,
        fetchImpl: loop as unknown as typeof fetch,
        maxRedirects: 2,
        allowedHosts: ['ace-step.example.com'],
      }),
    ).rejects.toMatchObject({ code: 'REDIRECT_LIMIT' });
  });

  it('verweigert zu grosse Antworten (Content-Length und Stream)', async () => {
    const declared = async () => new Response('x', {
      status: 200,
      headers: { 'content-length': String(100 * 1024 * 1024) },
    });
    await expect(
      fetchOutboundBuffer('http://ace-step.example.com/x.wav', {
        baseUrl: base,
        fetchImpl: declared as unknown as typeof fetch,
        maxBytes: 1024,
      }),
    ).rejects.toMatchObject({ code: 'TOO_LARGE' });

    const streaming = async () => new Response(Buffer.alloc(4096, 1), { status: 200 });
    await expect(
      fetchOutboundBuffer('http://ace-step.example.com/x.wav', {
        baseUrl: base,
        fetchImpl: streaming as unknown as typeof fetch,
        maxBytes: 1024,
      }),
    ).rejects.toMatchObject({ code: 'TOO_LARGE' });
  });
});

/* --------------------------------------------------------------------------
 * Route: ACE-Step-Stub liefert eine Metadata-URL als `file`
 * -------------------------------------------------------------------------- */
const aceCalls: string[] = [];
const aceStub = http.createServer((req, res) => {
  aceCalls.push(String(req.url));
  if (req.url === '/release_task') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ code: 200, data: { task_id: 't-1' } }));
  }
  if (req.url === '/query_result') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      data: [{ task_id: 't-1', status: 1, result: JSON.stringify([{ file: 'http://169.254.169.254/latest/meta-data/' }]) }],
    }));
  }
  if (req.url === '/audio.wav') {
    res.writeHead(200, { 'Content-Type': 'audio/wav' });
    return res.end(Buffer.alloc(44, 3));
  }
  res.writeHead(404);
  return res.end('nein');
});

const { startServer } = await import('../server');

let baseUrl = '';
let httpServer: { close(cb: () => void): void } | null = null;

beforeAll(async () => {
  await new Promise<void>((resolve) => aceStub.listen(0, '127.0.0.1', resolve));
  const acePort = (aceStub.address() as AddressInfo).port;
  process.env.SONG_AI_ACE_STEP_URL = `http://127.0.0.1:${acePort}`;
  const started = await startServer(0);
  httpServer = started?.httpServer ?? null;
  const address = httpServer && (httpServer as unknown as { address(): AddressInfo | null }).address();
  baseUrl = `http://127.0.0.1:${address?.port ?? 0}`;
}, 60_000);

afterAll(() => {
  httpServer?.close(() => {});
  aceStub.close();
  delete process.env.SONG_AI_ACE_STEP_URL;
});

describe('DA-2026-10-17-011 · Route /api/song/generate', () => {
  it('laedt eine vom Wrapper gelieferte Metadata-URL NICHT', async () => {
    const warnings: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map((a) => String(a)).join(' '));
    });
    try {
      const res = await fetch(`${baseUrl}/api/song/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'dunkler techno', durationSeconds: 8 }),
      });
      // Der Download wurde abgelehnt -> generischer Fehler, kein 200/kein Inhalt.
      expect(res.status).toBe(502);
      const body = (await res.json()) as { error?: string; code?: string; detail?: string };
      expect(body.detail).toBeUndefined();
      expect(String(body.error)).not.toMatch(/169\.254|meta-data/i);
      // Der Grund steht im SERVER-Log (BLOCKED_HOST = privates Ziel).
      expect(warnings.join('\n')).toMatch(/BLOCKED_HOST/);
      // Der Stub wurde nur fuer release/query benutzt, nie fuer die Fremd-URL.
      expect(aceCalls).toContain('/release_task');
      expect(aceCalls).toContain('/query_result');
    } finally {
      spy.mockRestore();
    }
  }, 30_000);

  it('blockt eine CLIENT-URL auf ein Metadata-Ziel in /api/ai/vision/video', async () => {
    const res = await fetch(`${baseUrl}/api/ai/vision/video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageUrl: 'http://169.254.169.254/latest/meta-data/' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string; code?: string };
    expect(body.code).toBe('BLOCKED_HOST');
    expect(String(body.error)).toBe('imageUrl nicht ladbar');
    expect(JSON.stringify(body)).not.toMatch(/169\.254|meta-data/i);
  }, 30_000);
});
