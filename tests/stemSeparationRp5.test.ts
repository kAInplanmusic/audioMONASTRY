// FLEET-P1-006: stemMONK -> Server -> RP5 (gemockte Flotte, ohne Netz/GPU).
// Belegt: Auftrag geht als stem.separate mit bs-roformer-sw-6stem raus, mit R2
// per Presigned-PUT (kein Base64 zurueck), ohne R2 Base64 -> Server-Ablage; der
// Client bekommt nur URLs; Bibliothek wird geschrieben; Pod/Gewichte fehlen ->
// klare Meldung OHNE Rueckfall; 4-Stem-Modus nur ausdruecklich bzw. gekennzeichnet.
process.env.NODE_ENV ??= 'test';

import express from 'express';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { registerStemRoutes, type StemDeps } from '../server/routes/stemRoutes';
import {
  classifyStemFailure,
  ingestFourStems,
  parseWarpFields,
  separateOnRp5,
  stemObjectKey,
  type StemLibraryEntry,
  type StemStorage,
} from '../server/stemSeparation';

const FIVE = ['vocals', 'lows', 'mids', 'highs', 'melody'];

function memoryStorage(r2: boolean) {
  const stored = new Map<string, Buffer>();
  const storage: StemStorage = {
    presignPut: (key) => (r2 ? { putUrl: `https://r2.example/put/${key}?X-Amz-Signature=x`, url: `https://pub.example/${key}` } : null),
    store: async (key, data) => {
      stored.set(key, data);
      return { url: `/api/media/uploads/${key.split('/').pop()}`, storage: 'server' };
    },
  };
  return { storage, stored };
}

function libraryCollector() {
  const entries: { entry: StemLibraryEntry; storage: string }[] = [];
  return { entries, writer: async (entry: StemLibraryEntry, storage: 'r2' | 'server') => { entries.push({ entry, storage }); } };
}

const AUDIO = Buffer.from('RIFF....WAVEfmt ');

