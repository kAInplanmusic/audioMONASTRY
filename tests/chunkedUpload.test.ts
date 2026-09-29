import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ChunkUploadError,
  ChunkedUploadStore,
  DEFAULT_CHUNK_SIZE,
  chunkOffset,
  expectedChunkSize,
  missingChunks,
  nextMissingIndex,
  planChunks,
  receivedChunks,
  sanitizeUploadFileName,
  uploadFingerprint,
  validateInitMeta,
} from '../server/chunkedUpload';

/**
 * FEAT-P3-003: Chunk-Upload mit Wiederaufnahme.
 *
 * Der Kern der Zusage ist "Fortsetzen an der Abbruchstelle". Genau das wird hier
 * gemessen - inklusive der Faelle, die eine Wiederaufnahme kaputt machen wuerden:
 * ein halb geschriebener Chunk, ein erneut gesendeter Chunk (Idempotenz) und ein
 * Serverneustart (die Sitzung liegt auf Platte, nicht im Speicher).
 */

const CHUNK = 256 * 1024; // kleinster erlaubter Chunk: schnell, aber realistisch

/** Deterministische Testdaten (kein Zufall: sha256 muss reproduzierbar sein). */
function testBytes(size: number): Buffer {
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i += 1) buf[i] = (i * 31 + 7) % 256;
  return buf;
}

const sha256OfBuffer = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

let dir = '';

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'chunkupload-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('FEAT-P3-003 · reine Chunk-Arithmetik', () => {
  it('plant Chunks und kennt die Groesse des letzten', () => {
    expect(planChunks(10 * CHUNK, CHUNK)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(planChunks(10 * CHUNK + 1, CHUNK)).toHaveLength(11);
    expect(planChunks(0, CHUNK)).toEqual([]);
    expect(planChunks(-5, CHUNK)).toEqual([]);
    expect(expectedChunkSize(10 * CHUNK + 1, CHUNK, 10)).toBe(1);
    expect(expectedChunkSize(10 * CHUNK, CHUNK, 9)).toBe(CHUNK);
    expect(chunkOffset(CHUNK, 3)).toBe(3 * CHUNK);
  });

  it('erkennt fehlende Chunks in Reihenfolge (Wiederaufnahmepunkt)', () => {
    const size = 4 * CHUNK;
    // Chunks 0 und 2 sind vollstaendig, 1 und 3 fehlen.
    const written = { 0: CHUNK, 2: CHUNK };
    expect(receivedChunks(size, CHUNK, written)).toEqual([0, 2]);
    expect(missingChunks(size, CHUNK, written)).toEqual([1, 3]);
    expect(nextMissingIndex(size, CHUNK, written)).toBe(1);
    // Alles da -> kein Wiederaufnahmepunkt.
    expect(nextMissingIndex(size, CHUNK, { 0: CHUNK, 1: CHUNK, 2: CHUNK, 3: CHUNK })).toBeNull();
  });

  it('zaehlt einen halb geschriebenen Chunk NICHT als vorhanden', () => {
    // Ein Abbruch MITTEN im Chunk darf keine Luecke als "erledigt" markieren.
    const written = { 0: CHUNK, 1: Math.floor(CHUNK / 2), 2: CHUNK };
    expect(receivedChunks(3 * CHUNK, CHUNK, written)).toEqual([0, 2]);
    expect(nextMissingIndex(3 * CHUNK, CHUNK, written)).toBe(1);
  });

  it('validiert Init-Metadaten und saeubert Dateinamen', () => {
    expect(validateInitMeta({ filename: 'a.wav', size: 1000, chunkSize: CHUNK, maxBytes: 1e6 }))
      .toEqual({ filename: 'a.wav', size: 1000, chunkSize: CHUNK });
    // Pfadanteile fliegen raus, Steuerzeichen werden ersetzt.
    expect(sanitizeUploadFileName('../../etc/pa\u0000sswd.wav')).toBe('pa_sswd.wav');
    expect(sanitizeUploadFileName('')).toBe('upload');
    expect(() => validateInitMeta({ filename: 'a.wav', size: 0, chunkSize: CHUNK, maxBytes: 1e6 }))
      .toThrowError(ChunkUploadError);
    expect(() => validateInitMeta({ filename: 'a.wav', size: 2e6, chunkSize: CHUNK, maxBytes: 1e6 }))
      .toThrowError(/zu gross/);
    expect(() => validateInitMeta({ filename: 'a.wav', size: 100, chunkSize: 10, maxBytes: 1e6 }))
      .toThrowError(/chunkSize/);
  });

  it('bildet einen stabilen Fingerabdruck pro Datei', () => {
    const a = uploadFingerprint('take.wav', 1024, 111);
    expect(a).toBe(uploadFingerprint('take.wav', 1024, 111));
    expect(a).not.toBe(uploadFingerprint('take.wav', 1025, 111));
    expect(a).toHaveLength(32);
  });
});

