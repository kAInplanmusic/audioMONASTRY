/**
 * FIX F3 · /api/master-Routen über HTTP (echter Express-Stack, gemockter Dienst)
 * =============================================================================
 * Befund: `POST /api/master/mix` mit 2 Spuren à 1 s 48-kHz-Stereo-WAV endete mit
 * HTTP 400 „Payload zu gross (max 256 kB)" - der Audio-Weg erbte die 256-kB-Hülle.
 * Diese Suite fährt den echten Server hoch, hängt den master-player an einen
 * lokalen HTTP-Mock (keine Netzzugriffe, keine AI) und belegt:
 *
 *   * der gemeldete Fall läuft jetzt durch (und 4 × 30 s ebenfalls),
 *   * zu viele Spuren / zu lange Spuren -> 400 mit Zahlen,
 *   * über 64 MB -> 413 mit Zahlen (ohne den Body zu puffern),
 *   * andere Routen behalten ihre strengeren Grenzen,
 *   * in Logs und Antworten landen keine Audio-Inhalte.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { MASTER_PAYLOAD_LIMITS, formatBytesDe } from '../src/types/masterPayload';
import { installMasterBodyParser, registerMasterRoutes } from '../server/routes/masterRoutes';
import { wavBase64 } from './fixtures/masterAudio';

let appServer: Server;
let mockServer: Server;
let tinyServer: Server;
let baseUrl = '';
let tinyUrl = '';
let mockUrl = '';

interface MockCall { path: string; bytes: number; tracks: number }
const calls: MockCall[] = [];

const json = (res: http.ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const listen = (server: Server): Promise<string> =>
  new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });

/** POST /api/master/mix mit dem echten Body (Variante mit und ohne Spurzahl-Angabe). */
async function postMix(payload: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  return postJson(`${baseUrl}/api/master/mix`, JSON.stringify(payload));
}

async function postJson(url: string, body: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  return { status: resp.status, body: (await resp.json()) as Record<string, unknown> };
}

/**
 * Anfrage mit einer Content-Length-Ankündigung über der Grenze. Der Server muss
 * schon nach dem Kopf entscheiden - der Body wird bewusst NICHT gesendet, damit
 * der Test keine 70 MB durch den Speicher schaufelt (und genau das belegt:
 * abgewiesen wird, bevor gepuffert wird).
 */
function postWithDeclaredLength(url: string, declaredBytes: number): Promise<{ status: number; body: string }> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('keine Antwort auf die Vorprüfung')), 5_000);
    let settled = false;
    const finish = (value: { status: number; body: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const req = http.request(
      {
        host: target.hostname,
        port: target.port,
        path: target.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': declaredBytes },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => finish({ status: res.statusCode ?? 0, body }));
      },
    );
    // Nach dem Kopf darf die Verbindung aufgeräumt werden - die Antwort steht dann schon.
    req.on('error', () => { if (!settled) reject(new Error('Verbindung ohne Antwort beendet')); });
    req.write('{"tracks":[]}');
  });
}

beforeAll(async () => {
  process.env.VITEST = 'true';
  delete process.env.STUDIO_ACCESS_TOKEN;
  process.env.API_RATE_LIMIT_MAX = '1000';
  process.env.API_EXPENSIVE_RATE_LIMIT_MAX = '1000';
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_SERVICE_ROLE = '';
  process.env.OLLAMA_URL = 'http://127.0.0.1:1';

  // Mock des master-player: zählt Anfragen, spiegelt Größe und Spurzahl zurück.
  mockServer = http.createServer((req, res) => {
    if (req.method === 'GET') {
      json(res, 200, { status: 'ok', service: 'master-player', version: '2.0.0' });
      return;
    }
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let tracks = 0;
      try {
        const parsed = JSON.parse(raw || '{}') as { tracks?: unknown[] };
        tracks = Array.isArray(parsed.tracks) ? parsed.tracks.length : 0;
      } catch {
        tracks = -1;
      }
      calls.push({ path: req.url ?? '', bytes: raw.length, tracks });
      json(res, 200, {
        status: 'ok',
        format: 'wav',
        data: Buffer.from('RIFF').toString('base64'),
        receivedBytes: raw.length,
        tracks,
      });
    });
  });
  mockUrl = await listen(mockServer);
  // Muss VOR dem Import von server.ts stehen: die Routen lesen die URL je Aufruf,
  // aber der Server liest beim Start Env (dotenv ist im Testlauf aus).
  process.env.MASTER_PLAYER_URL = mockUrl;

  const mod = await import('../server');
  appServer = mod.app.listen(0);
  baseUrl = await new Promise((resolve) => {
    appServer.on('listening', () => resolve(`http://127.0.0.1:${(appServer.address() as AddressInfo).port}`));
  });

  // Zweite, isolierte App mit SEHR kleinen Grenzen: belegt die Körpergrenze exakt
  // an ihrer Kante, ohne 64 MB durch den Testprozess zu schaufeln.
  const tinyLimits = { maxBytes: 4_096, maxTracks: 2, maxSecondsPerTrack: 1 };
  const tinyApp = express();
  installMasterBodyParser(tinyApp, tinyLimits);
  registerMasterRoutes(tinyApp, { getMasterPlayerUrl: () => mockUrl, limits: tinyLimits });
  tinyServer = tinyApp.listen(0);
  tinyUrl = await new Promise((resolve) => {
    tinyServer.on('listening', () => resolve(`http://127.0.0.1:${(tinyServer.address() as AddressInfo).port}`));
  });
});

