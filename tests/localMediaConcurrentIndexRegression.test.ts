/**
 * INFRA-2026-11-06-001 · Paralleler Indexverlust in der Server-Ablage
 * ===================================================================
 * Befund (Messung 2026-11-06): 40 gleichzeitige `addLocalSample` ergaben
 * 1 Eintrag, 39 still verloren, 0 Fehler; ein Reader sah in 382 von 400 Reads
 * einen unlesbaren Index (`readFile` traf einen halb geschriebenen
 * `index.json`, weil Read-Modify-Write ohne Serialisierung und ohne
 * atomares Schreiben lief). Zusaetzlich maskierte `listLocalSamples()` jeden
 * Parse-/IO-Fehler als `[]` – die Bibliothek sah dann leer aus, obwohl der
 * Index kaputt oder unlesbar war.
 *
 * Diese Datei haelt den Zustand fest, der ab dem Fix gelten muss:
 *   1. 40 parallele `addLocalSample` -> 40 Eintraege, 0 verlorene.
 *   2. Ein Reader sieht NIE einen unvollstaendigen/kaputten Index.
 *   3. Schreibfehler (unschreibbares Verzeichnis) sind ein KLARER lokaler
 *      Fehler (`LocalStorageError` mit Problem-Code), kein stilles `[]`.
 *   4. Ein kaputter Index wird gemeldet, nicht ueberschrieben.
 *   5. Ein Neustart (frisches Modul) behaelt den Index.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { chmod, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  LocalStorageError,
  addLocalSample,
  listLocalSamples,
  localMediaStorageHealth,
  mediaDir,
  saveLocalMedia,
  type LocalSampleEntry,
} from '../server/localMediaStore';
import { processSampleUpload } from '../server/routes/uploadRoutes';
import { classifyStemFailure } from '../server/stemSeparation';

const PARALLEL = 40;
const dirs: string[] = [];
let dir = '';

function tempDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'am-media-'));
  dirs.push(d);
  return d;
}

function entry(i: number): LocalSampleEntry {
  return {
    id: `sample-${i}`,
    name: `Sample ${i}`,
    category: 'mids',
    type: 'sample',
    url: `/api/media/uploads/sample-${i}.wav`,
    description: 'Testeintrag',
    tags: ['test'],
    parameters: {},
    createdAt: new Date(2026, 10, 6, 12, 0, i % 60).toISOString(),
  };
}

beforeEach(() => {
  dir = tempDir();
  process.env.AUDIOMONASTRY_MEDIA_DIR = dir;
});

afterEach(async () => {
  delete process.env.AUDIOMONASTRY_MEDIA_DIR;
  // chmod zurueck, sonst laesst sich das Verzeichnis nicht loeschen
  for (const d of dirs.splice(0)) {
    await chmod(d, 0o700).catch(() => {});
    await rm(d, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
});

describe('localMediaStore · paralleler Index (INFRA-2026-11-06-001)', () => {
  it('verliert bei 40 parallelen addLocalSample keinen Eintrag', async () => {
    await Promise.all(Array.from({ length: PARALLEL }, (_, i) => addLocalSample(entry(i))));

    const list = await listLocalSamples();
    expect(list).toHaveLength(PARALLEL);
    expect(new Set(list.map((e) => e.id)).size).toBe(PARALLEL);
    expect(list.map((e) => e.id).sort()).toEqual(
      Array.from({ length: PARALLEL }, (_, i) => `sample-${i}`).sort(),
    );
  });

  it('laesst einen Reader nie einen kaputten oder halben Index sehen', async () => {
    const writes = Array.from({ length: PARALLEL }, (_, i) => addLocalSample(entry(i)));
    const indexFile = path.join(dir, 'index.json');

    const readerErrors: string[] = [];
    let reads = 0;
    // Waehrend die 40 Writes laufen, liest ein zweiter "Client" fortlaufend.
    const readsDone = (async () => {
      for (let i = 0; i < 200; i += 1) {
        // (a) ueber die oeffentliche API
        try {
          const list = await listLocalSamples();
          for (const e of list) {
            if (typeof e !== 'object' || e === null || typeof e.id !== 'string') {
              readerErrors.push(`ungueltiger Eintrag: ${JSON.stringify(e)}`);
            }
          }
        } catch (e) {
          readerErrors.push(`listLocalSamples: ${(e as Error).message}`);
        }
        // (b) roh auf der Platte: der Beweis fuer atomares Schreiben
        try {
          const raw = await readFile(indexFile, 'utf8');
          const parsed = JSON.parse(raw);
          if (!Array.isArray(parsed)) readerErrors.push('Index ist kein Array');
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          if (code !== 'ENOENT') readerErrors.push(`raw: ${(e as Error).message}`);
        }
        reads += 1;
      }
    })();

    await Promise.all([...writes, readsDone]);

    expect(reads).toBe(200);
    expect(readerErrors).toEqual([]);
    expect(await listLocalSamples()).toHaveLength(PARALLEL);
  });

  it('hinterlaesst keine Temp-Dateien im Ablageverzeichnis', async () => {
    await Promise.all(Array.from({ length: PARALLEL }, (_, i) => addLocalSample(entry(i))));
    const files = await readdir(dir);
    expect(files).toContain('index.json');
    expect(files.filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('behaelt den Index ueber einen Neustart (frisches Modul)', async () => {
    for (const i of [0, 1, 2, 3, 4]) await addLocalSample(entry(i));

    vi.resetModules();
    const fresh = await import('../server/localMediaStore');
    expect(fresh.mediaDir()).toBe(dir);
    const list = await fresh.listLocalSamples();
    expect(list.map((e) => e.id).sort()).toEqual(['sample-0', 'sample-1', 'sample-2', 'sample-3', 'sample-4']);
  });

  it('meldet einen unschreibbaren Ablageort als klaren lokalen Fehler statt still []', async () => {
    await mkdir(dir, { recursive: true });
    await chmod(dir, 0o500); // r-x: lesen ja, schreiben nein

    let caught: unknown = null;
    try {
      await addLocalSample(entry(1));
    } catch (e) {
      caught = e;
    }

    expect(caught, 'addLocalSample darf bei EACCES nicht still durchlaufen').toBeInstanceOf(LocalStorageError);
    const err = caught as LocalStorageError;
    expect(err.problem).toBe('dir-unwritable');
    expect(err.mediaDir).toBe(dir);
    // Die Meldung muss den Weg nennen, den ein Betreiber reparieren kann.
    expect(err.message).toContain(dir);
    expect(err.message).toContain('AUDIOMONASTRY_MEDIA_DIR');
    expect(await listLocalSamples()).toEqual([]); // Verzeichnis ist noch lesbar, nur nicht schreibbar
  });

  it('meldet einen unlesbaren Index als Fehler statt []', async () => {
    await writeFile(path.join(dir, 'index.json'), JSON.stringify([entry(0)]), 'utf8');
    await chmod(path.join(dir, 'index.json'), 0o200); // schreiben ja, lesen nein

    const listed = await listLocalSamples().catch((e: unknown) => e);
    expect(listed).toBeInstanceOf(LocalStorageError);
    expect((listed as LocalStorageError).problem).toBe('read-failed');
    expect((listed as LocalStorageError).message).toContain(dir);
  });

  it('meldet einen kaputten Index und ueberschreibt ihn nicht', async () => {
    const indexFile = path.join(dir, 'index.json');
    const broken = '[{"id": "sample-0", "name": "halb';
    await writeFile(indexFile, broken, 'utf8');

    const listed = await listLocalSamples().catch((e: unknown) => e);
    expect(listed).toBeInstanceOf(LocalStorageError);
    expect((listed as LocalStorageError).problem).toBe('index-corrupt');

    const added = await addLocalSample(entry(2)).catch((e: unknown) => e);
    expect(added).toBeInstanceOf(LocalStorageError);
    // Beweis: der kaputte Inhalt bleibt erhalten (nichts still ueberschrieben).
    expect(await readFile(indexFile, 'utf8')).toBe(broken);
  });

  it('Health-Check meldet fehlende Schreibrechte mit Pfad und Problem', async () => {
    await mkdir(dir, { recursive: true });
    const ok = await localMediaStorageHealth();
    expect(ok).toMatchObject({ ok: true, writable: true, dir });
    expect(ok.problem).toBeNull();

    await chmod(dir, 0o500);
    const bad = await localMediaStorageHealth();
    expect(bad.ok).toBe(false);
    expect(bad.writable).toBe(false);
    expect(bad.problem).toBe('dir-unwritable');
    expect(bad.message).toContain(dir);
    expect(bad.message).toContain('AUDIOMONASTRY_MEDIA_DIR');
  });
});

describe('Upload-Route · lokale Ablage (INFRA-2026-11-06-001, read-only) ', () => {
  beforeEach(() => {
    // Ohne R2-Konfiguration faellt der Upload bewusst auf die Server-Ablage zurueck.
    for (const k of ['CFS3_ENDPOINT', 'CFS3_ACCESS_KEY', 'CFS3_SECRET_KEY', 'CFS3_ACCESS_KEY_ID', 'CFS3_SECRET_ACCESS_KEY', 'CFS3_BUCKET', 'CFR2_ACCOUNT_ID', 'R2_ENDPOINT']) {
      vi.stubEnv(k, '');
    }
  });

  it('antwortet bei unschreibbarer Server-Ablage mit eigenem Fehlercode statt r2-write-failed', async () => {
    await mkdir(dir, { recursive: true });
    await chmod(dir, 0o500);

    const result = await processSampleUpload(
      { data: Buffer.from('RIFF....WAVE'), filename: 'take.wav', contentType: 'audio/wav', fields: {} },
      { getMasterPlayerUrl: () => 'http://127.0.0.1:1' },
    );

    expect(result.httpStatus).toBe(503);
    expect(result.body).toMatchObject({
      status: 'error',
      code: 'local-storage-unavailable',
      reason: 'dir-unwritable',
    });
    expect(JSON.stringify(result.body)).toContain(dir);
    expect(JSON.stringify(result.body)).not.toContain('r2-write-failed');
  });

  it('legt bei beschreibbarer Ablage Datei und Bibliothekseintrag an', async () => {
    const result = await processSampleUpload(
      { data: Buffer.from('RIFF....WAVE'), filename: 'take.wav', contentType: 'audio/wav', fields: { name: 'Take 1' } },
      { getMasterPlayerUrl: () => 'http://127.0.0.1:1' },
    );

    expect(result.httpStatus).toBe(200);
    const files = await readdir(dir);
    expect(files.some((f) => f.endsWith('.wav'))).toBe(true);
    const list = await listLocalSamples();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('Take 1');
  });

  it('saveLocalMedia meldet einen unschreibbaren Ort als LocalStorageError', async () => {
    await mkdir(dir, { recursive: true });
    await chmod(dir, 0o500);
    await expect(saveLocalMedia('uploads/samples/x.wav', Buffer.from('x'))).rejects.toBeInstanceOf(LocalStorageError);
    expect(mediaDir()).toBe(dir);
  });

  describe('GET /api/library/uploads', () => {
    async function withServer(fn: (base: string) => Promise<void>): Promise<void> {
      const express = (await import('express')).default;
      const { registerUploadRoutes } = await import('../server/routes/uploadRoutes');
      const app = express();
      registerUploadRoutes(app, {
        getMasterPlayerUrl: () => 'http://127.0.0.1:1',
        parseMultipartStream: async () => ({ fields: {}, files: [] }),
      });
      const server = app.listen(0);
      try {
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('kein Port');
        await fn(`http://127.0.0.1:${address.port}`);
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    }

    it('meldet bei kaputtem Index einen Fehler statt einer leeren Liste', async () => {
      await writeFile(path.join(dir, 'index.json'), '[{"id":', 'utf8');
      await withServer(async (base) => {
        const res = await fetch(`${base}/api/library/uploads`);
        expect(res.status).toBe(500);
        const body = (await res.json()) as Record<string, unknown>;
        expect(body).toMatchObject({ status: 'error', code: 'local-storage-unavailable', reason: 'index-corrupt' });
        expect(body.samples).toBeNull();
        expect(String(body.hint)).toContain('index.json');
      });
    });

    it('liefert bei gesunder Ablage die Liste plus storage-Health', async () => {
      await addLocalSample(entry(0));
      await withServer(async (base) => {
        const res = await fetch(`${base}/api/library/uploads`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as { status: string; samples: unknown[]; storage: { ok: boolean; writable: boolean } };
        expect(body.status).toBe('ok');
        expect(body.samples).toHaveLength(1);
        expect(body.storage).toMatchObject({ ok: true, writable: true });
      });
    });
  });
});

describe('Stem-Trennung · lokaler Ablagefehler', () => {
  it('classifyStemFailure meldet local-storage-unavailable statt eines Pod-Fehlers', () => {
    const failure = classifyStemFailure(
      new LocalStorageError('dir-unwritable', 'Verzeichnis nicht schreibbar', '/app/data/uploads'),
      'rp5',
    );
    expect(failure).toMatchObject({ httpStatus: 503, code: 'local-storage-unavailable' });
    expect(failure.hint).toContain('AUDIOMONASTRY_MEDIA_DIR');
  });
});