describe('FEAT-P3-003 · Sitzung auf Platte (Wiederaufnahme)', () => {
  const init = (store: ChunkedUploadStore, size: number, fingerprint: string) =>
    store.init({ filename: 'take.wav', size, chunkSize: CHUNK, fields: { kind: 'recording' }, fingerprint });

  it('setzt einen abgebrochenen Upload an der Abbruchstelle fort', async () => {
    const size = 3 * CHUNK + 123;
    const original = testBytes(size);
    const store = new ChunkedUploadStore(dir);

    // Runde 1: Chunk 0 und 2 kommen an, dann bricht es ab ("Netz weg").
    const { meta } = await init(store, size, 'fp-1');
    await store.writeChunk(meta.uploadId, 0, original.subarray(0, CHUNK));
    await store.writeChunk(meta.uploadId, 2, original.subarray(2 * CHUNK, 3 * CHUNK));
    const afterAbort = await store.status(meta.uploadId);
    expect(afterAbort.receivedChunks).toEqual([0, 2]);
    expect(afterAbort.nextIndex).toBe(1);

    // Runde 2: NEUE Instanz (kein In-Memory-Zustand) - genau das passiert nach
    // einem Serverneustart. init() findet die Sitzung ueber den Fingerabdruck.
    const storeAfterRestart = new ChunkedUploadStore(dir);
    const resumed = await init(storeAfterRestart, size, 'fp-1');
    expect(resumed.status.resumed).toBe(true);
    expect(resumed.status.uploadId).toBe(meta.uploadId);
    expect(resumed.status.receivedChunks).toEqual([0, 2]);
    expect(resumed.status.nextIndex).toBe(1);

    // Nur die fehlenden Chunks nachsenden (1 und 3).
    const missing = resumed.status.missingChunks;
    expect(missing).toEqual([1, 3]);
    for (const index of missing) {
      const offset = index * CHUNK;
      await storeAfterRestart.writeChunk(meta.uploadId, index, original.subarray(offset, offset + expectedChunkSize(size, CHUNK, index)));
    }
    const status = await storeAfterRestart.status(meta.uploadId);
    expect(status.complete).toBe(true);
    expect(status.receivedBytes).toBe(size);

    // Und das Ergebnis ist BYTE-IDENTISCH zur Originaldatei.
    const { data, sha256 } = await storeAfterRestart.assemble(meta.uploadId);
    expect(data.length).toBe(size);
    expect(data.equals(original)).toBe(true);
    expect(sha256).toBe(sha256OfBuffer(original));
  });

  it('ist idempotent: ein erneut gesendeter Chunk aendert nichts', async () => {
    const size = 2 * CHUNK;
    const original = testBytes(size);
    const store = new ChunkedUploadStore(dir);
    const { meta } = await init(store, size, 'fp-2');
    const first = original.subarray(0, CHUNK);

    await store.writeChunk(meta.uploadId, 0, first);
    const a = await store.status(meta.uploadId);
    await store.writeChunk(meta.uploadId, 0, first); // Retry desselben Chunks
    const b = await store.status(meta.uploadId);
    expect(b.receivedChunks).toEqual(a.receivedChunks);
    expect(b.receivedBytes).toBe(a.receivedBytes);
    expect((await store.assemble(meta.uploadId).catch(() => null))).toBeNull(); // noch unvollstaendig
  });

  it('weist unvollstaendige Abschluesse und falsche Chunks ab', async () => {
    const size = 2 * CHUNK;
    const store = new ChunkedUploadStore(dir);
    const { meta } = await init(store, size, 'fp-3');
    await store.writeChunk(meta.uploadId, 0, testBytes(CHUNK));

    await expect(store.assemble(meta.uploadId)).rejects.toThrowError(/unvollstaendig/);
    await expect(store.writeChunk(meta.uploadId, 5, Buffer.alloc(1))).rejects.toThrowError(/ausserhalb/);
    await expect(store.writeChunk(meta.uploadId, 1, Buffer.alloc(CHUNK + 1))).rejects.toThrowError(/erwartet hoechstens/);
    await expect(store.status('gibt-es-nicht')).rejects.toThrowError(/unbekannte Upload-Sitzung/);
  });

  it('verwirft abgebrochene Uploads nach dem TTL (sonst waechst die Platte zu)', async () => {
    const store = new ChunkedUploadStore(dir, 1000);
    const { meta } = await init(store, CHUNK, 'fp-4');
    const partPath = path.join(dir, `${meta.uploadId}.part`);
    // Leer angelegt; erst ein geschriebener Chunk dehnt die Datei (spaerlich).
    expect((await stat(partPath)).size).toBe(0);
    await store.writeChunk(meta.uploadId, 0, testBytes(CHUNK));
    expect((await stat(partPath)).size).toBe(CHUNK);

    const removed = await store.sweep(Date.now() + 5000);
    expect(removed).toEqual([meta.uploadId]);
    await expect(stat(partPath)).rejects.toThrow();
  });

  it('setzt keine Sitzung fort, wenn die Groesse nicht passt (andere Datei, gleicher Name)', async () => {
    const store = new ChunkedUploadStore(dir);
    const { meta } = await init(store, CHUNK, 'fp-5');
    const other = await init(store, 2 * CHUNK, 'fp-5');
    expect(other.meta.uploadId).not.toBe(meta.uploadId);
  });
});