describe('separateOnRp5', () => {
  it('mit R2: Presigned-PUT-URLs an den Pod, Antwort nur URLs, Bibliothek geschrieben', async () => {
    const { storage, stored } = memoryStorage(true);
    const lib = libraryCollector();
    const calls: { model: string; input: Record<string, unknown> }[] = [];
    const res = await separateOnRp5({ data: AUDIO, filename: 'My Song.mp3' }, { warp: { targetBpm: 128 } }, {
      runTask: async (model, input) => {
        calls.push({ model, input });
        return { provider: 'runpod-voice', result: { status: 'success', result: { stemsUploaded: FIVE, stemSet: FIVE, melodyAvailable: true, notes: [], warp: { applied: true } } } };
      },
      storage,
      writeLibrary: lib.writer,
      newJobId: () => 'job1',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe('bs-roformer-sw-6stem');
    expect(calls[0].input.audio).toBe(AUDIO.toString('base64'));
    expect(Object.keys(calls[0].input.outputUrls as object)).toEqual(FIVE);
    expect(calls[0].input.warp).toEqual({ targetBpm: 128 });
    expect(calls[0].input.inlineMaxSeconds).toBeUndefined();
    expect(stored.size).toBe(0);
    expect(res.stems.vocals).toBe(`https://pub.example/${stemObjectKey('job1', 'My Song.mp3', 'vocals')}`);
    expect(res.mode).toBe('5stem');
    expect(res.storage).toBe('r2');
    expect(JSON.stringify(res)).not.toMatch(/[A-Za-z0-9+/]{200,}/); // kein Base64
    expect(lib.entries.map((e) => e.entry.key)).toEqual(FIVE);
    expect(lib.entries[0].entry.tags).toContain('warped');
    expect(res.librarySaved).toBe(true);
  });

  it('ohne R2: Base64 vom Pod landet in der Server-Ablage, Client bekommt URLs', async () => {
    const { storage, stored } = memoryStorage(false);
    const lib = libraryCollector();
    const stems = Object.fromEntries(FIVE.map((k) => [k, Buffer.from(`wav-${k}`).toString('base64')]));
    const res = await separateOnRp5({ data: AUDIO, filename: 'a.wav' }, {}, {
      runTask: async (_m, input) => {
        expect(input.outputUrls).toBeUndefined();
        expect(typeof input.inlineMaxSeconds).toBe('number');
        return { provider: 'runpod-voice', result: { stems, melodyAvailable: true } };
      },
      storage,
      writeLibrary: lib.writer,
      newJobId: () => 'job2',
    });
    expect(stored.get(stemObjectKey('job2', 'a.wav', 'lows'))?.toString()).toBe('wav-lows');
    expect(res.stems.lows).toBe('/api/media/uploads/job2-a-lows.wav');
    expect(res.storage).toBe('server');
    expect(lib.entries.every((e) => e.storage === 'server')).toBe(true);
  });

  it('4-Stem-Fallback-Modell: leere Melodie nicht in die Bibliothek', async () => {
    const { storage } = memoryStorage(true);
    const lib = libraryCollector();
    const res = await separateOnRp5({ data: AUDIO, filename: 'a.wav' }, {}, {
      runTask: async () => ({ provider: 'p', result: { stemsUploaded: FIVE, melodyAvailable: false, notes: ['Melodie leer'] } }),
      storage,
      writeLibrary: lib.writer,
    });
    expect(res.melodyAvailable).toBe(false);
    expect(lib.entries.map((e) => e.entry.key)).toEqual(['vocals', 'lows', 'mids', 'highs']);
  });

  it('unvollstaendige Ablage ist ein Fehler, kein halbes Ergebnis', async () => {
    const { storage } = memoryStorage(true);
    await expect(separateOnRp5({ data: AUDIO, filename: 'a.wav' }, {}, {
      runTask: async () => ({ provider: 'p', result: { stemsUploaded: ['vocals'] } }),
      storage,
      writeLibrary: async () => {},
    })).rejects.toThrow(/lows/);
  });
});

describe('classifyStemFailure', () => {
  it('Pod fehlt -> 503 STEM_POD_UNAVAILABLE mit Hinweis', () => {
    for (const code of ['NO_PROVIDER', 'POD_NOT_CONFIGURED', 'NO_POD_TOKEN', 'POD_WAKE_BUDGET']) {
      const f = classifyStemFailure(Object.assign(new Error('x'), { code }), 'bs-roformer-sw-6stem');
      expect(f.httpStatus, code).toBe(503);
      expect(f.code).toBe('STEM_POD_UNAVAILABLE');
      expect(f.hint).toMatch(/runpod-pods\.py/);
    }
  });
  it('Gewichte/Modell fehlen -> 503 STEM_MODEL_UNAVAILABLE mit Spiegel-Hinweis', () => {
    const f = classifyStemFailure(Object.assign(new Error('model unavailable'), { code: 'MODEL_UNAVAILABLE' }), 'bs-roformer-sw-6stem');
    expect(f.httpStatus).toBe(503);
    expect(f.code).toBe('STEM_MODEL_UNAVAILABLE');
    expect(f.hint).toMatch(/weights-mirror\.py/);
  });
  it('sonstiges -> 502', () => {
    expect(classifyStemFailure(new Error('boom'), 'm').httpStatus).toBe(502);
  });
});

describe('parseWarpFields', () => {
  it('liest Ziel/Quelle, warp=0 schaltet ab, Unsinn wird abgelehnt', () => {
    expect(parseWarpFields({})).toBeNull();
    expect(parseWarpFields({ targetBpm: '128', targetKey: 'Am' })).toEqual({ targetBpm: 128, targetKey: 'Am' });
    expect(parseWarpFields({ targetBpm: '128', warp: '0' })).toBeNull();
    expect(parseWarpFields({ sourceBpm: '120' })).toBeNull(); // ohne Ziel kein Warp
    expect(() => parseWarpFields({ targetBpm: 'schnell' })).toThrow();
    expect(() => parseWarpFields({ targetBpm: '1000' })).toThrow();
    expect(() => parseWarpFields({ targetKey: 'H-Dur; rm -rf' })).toThrow();
  });
});

describe('ingestFourStems (stem-ai, ehrlicher 4-Stem-Modus)', () => {
  it('holt die Dateien vom Dienst, legt sie ab, kennzeichnet 4 Stems', async () => {
    const { storage, stored } = memoryStorage(false);
    const lib = libraryCollector();
    const fetched: string[] = [];
    const fetchFn = (async (url: string) => {
      fetched.push(url);
      return new Response(Buffer.from('wav'), { status: 200 });
    }) as unknown as typeof fetch;
    const res = await ingestFourStems('http://stem-ai:8000/', {
      stems: { vocals: '/stem-file/t/vocals.wav', bass: '/stem-file/t/bass.wav', drums: '/stem-file/t/drums.wav', other: '/stem-file/t/other.wav', evil: 'http://x' },
      model: 'htdemucs',
    }, 'x.wav', { fetchFn, storage, writeLibrary: lib.writer, newJobId: () => 'j' });
    expect(fetched).toEqual(['vocals', 'bass', 'drums', 'other'].map((k) => `http://stem-ai:8000/stem-file/t/${k}.wav`));
    expect(res.mode).toBe('4stem');
    expect(res.stemSet).toEqual(['vocals', 'bass', 'drums', 'other']);
    expect(res.melodyAvailable).toBe(false);
    expect(stored.size).toBe(4);
    expect(res.notes[0]).toMatch(/4-Stem-Modus/);
    expect(lib.entries).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------
let server: Server | null = null;
afterEach(async () => {
  delete process.env.ENABLE_STEMS;
  delete process.env.STEM_AI_URL;
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = null;
});

async function startApp(overrides: Partial<StemDeps>, fields: Record<string, string> = {}): Promise<string> {
  const app = express();
  const metrics = { stemRequests: 0, stemFailures: 0 };
  registerStemRoutes(app, {
    STEM_MAX_JOBS: 2,
    fleetTargets: {},
    metrics,
    parseMultipartStream: async () => ({ fields, files: [{ name: 'file', filename: 'song.wav', contentType: 'audio/wav', data: AUDIO }] }),
    ...overrides,
  });
  server = app.listen(0);
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('kein Port');
  return `http://127.0.0.1:${addr.port}`;
}

function post(base: string) {
  const fd = new FormData();
  fd.append('file', new Blob([new Uint8Array(AUDIO)], { type: 'audio/wav' }), 'song.wav');
  return fetch(`${base}/api/separate-stems`, { method: 'POST', body: fd });
}

describe('POST /api/separate-stems (RP5-Weg)', () => {
  it('auto mit RP5: 5 Stems als URLs', async () => {
    const { storage } = memoryStorage(true);
    const base = await startApp({
      rp5Available: () => true,
      runStemTask: async () => ({ provider: 'runpod-voice', result: { stemsUploaded: FIVE, melodyAvailable: true } }),
      storage,
      writeLibrary: async () => {},
    }, { targetBpm: '124' });
    const res = await post(base);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.provider).toBe('rp5');
    expect(body.model).toBe('bs-roformer-sw-6stem');
    expect(Object.keys(body.stems)).toEqual(FIVE);
    expect(body.library).toHaveLength(5);
  });

  it('Gewichte fehlen auf dem Pod: 503 mit klarer Meldung, KEIN Rueckfall auf stem-ai', async () => {
    process.env.ENABLE_STEMS = '1';
    process.env.STEM_AI_URL = 'http://127.0.0.1:9';
    const base = await startApp({
      rp5Available: () => true,
      runStemTask: async () => { throw Object.assign(new Error('model unavailable'), { code: 'MODEL_UNAVAILABLE' }); },
      storage: memoryStorage(true).storage,
      writeLibrary: async () => {},
    });
    const res = await post(base);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe('STEM_MODEL_UNAVAILABLE');
    expect(body.fourStemAvailable).toBe(true);
    expect(body.stems).toBeUndefined();
  });

  it('mode=5stem ohne RP5: 503 STEM_POD_UNAVAILABLE', async () => {
    const base = await startApp({ rp5Available: () => false, runStemTask: async () => { throw new Error('darf nicht laufen'); } }, { mode: '5stem' });
    process.env.ENABLE_STEMS = '1';
    process.env.STEM_AI_URL = 'http://127.0.0.1:9';
    const res = await post(base);
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe('STEM_POD_UNAVAILABLE');
  });

  it('ungueltige Warp-Felder: 400', async () => {
    const base = await startApp({ rp5Available: () => true, runStemTask: async () => { throw new Error('darf nicht laufen'); } }, { targetBpm: 'schnell' });
    const res = await post(base);
    expect(res.status).toBe(400);
  });

  it('ungueltiger mode: 400', async () => {
    const base = await startApp({ rp5Available: () => true }, { mode: '7stem' });
    expect((await post(base)).status).toBe(400);
  });
});
