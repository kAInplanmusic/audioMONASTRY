/**
 * AUDIT-2026-10-30-P1-005 · JSON-Body-Grenzen und Reihenfolge
 * =============================================================================
 * Befund: `server.ts` montierte `express.json({ limit: '50mb' })` GLOBAL und
 * damit VOR der Auth-/Rate-Limit-Kette der `/api`-Routen. Ein anonymer Client
 * konnte also bis zu 50 MB JSON in den Parser schieben, bevor irgendetwas
 * geprueft hat, wer er ist (Speicher-/CPU-Kosten, DoS-Flaeche).
 *
 * Erwartung (diese Suite):
 *   1. Body-Parsing laeuft NACH Auth + Rate-Limit: ein anonymer POST mit
 *      kaputtem JSON endet 401 - heute antwortet der Parser vorher mit 400
 *      "invalid JSON body", was genau den Reihenfolge-Fehler belegt.
 *   2. Default-Grenze fuer /api ist klein (1 MB): ein 2-MB-Body auf einer
 *      normalen Route endet 413 mit strukturiertem Fehler.
 *   3. Die nachweislich grossen Routen behalten ihre grosse Grenze:
 *      /api/ai/vision/video (imageBase64 <= 20 MB) und
 *      /api/ai/vision/show/merge (10 Clips x 4 MB) kommen weiter durch.
 *   4. Der Master-Weg (/api/master/*) behaelt seine 64-MB-Grenze - und zwar
 *      erst NACH der Auth (anonym: 401, authentifiziert: 413 mit Zahlen).
 *   5. Body-Fehler bleiben strukturiert (JSON, kein Stack) - auch 413.
 *
 * Der Riesen-Body wird bewusst NICHT gesendet, sondern nur per Content-Length
 * angekuendigt: so belegt die Suite, dass keine 50 MB im Speicher landen,
 * ohne selbst 50 MB zu erzeugen.
 */
process.env.NODE_ENV ??= 'test';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import net from 'node:net';
import express from 'express';
import type { Server } from 'node:http';
import {
  API_JSON_LIMIT_DEFAULT,
  API_JSON_LIMIT_LARGE,
  LARGE_JSON_BODY_ROUTES,
  installApiBodyParsers,
} from '../server/apiBodyLimits.ts';

const TOKEN = 'body-limit-studio-token';
const AUTH = { 'x-studio-token': TOKEN };

let server: Server;
let port = 0;
let baseUrl = '';

/**
 * Roher POST mit angekuendigter, aber NICHT gesendeter Body-Groesse.
 * `timeoutMs` ist bewusst kurz: nach dem Fix antwortet die Auth sofort, ohne
 * den Body anzufordern. Ohne Fix haengt die Anfrage im Parser (er liest erst
 * den Stream) und laeuft in den Timeout.
 */
function postDeclaredLength(
  path: string,
  declaredBytes: number,
  headers: Record<string, string> = {},
  timeoutMs = 3_000,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let raw = '';
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      const [head] = raw.split('\r\n\r\n');
      const statusLine = head?.split('\r\n')[0] ?? '';
      const status = Number(statusLine.split(' ')[1] ?? 0);
      if (!status) {
        reject(new Error(`keine HTTP-Antwort erhalten: ${JSON.stringify(raw.slice(0, 200))}`));
        return;
      }
      resolve({ status, text: raw });
    };
    socket.setEncoding('utf8');
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      reject(new Error(`Timeout nach ${timeoutMs} ms: der Parser hat den Body angefordert, bevor Auth/Rate-Limit entschieden haben`));
    });
    socket.on('connect', () => {
      const extra = Object.entries(headers)
        .map(([name, value]) => `${name}: ${value}\r\n`)
        .join('');
      socket.write(
        `POST ${path} HTTP/1.1\r\n`
        + 'Host: 127.0.0.1\r\n'
        + 'Content-Type: application/json\r\n'
        + `Content-Length: ${declaredBytes}\r\n`
        + 'Connection: close\r\n'
        + extra
        + '\r\n',
      );
    });
    socket.on('data', (chunk) => { raw += chunk; });
    socket.on('end', finish);
    socket.on('close', finish);
    socket.on('error', (error) => {
      // Ein Reset NACH der Antwort ist erwartbar (Body blieb ungelesen).
      if (raw.includes('HTTP/1.1')) finish();
      else reject(error);
    });
  });
}

