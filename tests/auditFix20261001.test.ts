/**
 * Regressionstests zu DA-2026-09-29-014 (Content-Type) und DA-2026-09-29-036
 * (Preset-Store): beide Funde waren bis jetzt NICHT durch Tests abgedeckt.
 *
 * Der Upload-Test fährt den ECHTEN Server (wie tests/cloudR2Routes.test.ts) und
 * ersetzt nur den R2-Client durch einen Stub - damit wird die Gross-/Kleinschreibung
 * des S3-Headers genauso geprueft wie in der Produktion.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

type Recorded = { key: string; contentType?: string; bytes: number };

const recorded: Recorded[] = [];

// R2-Stub: nimmt jeden Put an und merkt Key + ContentType. getPresignedUrl braucht
// die Route beim Upload nicht.
vi.mock('../server/r2Client', () => ({
  createR2Client: () => ({
    putObject: async (key: string, body: Buffer, contentType?: string) => {
      recorded.push({ key, contentType, bytes: body?.byteLength ?? 0 });
      return { etag: 'stub-etag', key };
    },
  }),
  r2Status: () => ({ configured: true, bucket: 'test', keysource: 'env' }),
  getPresignedUrl: async () => 'https://example.invalid/stub',
}));

describe('POST /api/cloud/upload – Content-Type kommt serverseitig aus der Endung', () => {
  let server: any;
  let base = '';
  let close = async () => {};

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    // Test-Öffnungsmodus: der Studio-Token wird gelöscht, damit die Route erreichbar ist
    // (identisches Muster wie tests/cloudR2Routes.test.ts).
    delete process.env.STUDIO_ACCESS_TOKEN;
    process.env.CFS3_BUCKET = 'test-bucket';
    process.env.CFS3_ACCOUNT_ID = 'stub';
    process.env.CFS3_ACCESS_KEY_ID = 'stub';
    process.env.CFS3_SECRET_ACCESS_KEY = 'stub';

    const mod = require('../server.ts');
    server = mod.app;
    await new Promise<void>((resolve, reject) => {
      const s = server.listen(0, '127.0.0.1', () => resolve());
      s.on('error', reject);
      close = async () => new Promise<void>((r) => s.close(() => r()));
    });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    await close();
  });

  it('erzwingt audio/wav, wenn der Client text/html schickt (Stored-XSS-Pfad zu)', async () => {
    recorded.length = 0;
    const res = await fetch(`${base}/api/cloud/upload?key=uploads/boese.wav&contentType=text/html`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: new Uint8Array([1, 2, 3, 4]),
    });
    expect(res.status).toBe(200);
    expect(recorded).toHaveLength(1);
    expect(recorded[0].contentType).toBe('audio/wav');
    expect(recorded[0].contentType).not.toBe('text/html');
  });

  it('lehnt Nicht-Audio-Endungen ab (kein .html/.svg im oeffentlichen Bucket)', async () => {
    recorded.length = 0;
    for (const key of ['uploads/boese.html', 'uploads/boese.svg']) {
      const res = await fetch(`${base}/api/cloud/upload?key=${key}`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: new Uint8Array([1, 2, 3]),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: string };
      expect(String(body.error)).toContain('extension');
    }
    // Kein Schreibvorgang darf stattgefunden haben.
    expect(recorded).toHaveLength(0);
  });

  it('leitet den Typ aus der Endung ab (mp3 -> audio/mpeg, auch ohne Angabe des Clients)', async () => {
    recorded.length = 0;
    const res = await fetch(`${base}/api/cloud/upload?key=uploads/track.mp3`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: new Uint8Array([9, 9, 9]),
    });
    expect(res.status).toBe(200);
    expect(recorded[0].contentType).toBe('audio/mpeg');
  });
});

describe('Preset-Store – Validierung beim Einlesen (DA-2026-09-29-036)', () => {
  it('verwirft unbekannte Keys und nichttendliche Zahlen, klemmt Wertebereiche', async () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });

    const mod = await import('../src/utils/presetStore');
    store.set(
      'audiomonastry_local_presets',
      JSON.stringify([
        {
          id: 'p1',
          name: 'Boeses Preset',
          presetData: {
            gain: 999,          // -> auf 12 geklemmt
            pan: -5,            // -> auf -1 geklemmt
            eq: Number.NaN,     // -> verworfen
            vol: Infinity,      // -> verworfen
            '..__proto__x': 1,  // -> ungueltiger Key, verworfen
          },
          geheim: 'sollte weg sein',
          __proto__: { verseucht: true },
        },
        'kein objekt',
        null,
      ]),
    );

    const presets = (await mod.fetchPresetsFromCloud()) as any[];
    expect(presets).toHaveLength(1);
    const p = presets[0];
    expect(p.schemaVersion).toBe(1);
    expect(p.name).toBe('Boeses Preset');
    expect(p.presetData.gain).toBe(12);
    expect(p.presetData.pan).toBe(-1);
    expect(p.presetData.eq).toBeUndefined();
    expect(p.presetData.vol).toBeUndefined();
    expect(Object.keys(p.presetData)).not.toContain('..__proto__x');
    expect(p.geheim).toBeUndefined();
  });

  it('gibt bei kaputtem JSON eine leere Liste statt zu werfen', async () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    store.set('audiomonastry_local_presets', '{kaputt');
    const mod = await import('../src/utils/presetStore');
    await expect(mod.fetchPresetsFromCloud()).resolves.toEqual([]);
  });
});