describe('FEAT-P3-003 · Default-Groesse', () => {
  it('nutzt 4 MB als Default und akzeptiert den Default-Pfad ohne chunkSize', async () => {
    expect(DEFAULT_CHUNK_SIZE).toBe(4 * 1024 * 1024);
    const store = new ChunkedUploadStore(dir);
    const { meta } = await store.init({ filename: 'x.wav', size: 1000, chunkSize: DEFAULT_CHUNK_SIZE });
    expect(meta.chunkSize).toBe(DEFAULT_CHUNK_SIZE);
    const status = await store.status(meta.uploadId);
    expect(status.missingChunks).toEqual([0]);
    expect(status.nextIndex).toBe(0);
  });
});

// Ungenutzte Import-Warnung vermeiden: writeFile wird fuer einen Negativfall der
// Metadaten benoetigt (kaputtes JSON darf die Liste nicht sprengen).
describe('FEAT-P3-003 · robuste Metadaten', () => {
  it('ignoriert kaputte Metadatendateien', async () => {
    const store = new ChunkedUploadStore(dir);
    await writeFile(path.join(dir, 'kaputt.json'), '{ nicht json', 'utf8');
    expect(await store.list()).toEqual([]);
  });
});

/**
 * QUAL-P3-002 (2026-09-23): gleichzeitige Chunks derselben Sitzung.
 *
 * ANLASS: Beim Suchen nach weiteren nicht-atomaren Schreibern (nach QUAL-P2-008)
 * fiel auf, dass `writeChunk()` die Metadaten per read-modify-write neu aufbaut.
 * Zwei gleichzeitige Chunks lesen denselben Ausgangsstand, und der zweite
 * ueberschreibt den Eintrag des ersten.
 *
 * GEMESSEN mit scripts/chunkupload-race-repro.ts VOR dem Fix: 8 gleichzeitig
 * gesendete Chunks, alle 8 ohne Fehler - danach stand GENAU EIN Eintrag in den
 * Metadaten, 7 galten als fehlend. Der Client sendet sie erneut, und ohne Sperre
 * verlieren sie sich wieder: der Upload kommt nie zum Abschluss.
 *
 * Die Schnittstelle laesst parallele Chunks ausdruecklich zu (ein Client mit
 * mehreren Verbindungen ist der Normalfall), der Verlust war also kein
 * Missbrauch, sondern ein Fehler.
 */
