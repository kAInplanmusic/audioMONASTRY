import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';

/**
 * FEAT-P3-003 · Abnahmetest: Uploads laufen in Chunks und werden nach einem
 * Abbruch AN DER ABBRUCHSTELLE fortgesetzt.
 *
 * Der Test geht ueber die echten HTTP-Routen der App (nicht ueber den Store):
 * init -> Chunks (auch out-of-order) -> "Abbruch" -> erneutes init mit gleichem
 * Fingerabdruck (so findet ein neuer Browser/Serverprozess die Sitzung wieder)
 * -> nur die fehlenden Chunks -> complete. Geprueft wird ausserdem, dass der
 * Chunk-Weg in DERSELBEN Verarbeitung landet wie der Multipart-Weg (Scанн/Format
 * identisch) und dass unvollstaendige Uploads gar nicht bis dorthin kommen.
 *
 * R2/Supabase sind im Test nicht konfiguriert: `complete` endet deshalb nach der
 * gemeinsamen Validierung in der Ablage - genau dort zeigt `chunked.sha256`,
 * dass die Datei byte-identisch zusammengesetzt wurde.
 */

const CHUNK = 256 * 1024; // MIN_CHUNK_SIZE: realistische Chunk-Grenze, kleiner Test
let server: Server;
let baseUrl = '';
let uploadDir = '';

const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

/** Deterministische Nutzdaten (keine Zufallsdaten: sha256 muss reproduzierbar sein). */
function testBytes(size: number): Buffer {
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i += 1) buf[i] = (i * 17 + 3) % 256;
  return buf;
}