async function postJson(
  path: string,
  body: string,
  headers: Record<string, string> = AUTH,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body,
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeAll(async () => {
  process.env.VITEST = 'true';
  // Auth MUSS scharf sein - sonst laesst sich "401 vor dem Parser" nicht zeigen.
  process.env.STUDIO_ACCESS_TOKEN = TOKEN;
  // Rate-Limits hoch, damit diese Suite nicht in 429 laeuft.
  process.env.API_RATE_LIMIT_MAX = '10000';
  process.env.API_EXPENSIVE_RATE_LIMIT_MAX = '10000';
  process.env.UPLOAD_CHUNK_RATE_LIMIT_MAX = '10000';
  const mod = await import('../server');
  server = mod.app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('kein Port');
  port = addr.port;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  process.env.NODE_ENV = 'test';
  delete process.env.STUDIO_ACCESS_TOKEN;
});

describe('AUDIT-2026-10-30-P1-005 · Auth und Rate-Limit VOR dem Body-Parser', () => {
  it('anonymer POST mit kaputtem JSON → 401 (heute faengt der Parser ihn vorher mit 400 ab)', async () => {
    const res = await postJson('/api/ai/mode', '{kaputt', {}).catch((e: Error) => e);
    expect(res).not.toBeInstanceOf(Error);
    const { status, body } = res as { status: number; body: Record<string, unknown> };
    expect(status).toBe(401);
    expect(body.code).toBe('STUDIO_TOKEN_REQUIRED');
    expect(body.error).not.toBe('invalid JSON body');
  });

  it('anonymer 60-MB-Body auf /api/ai/vision/video → 401, ohne den Body anzufordern', async () => {
    // 60 MB liegt UEBER der alten globalen 50-MB-Grenze; der Body wird nie
    // gesendet. Antwortet die Auth (401) sofort, hat kein Parser ihn gelesen.
    const res = await postDeclaredLength('/api/ai/vision/video', 60 * 1024 * 1024);
    expect(res.status).toBe(401);
    expect(res.text).toContain('STUDIO_TOKEN_REQUIRED');
    expect(res.text).not.toContain('payload too large');
  });

  it('anonymer 65-MB-Body auf /api/master/mix → 401 (Master-Guard greift erst nach Auth)', async () => {
    const res = await postDeclaredLength('/api/master/mix', 65 * 1024 * 1024);
    expect(res.status).toBe(401);
    expect(res.text).not.toContain('payload_too_large');
  });

  it('anonymer 2-MB-Body auf eine normale Route → 401 (kein 413, keine Parser-Arbeit)', async () => {
    const res = await postDeclaredLength('/api/ai/mode', 2 * 1024 * 1024);
    expect(res.status).toBe(401);
  });
});

describe('AUDIT-2026-10-30-P1-005 · kleines Default-Limit fuer normale /api-Routen', () => {
  it('authentifizierter 2-MB-Body → 413 mit strukturiertem Fehler und Request-ID', async () => {
    const pad = 'x'.repeat(2 * 1024 * 1024);
    const res = await postJson('/api/ai/mode', JSON.stringify({ mode: 'off', pad }));
    expect(res.status).toBe(413);
    expect(res.body.error).toBe('payload too large');
    expect(typeof res.body.requestId).toBe('string');
    expect(JSON.stringify(res.body)).not.toMatch(/(\s+at\s+[\w$.]+\s*\()|\(<anonymous>\)/);
  });

  it('authentifizierter 900-kB-Body wird noch geparst (Route antwortet fachlich)', async () => {
    const pad = 'x'.repeat(900 * 1024);
    const res = await postJson('/api/ai/mode', JSON.stringify({ mode: 'kein-modus', pad }));
    // 422 = Modus ungueltig: die Route hat den Body gesehen (kein 413).
    expect(res.status).toBe(422);
    expect(res.body.error).not.toBe('payload too large');
  });

  it('ungueltiges JSON bleibt 400 "invalid JSON body" (strukturiert, kein Stack)', async () => {
    const res = await postJson('/api/ai/mode', '{kaputt');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid JSON body');
    expect(JSON.stringify(res.body)).not.toMatch(/(\s+at\s+[\w$.]+\s*\()|\(<anonymous>\)/);
  });
});

describe('AUDIT-2026-10-30-P1-005 · installApiBodyParsers (Grenzen und Liste)', () => {
  let limitServer: Server;
  let limitUrl = '';

  const post = async (path: string, body: string) => {
    const res = await fetch(`${limitUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  beforeAll(async () => {
    const app = express();
    installApiBodyParsers(app);
    app.post('/api/normal', (req, res) => res.json({ ok: true, body: req.body ?? {} }));
    app.post('/api/ai/vision/video', (req, res) => res.json({ ok: true, body: req.body ?? {} }));
    app.post('/api/session/autosave', (req, res) => res.json({ ok: true, bytes: JSON.stringify(req.body ?? {}).length }));
    app.post('/api/cloud/upload', (req, res) => res.json({ ok: true, bytes: JSON.stringify(req.body ?? {}).length }));
    limitServer = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => limitServer.once('listening', () => resolve()));
    const addr = limitServer.address();
    if (!addr || typeof addr === 'string') throw new Error('kein Port');
    limitUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => limitServer.close(() => resolve()));
  });

  it('Default ist klein (1 MB), grosses Limit bleibt 50 MB', () => {
    expect(API_JSON_LIMIT_DEFAULT).toBe('1mb');
    expect(API_JSON_LIMIT_LARGE).toBe('50mb');
  });

  it('die Liste der grossen Routen nennt Vision-Video, Show-Merge, Cloud-Upload und Autosave', () => {
    const paths = LARGE_JSON_BODY_ROUTES.map((route) => route.path);
    expect(paths).toEqual([
      '/api/ai/vision/video',
      '/api/ai/vision/show/merge',
      '/api/cloud/upload',
      '/api/session/autosave',
    ]);
    // Jede Route traegt ihre Begruendung (Zahl/Quelle) - sonst ist die Liste
    // nicht pruefbar und waechst unbemerkt.
    for (const route of LARGE_JSON_BODY_ROUTES) {
      expect(route.reason.length).toBeGreaterThan(10);
      expect(route.limit).toMatch(/^\d+(kb|mb)$/);
    }
  });

  it('normale Route: 2 MB → 413 "payload too large" (Gegenbeweis zum alten 50-MB-Deckel)', async () => {
    const res = await post('/api/normal', JSON.stringify({ pad: 'x'.repeat(2 * 1024 * 1024) }));
    expect(res.status).toBe(413);
    expect(res.body.error).toBe('payload too large');
    expect(typeof res.body.requestId).toBe('string');
  });

  it('grosse Route (Video): 5 MB kommen durch', async () => {
    const res = await post('/api/ai/vision/video', JSON.stringify({ imageBase64: 'A'.repeat(5 * 1024 * 1024) }));
    expect(res.status).toBe(200);
    expect((res.body.body as { imageBase64: string }).imageBase64.length).toBe(5 * 1024 * 1024);
  });

  it('Autosave (10 MB) und Cloud-Upload (50 MB) sind ebenfalls gross', async () => {
    const twoMb = 'x'.repeat(2 * 1024 * 1024);
    expect((await post('/api/session/autosave', JSON.stringify({ payload: twoMb }))).status).toBe(200);
    expect((await post('/api/cloud/upload', JSON.stringify({ dataBase64: twoMb }))).status).toBe(200);
  });
});

describe('AUDIT-2026-10-30-P1-005 · grosse Routen behalten ihre Grenze', () => {
  it('/api/ai/vision/video nimmt einen 5-MB-Body an (kein 413 des Default-Parsers)', async () => {
    const imageBase64 = 'A'.repeat(5 * 1024 * 1024);
    const res = await postJson('/api/ai/vision/video', JSON.stringify({ imageBase64, prompt: 'test' }));
    // Der Handler hat den Body gesehen (er antwortet in seiner eigenen Form
    // `{status:'error', code, …}`); ein Parser-Abbruch saehe anders aus
    // (`{error:'payload too large'}`). Ohne AI-Endpunkt ist der Code 502/503.
    expect(res.status).not.toBe(413);
    expect(res.body.error).not.toBe('payload too large');
    expect(res.body.status).toBe('error');
    expect(typeof res.body.code).toBe('string');
  });

  it('/api/ai/vision/show/merge nimmt mehrere MB Clip-Daten an (kein 413)', async () => {
    // 3,5 MB je Clip: unter dem Schema-Deckel (4 000 000 Zeichen), weit ueber
    // der Default-Grenze von 1 MB - genau der Fall, der 413 zeigen wuerde.
    const dataUri = `data:video/mp4;base64,${'A'.repeat(3_500_000)}`;
    const res = await postJson('/api/ai/vision/show/merge', JSON.stringify({ clips: [{ dataUri }] }));
    expect(res.status).not.toBe(413);
    expect(res.body.error).not.toBe('payload too large');
    // Der Handler hat den Body verarbeitet (die Antwort traegt seinen
    // `status`-Umschlag, nicht den des Parsers).
    expect(['success', 'error']).toContain(res.body.status);
  });

  it('/api/master/mix: authentifiziert 70 MB → 413 des Master-Guards MIT Zahlen', async () => {
    const res = await postDeclaredLength('/api/master/mix', 70 * 1024 * 1024, AUTH);
    expect(res.status).toBe(413);
    expect(res.text).toContain('payload_too_large');
    expect(res.text).toContain('erlaubt 64 MB');
  });
});
