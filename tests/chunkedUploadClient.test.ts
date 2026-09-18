import { describe, expect, it, vi } from 'vitest';
import {
  ChunkedUploadError,
  chunksToSend,
  fileFingerprint,
  progressPercent,
  retryDelayMs,
  uploadFileInChunks,
} from '../src/utils/chunkedUpload';

/**
 * FEAT-P3-003 · Client-Seite: nach einem Abbruch werden NUR die fehlenden Chunks
 * gesendet, Retries laufen mit Backoff, und ein Abbruch beendet die Schleife
 * sofort (die Sitzung bleibt serverseitig bestehen).
 */

const CHUNK = 256 * 1024;

/** Minimaler File-Ersatz (nur was der Uploader braucht: slice/arrayBuffer). */
function fakeFile(name: string, size: number, lastModified = 1700000000000): File {
  const bytes = Buffer.alloc(size);
  for (let i = 0; i < size; i += 1) bytes[i] = i % 256;
  return {
    name,
    size,
    type: 'audio/wav',
    lastModified,
    slice: (start: number, end: number) => ({
      arrayBuffer: async () => bytes.subarray(start, end),
    }),
  } as unknown as File;
}

describe('FEAT-P3-003 · Client-Hilfsfunktionen', () => {
  it('bildet einen stabilen Fingerabdruck pro Datei', () => {
    const a = fileFingerprint({ name: 'take.wav', size: 1000, lastModified: 42 });
    expect(a).toBe(fileFingerprint({ name: 'take.wav', size: 1000, lastModified: 42 }));
    expect(a).not.toBe(fileFingerprint({ name: 'take.wav', size: 1001, lastModified: 42 }));
    expect(a.startsWith('f')).toBe(true);
  });

  it('sortiert die fehlenden Chunks und rechnet den Fortschritt', () => {
    expect(chunksToSend({ missingChunks: [3, 1, 2] })).toEqual([1, 2, 3]);
    expect(progressPercent(0, 100)).toBe(0);
    expect(progressPercent(50, 100)).toBe(50);
    expect(progressPercent(100, 100)).toBe(100);
    expect(progressPercent(200, 100)).toBe(100);
    expect(progressPercent(10, 0)).toBe(0);
  });

  it('wartet bei 429 länger als bei einem Serverfehler', () => {
    expect(retryDelayMs(1, 429)).toBe(2000);
    expect(retryDelayMs(1, 500)).toBe(500);
    expect(retryDelayMs(3, 500)).toBe(2000);
    expect(retryDelayMs(99, 500)).toBe(30_000);
  });
});

describe('FEAT-P3-003 · Resume auf Client-Seite', () => {
  it('sendet nach einem Abbruch nur die fehlenden Chunks', async () => {
    const size = 3 * CHUNK;
    const file = fakeFile('resume.wav', size);
    const calls: string[] = [];
    const progress: number[] = [];

    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.endsWith('/init')) {
        // Der Server kennt die Datei schon: Chunk 0 und 2 sind da, 1 fehlt.
        return new Response(JSON.stringify({
          status: 'ok', uploadId: 'up-1', filename: 'resume.wav', size, chunkSize: CHUNK,
          receivedChunks: [0, 2], missingChunks: [1], nextIndex: 1,
          receivedBytes: 2 * CHUNK, complete: false, resumed: true,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.endsWith('/complete')) {
        return new Response(JSON.stringify({ status: 'ok', sample: { id: 'sample-1' } }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await uploadFileInChunks(file, {
      chunkSize: CHUNK,
      fetchImpl,
      onProgress: (info) => progress.push(info.percent),
    });

    expect(result).toMatchObject({ status: 'ok' });
    // Genau EIN Chunk-PUT - naemlich der fehlende (Index 1).
    const puts = calls.filter((c) => c.startsWith('PUT'));
    expect(puts).toEqual(['PUT /api/upload/chunk/up-1/1']);
    expect(calls).toHaveLength(3); // init, PUT, complete
    // Fortschritt startet bei den bereits vorhandenen Bytes (2/3 Chunks).
    expect(progress[0]).toBe(67);
    expect(progress.at(-1)).toBe(100);
  });

  it('wiederholt 429 mit Backoff und gelingt danach', async () => {
    const size = CHUNK;
    const file = fakeFile('limited.wav', size);
    let attempts = 0;
    const sleeps: number[] = [];

    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/init')) {
        return new Response(JSON.stringify({
          status: 'ok', uploadId: 'up-2', filename: 'limited.wav', size, chunkSize: CHUNK,
          receivedChunks: [], missingChunks: [0], nextIndex: 0, receivedBytes: 0, complete: false, resumed: false,
        }), { status: 200 });
      }
      if (init?.method === 'PUT') {
        attempts += 1;
        if (attempts === 1) return new Response(JSON.stringify({ status: 'error', code: 'RATE_LIMIT' }), { status: 429 });
        return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await uploadFileInChunks(file, {
      chunkSize: CHUNK,
      fetchImpl,
      sleep: async (ms) => { sleeps.push(ms); },
    });

    expect(result).toMatchObject({ status: 'ok' });
    expect(attempts).toBe(2);
    expect(sleeps).toEqual([2000]); // Backoff fuer 429
  });

  it('bricht bei einem 4xx sofort ab (kein sinnloser Retry) und laesst die Sitzung stehen', async () => {
    const size = CHUNK;
    const file = fakeFile('bad.wav', size);
    let puts = 0;

    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/init')) {
        return new Response(JSON.stringify({
          status: 'ok', uploadId: 'up-3', filename: 'bad.wav', size, chunkSize: CHUNK,
          receivedChunks: [], missingChunks: [0, 1], nextIndex: 0, receivedBytes: 0, complete: false, resumed: false,
        }), { status: 200 });
      }
      if (init?.method === 'PUT') {
        puts += 1;
        return new Response(JSON.stringify({ status: 'error', code: 'CHUNK_TOO_LARGE', message: 'zu gross' }), { status: 400 });
      }
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    await expect(uploadFileInChunks(file, { chunkSize: CHUNK, fetchImpl, sleep: async () => {} }))
      .rejects.toThrowError(/CHUNK_TOO_LARGE|zu gross/);
    expect(puts).toBe(1); // kein zweiter Versuch bei 400
  });

  it('respektiert ein Abbruchsignal sofort', async () => {
    const controller = new AbortController();
    const file = fakeFile('abort.wav', 2 * CHUNK);

    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/init')) {
        return new Response(JSON.stringify({
          status: 'ok', uploadId: 'up-4', filename: 'abort.wav', size: 2 * CHUNK, chunkSize: CHUNK,
          receivedChunks: [], missingChunks: [0, 1], nextIndex: 0, receivedBytes: 0, complete: false, resumed: false,
        }), { status: 200 });
      }
      if (init?.method === 'PUT') {
        controller.abort(); // Nutzer bricht mitten im ersten Chunk ab
        return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    const error = await uploadFileInChunks(file, {
      chunkSize: CHUNK, fetchImpl, sleep: async () => {}, signal: controller.signal,
    }).catch((e) => e);
    expect(error).toBeInstanceOf(ChunkedUploadError);
    expect((error as ChunkedUploadError).code).toBe('ABORTED');
  });
});
