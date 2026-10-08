/**
 * Regressionstests zu DA-2026-09-29-014 (Content-Type) und DA-2026-09-29-036
 * (Preset-Store): beide Funde waren bis jetzt NICHT durch Tests abgedeckt.
 *
 * Der Upload-Test fährt den ECHTEN Server (wie tests/cloudR2Routes.test.ts) und
 * ersetzt nur den R2-Client durch einen Stub - damit wird die Gross-/Kleinschreibung
 * des S3-Headers genauso geprueft wie in der Produktion.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { storageSet } from '../src/utils/storage';

type Recorded = { key: string; contentType?: string; bytes: number };

const recorded: Recorded[] = [];

// R2-Stub: lokaler S3-kompatibler HTTP-Server (Muster wie tests/cloudR2Routes.test.ts).
// Er merkt sich Key und Content-Type jedes PUT – damit wird der echte S3-Header
// genauso geprueft wie in der Produktion. (Vorher mockte dieser Test ein Modul
// `server/r2Client`, das es nicht gibt – die Route lief deshalb nie gegen den Stub.)
let r2Stub: http.Server;
describe('POST /api/cloud/upload – Content-Type kommt serverseitig aus der Endung', () => {
  let server: any;
  let base = '';
  let close = async () => {};

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    // Test-Öffnungsmodus: der Studio-Token wird gelöscht, damit die Route erreichbar ist
    // (identisches Muster wie tests/cloudR2Routes.test.ts).
    delete process.env.STUDIO_ACCESS_TOKEN;
    process.env.API_RATE_LIMIT_MAX = '1000';
    r2Stub = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        if (req.method === 'PUT') {
          const url = new URL(req.url ?? '/', 'http://stub');
          recorded.push({
            key: decodeURIComponent(url.pathname).split('/').slice(2).join('/'),
            contentType: req.headers['content-type'],
            bytes: Buffer.concat(chunks).byteLength,
          });
          res.writeHead(200, { ETag: '"stub"' });
          res.end();
          return;
        }
        res.writeHead(400).end();
      });
    });
    await new Promise<void>((resolve) => r2Stub.listen(0, '127.0.0.1', resolve));
    process.env.CFS3_ENDPOINT = `http://127.0.0.1:${(r2Stub.address() as AddressInfo).port}`;
    process.env.CFS3_ACCESS_KEY = 'a'.repeat(32);
    process.env.CFS3_SECRET_KEY = 'b'.repeat(64);
    process.env.CFS3_BUCKET = 'test-bucket';
    process.env.R2_SDK_MAX_ATTEMPTS = '1';

    // Wie tests/cloudR2Routes.test.ts: ESM-Import (createRequire loest die
    // endungslosen .ts-Importe des Servers nicht auf).
    const mod = await import('../server');
    await new Promise<void>((resolve, reject) => {
      server = mod.app.listen(0, '127.0.0.1', () => resolve());
      server.on('error', reject);
      close = async () => new Promise<void>((r) => server.close(() => r()));
    });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    await close();
    await new Promise<void>((resolve) => {
      r2Stub.closeAllConnections?.();
      r2Stub.close(() => resolve());
    });
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

    const mod = await import('../src/utils/presetStore');
    // „Nothing on user devices“: Presets liegen im serverseitigen Studio-Store
    // (src/utils/storage.ts), nicht in localStorage.
    storageSet(
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
    storageSet('audiomonastry_local_presets', '{kaputt');
    const mod = await import('../src/utils/presetStore');
    await expect(mod.fetchPresetsFromCloud()).resolves.toEqual([]);
  });
});