const initUpload = async (body: Record<string, unknown>) => {
  const res = await fetch(`${baseUrl}/api/upload/chunk/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
};

const putChunk = async (uploadId: string, index: number, data: Buffer) => {
  const res = await fetch(`${baseUrl}/api/upload/chunk/${uploadId}/${index}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: new Uint8Array(data),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
};

const chunkOf = (original: Buffer, index: number, size: number) =>
  original.subarray(index * CHUNK, Math.min(size, (index + 1) * CHUNK));

beforeAll(async () => {
  process.env.VITEST = 'true';
  delete process.env.STUDIO_ACCESS_TOKEN;
  // FEAT-P3-003: Chunk-Uploads laufen bewusst NICHT unter der Kostenbremse
  // (`/api/upload/sample` bleibt dort), sondern unter einem eigenen Budget.
  // Hier absichtlich ENG gesetzt: genau 10 - mit dem alten Verhalten waere ein
  // Upload mit mehr als 10 Chunks unmoeglich gewesen (live belegt: 429).
  process.env.API_EXPENSIVE_RATE_LIMIT_MAX = '10';
  process.env.API_RATE_LIMIT_MAX = '10000';
  process.env.UPLOAD_CHUNK_RATE_LIMIT_MAX = '10000';
  // Eigene Ablage: der Test darf keine fremden Upload-Sitzungen sehen.
  uploadDir = await mkdtemp(path.join(tmpdir(), 'upload-routes-'));
  process.env.UPLOAD_CHUNK_DIR = uploadDir;
  const mod = await import('../server');
  server = mod.app.listen(0);
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('kein Port');
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(uploadDir, { recursive: true, force: true });
  delete process.env.UPLOAD_CHUNK_DIR;
});

describe('FEAT-P3-003 · Chunk-Upload mit Wiederaufnahme', () => {
  it('setzt nach einem Abbruch an der Abbruchstelle fort und setzt byte-identisch zusammen', async () => {
    const size = 2 * CHUNK + 1000; // 3 Chunks, letzter bewusst kurz
    const original = testBytes(size);
    const fingerprint = 'abnahme-resume-1';

    // --- Runde 1: init, Chunk 0 und 2 kommen an (out-of-order), dann Abbruch ---
    const first = await initUpload({ filename: 'take.wav', size, chunkSize: CHUNK, fields: { kind: 'recording', name: 'Take 1' }, fingerprint });
    expect(first.status).toBe(200);
    expect(first.body.status).toBe('ok');
    expect(first.body.resumed).toBe(false);
    expect(first.body.missingChunks).toEqual([0, 1, 2]);
    expect(first.body.nextIndex).toBe(0);
    const uploadId = String(first.body.uploadId);
    expect(uploadId.length).toBeGreaterThan(10);

    const c0 = await putChunk(uploadId, 0, chunkOf(original, 0, size));
    expect(c0.status).toBe(200);
    expect(c0.body.receivedChunks).toEqual([0]);
    const c2 = await putChunk(uploadId, 2, chunkOf(original, 2, size));
    expect(c2.status).toBe(200);
    expect(c2.body.receivedChunks).toEqual([0, 2]);
    expect(c2.body.nextIndex).toBe(1);
    // Chunk 0 ist voll, Chunk 2 ist der kurze letzte (1000 Bytes).
    expect(c2.body.receivedBytes).toBe(CHUNK + 1000);
    expect(c2.body.complete).toBe(false);

    // Abbruch mitten im Spiel: Chunk 1 fehlt. Ein NEUES init (neuer Browser bzw.
    // nach Serverneustart) findet die Sitzung ueber den Fingerabdruck wieder.
    const again = await initUpload({ filename: 'take.wav', size, chunkSize: CHUNK, fields: { kind: 'recording', name: 'Take 1' }, fingerprint });
    expect(again.body.resumed).toBe(true);
    expect(again.body.uploadId).toBe(uploadId);
    expect(again.body.receivedChunks).toEqual([0, 2]);
    expect(again.body.missingChunks).toEqual([1]);
    expect(again.body.nextIndex).toBe(1);

    // Nur der fehlende Chunk wird nachgesendet.
    const c1 = await putChunk(uploadId, 1, chunkOf(original, 1, size));
    expect(c1.status).toBe(200);
    expect(c1.body.complete).toBe(true);
    expect(c1.body.receivedBytes).toBe(size);
    expect(c1.body.nextIndex).toBeNull();

    // --- Abschluss: die Datei geht durch die GEMEINSAME Verarbeitung ---
    const complete = await fetch(`${baseUrl}/api/upload/chunk/${uploadId}/complete`, { method: 'POST' });
    const body = await complete.json() as Record<string, unknown>;
    const chunked = body.chunked as { bytes: number; sha256: string; cleanedUp: boolean };
    expect(chunked.bytes).toBe(size);
    // Byte-identisch zur Originaldatei - und zwar genau so, wie sie der Server
    // an die Ablage weitergibt.
    expect(chunked.sha256).toBe(sha256(original));
    // R2 ist im Test nicht konfiguriert: die Verarbeitung scheitert ERST in der
    // Ablage (nicht an Format/Groesse) - also lief die gemeinsame Pipeline.
    expect(complete.status).toBe(500);
    expect(String(body.message)).toMatch(/R2 not configured/);
    // Nichts aufgeraeumt: die zusammengesetzte Datei bleibt fuer einen Retry.
    expect(chunked.cleanedUp).toBe(false);
  });

  it('nimmt einen erneut gesendeten Chunk idempotent an (Retry nach Timeout)', async () => {
    const size = 2 * CHUNK;
    const original = testBytes(size);
    const { body } = await initUpload({ filename: 'retry.wav', size, chunkSize: CHUNK, fingerprint: 'abnahme-retry' });
    const uploadId = String(body.uploadId);

    const a = await putChunk(uploadId, 0, chunkOf(original, 0, size));
    const b = await putChunk(uploadId, 0, chunkOf(original, 0, size)); // derselbe Chunk nochmal
    expect(b.body.receivedChunks).toEqual(a.body.receivedChunks);
    expect(b.body.receivedBytes).toBe(a.body.receivedBytes);
    expect(b.body.complete).toBe(false);
  });

  it('laesst unvollstaendige Uploads nicht bis zur Verarbeitung durch', async () => {
    const size = 2 * CHUNK;
    const { body } = await initUpload({ filename: 'halt.wav', size, chunkSize: CHUNK, fingerprint: 'abnahme-halt' });
    const uploadId = String(body.uploadId);
    await putChunk(uploadId, 0, chunkOf(testBytes(size), 0, size));

    const complete = await fetch(`${baseUrl}/api/upload/chunk/${uploadId}/complete`, { method: 'POST' });
    expect(complete.status).toBe(409);
    const payload = await complete.json() as Record<string, unknown>;
    expect(payload.code).toBe('INCOMPLETE');
    expect(String(payload.message)).toMatch(/unvollstaendig/);
  });

  it('weist unbekannte Sitzungen, falsche Indizes und unzulaessige Chunk-Groessen ab', async () => {
    const unknown = await fetch(`${baseUrl}/api/upload/chunk/does-not-exist`, { method: 'GET' });
    expect(unknown.status).toBe(404);
    expect((await unknown.json() as Record<string, unknown>).code).toBe('UNKNOWN_UPLOAD');

    const badChunk = await initUpload({ filename: 'tiny.wav', size: 10, chunkSize: 1024, fingerprint: 'abnahme-tiny' });
    expect(badChunk.status).toBe(400);
    expect(badChunk.body.code).toBe('CHUNK_SIZE_MISMATCH');

    const { body } = await initUpload({ filename: 'idx.wav', size: CHUNK, chunkSize: CHUNK, fingerprint: 'abnahme-index' });
    const uploadId = String(body.uploadId);
    const outOfRange = await putChunk(uploadId, 7, Buffer.alloc(10));
    expect(outOfRange.status).toBe(400);
    expect(outOfRange.body.code).toBe('CHUNK_OUT_OF_RANGE');
    const tooLarge = await putChunk(uploadId, 0, Buffer.alloc(CHUNK + 1));
    expect(tooLarge.status).toBe(400);
    expect(tooLarge.body.code).toBe('CHUNK_TOO_LARGE');

    const tooBig = await initUpload({ filename: 'big.wav', size: 500 * 1024 * 1024, chunkSize: CHUNK, fingerprint: 'abnahme-big' });
    expect(tooBig.status).toBe(400);
    expect(tooBig.body.code).toBe('INVALID_META');
  });

  it('nutzt fuer den Chunk-Weg DIESELBE Validierung wie der Multipart-Weg', async () => {
    const size = CHUNK;
    const { body } = await initUpload({ filename: 'boese.exe', size, chunkSize: CHUNK, fingerprint: 'abnahme-format' });
    const uploadId = String(body.uploadId);
    await putChunk(uploadId, 0, testBytes(size));

    const complete = await fetch(`${baseUrl}/api/upload/chunk/${uploadId}/complete`, { method: 'POST' });
    expect(complete.status).toBe(415);
    const payload = await complete.json() as Record<string, unknown>;
    expect(String(payload.message)).toMatch(/Nicht unterstütztes Audio-Format/);
  });
});

/**
 * Der live gefundene Konflikt: `/api/upload` lag unter dem "expensiv"-Limiter
 * mit 10 Requests/Minute. Ein Chunk-Upload braucht zwangslaeufig mehr Requests -
 * er lief deshalb mitten im Upload in 429. Dieser Test haelt die Trennung fest:
 * der Chunk-Weg funktioniert auch, wenn die Kostenbremse bei 10 steht.
 */
describe('FEAT-P3-003 · Chunk-Upload vs. Kostenbremse', () => {
  it('laeuft auch bei engem "expensiv"-Limit (10/min) durch', async () => {
    const size = 3 * CHUNK;
    const original = testBytes(size);
    const { body } = await initUpload({ filename: 'viele.wav', size, chunkSize: CHUNK, fingerprint: 'abnahme-limiter' });
    expect(body.status).toBe('ok');
    const uploadId = String(body.uploadId);
    // 5 Requests (init + 3 Chunks + complete) - mehr als das alte Limit von 10
    // waeren fuer einen echten 100-MB-Upload ohnehin zu wenig, hier reicht der
    // Nachweis: es kommt KEIN 429.
    for (const index of [0, 1, 2]) {
      const res = await putChunk(uploadId, index, chunkOf(original, index, size));
      expect(res.status).not.toBe(429);
      expect(res.status).toBe(200);
    }
    const complete = await fetch(`${baseUrl}/api/upload/chunk/${uploadId}/complete`, { method: 'POST' });
    expect(complete.status).not.toBe(429);
    expect((await complete.json() as { chunked?: { sha256: string } }).chunked?.sha256).toBe(sha256(original));
  });
});