describe('QUAL-P3-002 · gleichzeitige Chunks derselben Sitzung', () => {
  const TEILE = 8;

  /** Sitzung mit TEILE Chunks anlegen. */
  const sitzung = async (store: ChunkedUploadStore) => {
    const { meta } = await store.init({
      filename: 'parallel.bin',
      size: CHUNK * TEILE,
      chunkSize: CHUNK,
      contentType: 'application/octet-stream',
    });
    return meta.uploadId;
  };

  it('verliert keinen Chunk-Eintrag, wenn alle Teile gleichzeitig eintreffen', async () => {
    const store = new ChunkedUploadStore(dir);
    const uploadId = await sitzung(store);

    const ergebnisse = await Promise.allSettled(
      Array.from({ length: TEILE }, (_, i) => store.writeChunk(uploadId, i, Buffer.alloc(CHUNK, i))),
    );

    // Gegenprobe, dass wirklich gemessen wurde: kein Aufruf darf fehlgeschlagen sein,
    // sonst waere ein fehlender Eintrag die richtige Antwort.
    expect(ergebnisse.filter((e) => e.status === 'rejected')).toEqual([]);

    const meta = await store.readMeta(uploadId);
    expect(Object.keys(meta.chunks ?? {}).sort((a, b) => Number(a) - Number(b))).toEqual(
      Array.from({ length: TEILE }, (_, i) => String(i)),
    );

    // Und die Sitzung gilt als vollstaendig - das ist die Zusage, die vorher brach.
    const status = await store.status(uploadId);
    expect(status.missingChunks).toEqual([]);
    expect(status.complete).toBe(true);
  });

  it('laesst paralleles Lesen waehrend des Schreibens nicht fehlschlagen', async () => {
    const store = new ChunkedUploadStore(dir);
    const uploadId = await sitzung(store);

    // Lesen und Schreiben gleichzeitig: vorher konnte readMeta() eine halb
    // geschriebene Datei erwischen und daraus UNKNOWN_UPLOAD machen.
    let gelesen = 0;
    const leser = Array.from({ length: 12 }, async () => {
      const s = await store.status(uploadId);
      gelesen += 1;
      expect(s.uploadId).toBe(uploadId);
    });
    const schreiber = Array.from({ length: TEILE }, (_, i) =>
      store.writeChunk(uploadId, i, Buffer.alloc(CHUNK, i)),
    );

    await expect(Promise.all([...leser, ...schreiber])).resolves.toBeDefined();
    expect(gelesen).toBe(12);
  });

  it('laesst keine temporaeren Schreibdateien liegen', async () => {
    const store = new ChunkedUploadStore(dir);
    const uploadId = await sitzung(store);
    await Promise.all(Array.from({ length: TEILE }, (_, i) => store.writeChunk(uploadId, i, Buffer.alloc(CHUNK, i))));

    const { readdir } = await import('node:fs/promises');
    const dateien = await readdir(dir);
    expect(dateien.filter((f) => f.endsWith('.tmp'))).toEqual([]);
    // Genau eine Sitzung - eine temporaere Datei waere sonst ein Phantom in list().
    await expect(store.list()).resolves.toHaveLength(1);
  });

  it('setzt die Datei korrekt zusammen (Inhalt je Chunk unterscheidbar)', async () => {
    const store = new ChunkedUploadStore(dir);
    const uploadId = await sitzung(store);
    await Promise.all(Array.from({ length: TEILE }, (_, i) => store.writeChunk(uploadId, i, Buffer.alloc(CHUNK, i))));

    const { data, sha256 } = await store.assemble(uploadId);
    expect(data.length).toBe(CHUNK * TEILE);
    expect(sha256).toBe(createHash('sha256').update(data).digest('hex'));
    // Jeder Chunk traegt seinen Index als Bytewert - so faellt ein falscher
    // Offset oder ein ueberschriebener Bereich sofort auf.
    for (let i = 0; i < TEILE; i += 1) {
      expect(data[chunkOffset(CHUNK, i)]).toBe(i);
    }
  });
});