afterAll(async () => {
  await Promise.all([appServer, mockServer, tinyServer].map(
    (server) => new Promise<void>((resolve) => server.close(() => resolve())),
  ));
});

describe('FIX F3 · /api/master über HTTP', () => {
  it('proxyt /api/master/health unverändert (Bestandsverhalten)', async () => {
    const resp = await fetch(`${baseUrl}/api/master/health`);
    expect(resp.status).toBe(200);
    const body = await resp.json() as Record<string, unknown>;
    expect(body.service).toBe('master-player');
  });

  it('nimmt den gemeldeten Fehlerfall an: 2 Spuren à 1 s 48-kHz-Stereo (> 256 kB)', async () => {
    const oneSecond = wavBase64({ sampleRate: 48_000, channels: 2, bits: 16, seconds: 1 });
    const payload = { tracks: [{ data: oneSecond, gain: -6, pan: -0.5 }, { data: oneSecond, gain: -6, pan: 0.5 }] };
    const body = JSON.stringify(payload);
    // Genau die Größe, an der die alte 256-kB-Hülle gescheitert ist.
    expect(body.length).toBeGreaterThan(262_144);

    const before = calls.length;
    const res = await postMix(payload);
    expect(res.status).toBe(200);
    expect(res.body.format).toBe('wav');
    // Der Dienst hat den Body unverändert und vollständig gesehen.
    expect(calls).toHaveLength(before + 1);
    expect(calls[before]).toMatchObject({ path: '/mix', tracks: 2, bytes: body.length });
  });

  it('nimmt 4 Spuren à 30 s an (realistische Dauer, weiter über der alten Hülle)', async () => {
    // 30 s Spielzeit bei kleiner Bitrate - geprüft werden byteRate + data-Größe.
    const track = (): string => wavBase64({ sampleRate: 1000, channels: 1, bits: 16, seconds: 30 });
    const payload = { tracks: [track(), track(), track(), track()] };
    const body = JSON.stringify(payload);
    expect(body.length).toBeGreaterThan(262_144);
    expect(body.length).toBeLessThan(MASTER_PAYLOAD_LIMITS.maxBytes);

    const before = calls.length;
    const res = await postMix(payload);
    expect(res.status).toBe(200);
    expect(calls[before]).toMatchObject({ tracks: 4, bytes: body.length });
  });

  it('lässt genau 120 s je Spur durch und weist 245 s mit Zahlen ab (400)', async () => {
    const onEdge = { tracks: [{ data: wavBase64({ sampleRate: 1000, channels: 1, bits: 16, seconds: 120 }) }] };
    expect((await postMix(onEdge)).status).toBe(200);

    const tooLong = { tracks: [{ data: wavBase64({ sampleRate: 1000, channels: 1, bits: 16, seconds: 245 }) }] };
    const res = await postMix(tooLong);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('track_too_long');
    expect(res.body.status).toBe('error');
    expect(String(res.body.message)).toContain('245 s, erlaubt 120 s pro Spur');
    expect(res.body.limits).toEqual(MASTER_PAYLOAD_LIMITS);
    expect(res.body.actual).toMatchObject({ tracks: 1, longestTrackSeconds: 245 });
    expect(String(res.body.message)).not.toContain('data');
  });

  it('weist 9 Spuren mit 400 und den Ist-/Soll-Zahlen ab (kein Aufruf des Dienstes)', async () => {
    const track = wavBase64({ sampleRate: 1000, channels: 1, bits: 16, seconds: 1 });
    const body = JSON.stringify({ tracks: new Array(9).fill({ data: track }) });
    const before = calls.length;
    const res = await postJson(`${baseUrl}/api/master/mix`, body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('too_many_tracks');
    expect(String(res.body.message))
      .toBe(`Zu viele Spuren: 9 Spuren, erlaubt 8; Gesamtgröße ${formatBytesDe(body.length)}, erlaubt 64 MB.`);
    expect(calls).toHaveLength(before);
  });

  it('weist über 64 MB mit 413 und Zahlen ab, bevor der Body gepuffert wird', async () => {
    const declared = 70 * 1024 * 1024;
    const res = await postWithDeclaredLength(`${baseUrl}/api/master/mix`, declared);
    expect(res.status).toBe(413);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body.status).toBe('error');
    expect(body.error).toBe('payload_too_large');
    expect(String(body.message)).toBe(`Payload zu gross: Gesamtgröße 70 MB, erlaubt 64 MB.`);
    expect((body.actual as Record<string, unknown>).bytes).toBe(declared);
    expect((body.actual as Record<string, unknown>).tracks).toBeNull();
  });

  it('prüft dieselben Grenzen auch für /master und /analyze', async () => {
    const tooLong = wavBase64({ sampleRate: 1000, channels: 1, bits: 16, seconds: 200 });
    for (const path of ['master', 'analyze']) {
      const res = await postJson(`${baseUrl}/api/master/${path}`, JSON.stringify({ data: tooLong }));
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('track_too_long');
      expect(String(res.body.message)).toContain('200 s, erlaubt 120 s pro Spur');
    }
  });

  it('hält die Grenze exakt an der Kante (injizierte 4-kB-Grenze, unter/über)', async () => {
    const under = JSON.stringify({ tracks: [{ data: 'x'.repeat(3_000) }] });
    expect(under.length).toBeLessThan(4_096);
    expect((await postJson(`${tinyUrl}/api/master/mix`, under)).status).toBe(200);

    const over = JSON.stringify({ tracks: [{ data: 'x'.repeat(6_000) }] });
    expect(over.length).toBeGreaterThan(4_096);
    const res = await postJson(`${tinyUrl}/api/master/mix`, over);
    expect(res.status).toBe(413);
    expect(res.body.error).toBe('payload_too_large');
    expect(String(res.body.message)).toContain('erlaubt 4 kB');
    expect((res.body.actual as Record<string, unknown>).bytes).toBe(over.length);
  });

  it('lässt andere Routen unangetastet (deren eigene Grenzen bleiben scharf)', async () => {
    // Der Master-Weg darf die Prüfungen ANDERER Routen nicht mitgeöffnet haben:
    // /api/ai/mcp/tools/:name deckelt seine Argumente weiter bei 20 kB.
    const res = await postJson(`${baseUrl}/api/ai/mcp/tools/session.getState`, JSON.stringify({ arg: 'x'.repeat(30_000) }));
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toContain('zu gross');
  });

  it('schreibt keine Audio-Inhalte in Logs oder Antworten', async () => {
    const marker = 'QUJD-F3-AUDIO-MARKER';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const tooMany = await postMix({ tracks: new Array(9).fill({ data: marker.repeat(100) }) });
      const tooLongRes = await postMix({
        tracks: [{ data: wavBase64({ sampleRate: 1000, channels: 1, bits: 16, seconds: 245 }) }],
        note: marker,
      });
      expect(tooMany.status).toBe(400);
      expect(tooLongRes.status).toBe(400);
      const logged = warn.mock.calls.map((args) => args.join(' ')).join('\n');
      // Die Abweisung wird protokolliert (nachvollziehbar) ...
      expect(logged).toContain('track_too_long');
      expect(logged).toContain(`maxBytes=${MASTER_PAYLOAD_LIMITS.maxBytes}`);
      // ... aber ohne jeden Nutzdaten-Anteil.
      expect(logged).not.toContain(marker);
      expect(JSON.stringify(tooMany.body)).not.toContain(marker);
      expect(JSON.stringify(tooLongRes.body)).not.toContain(marker);
    } finally {
      warn.mockRestore();
    }
  });
});
