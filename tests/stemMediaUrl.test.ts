/**
 * STEM-2026-11-06-001: Stem-URLs kommen same-origin aus `/api/media/r2/<key>`.
 *
 * Warum es diesen Test gibt: `server/stemSeparation.ts` baute die Stem-URL aus
 * `config.publicBaseUrl` (`CFR2_PUBLIC_URL`, also `pub-*.r2.dev`) bzw. aus dem
 * S3-Host `<bucket>.<account>.r2.cloudflarestorage.com`. Der Bucket ist seit
 * 2026-11-06 privat: die pub-URL antwortet mit 403, der S3-Host verlangt eine
 * Signatur - beides ist keine Wiedergabe-Adresse fuer die App. Dieselbe
 * Fehlerklasse wie der Bank-P0 und MEDIA-2026-11-06-002 (dort schon behoben,
 * `server/cloudAutomation.ts#r2MediaProxyUrl`).
 *
 * Der Pod laedt weiter per Presigned-PUT HOCH (`putUrl`, absoluter S3-Host);
 * nur die URL, die der Client bzw. die Bibliothek sieht, ist same-origin.
 *
 * Lauf: npx vitest run tests/stemMediaUrl.test.ts
 */
process.env.NODE_ENV ??= 'test';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  defaultStemStorage,
  separateOnRp5,
  stemObjectKey,
  type StemLibraryEntry,
} from '../server/stemSeparation';

const FIVE = ['vocals', 'lows', 'mids', 'highs', 'melody'];

const R2_ENV = {
  CFS3_ACCESS_KEY: 'a'.repeat(32),
  CFS3_SECRET_KEY: 'b'.repeat(64),
  CFS3_ENDPOINT: 'https://663ece9f219d4704b826b80715e82034.r2.cloudflarestorage.com',
  CFS3_BUCKET: 'audiomonastrysamples',
  CFR2_ACCOUNT_ID: '663ece9f219d4704b826b80715e82034',
};

const TOUCHED = [
  ...Object.keys(R2_ENV),
  'CFR2_PUBLIC_URL',
  'CFS3_PUBLIC_URL',
  'CFR2_BUCKET',
  'CFR2_ENDPOINT',
  'CFR2_ACCESS_KEY_ID',
  'CFR2_SECRET_ACCESS_KEY',
  'CFR2_ACCESS_KEY',
  'CFR2_SECRET_KEY',
];

const before = Object.fromEntries(TOUCHED.map((k) => [k, process.env[k]]));

function restoreEnv() {
  for (const k of TOUCHED) {
    if (before[k] === undefined) delete process.env[k];
    else process.env[k] = before[k];
  }
}

function configureR2(publicUrl?: string) {
  Object.assign(process.env, R2_ENV);
  if (publicUrl) process.env.CFR2_PUBLIC_URL = publicUrl;
  else delete process.env.CFR2_PUBLIC_URL;
}

const AUDIO = Buffer.from('RIFF....WAVEfmt ');

describe('defaultStemStorage.presignPut: same-origin-URL, Presigned-PUT bleibt absolut', () => {
  beforeEach(() => {
    for (const k of TOUCHED) delete process.env[k];
  });
  afterEach(restoreEnv);

  it('baut /api/media/r2/<key> - auch mit gesetzter CFR2_PUBLIC_URL', () => {
    configureR2('https://pub-663ece9f219d4704b826b80715e82034.r2.dev');
    const key = stemObjectKey('job1', 'My Song.mp3', 'vocals');
    const presigned = defaultStemStorage.presignPut(key);
    expect(presigned).not.toBeNull();
    expect(presigned!.url).toBe(`/api/media/r2/${key}`);
    expect(presigned!.url.startsWith('/api/media/r2/')).toBe(true);
    // Regressionswache: keine oeffentliche R2-Basis, kein S3-Host.
    expect(presigned!.url).not.toMatch(/r2\.dev/);
    expect(presigned!.url).not.toMatch(/cloudflarestorage\.com/);
    expect(presigned!.url).not.toMatch(/^https?:/);
  });

  it('ohne CFR2_PUBLIC_URL ebenfalls same-origin (kein S3-Host als Wiedergabe-URL)', () => {
    configureR2();
    const presigned = defaultStemStorage.presignPut('uploads/stems/job2-a.wav-vocals.wav');
    expect(presigned!.url).toBe('/api/media/r2/uploads/stems/job2-a.wav-vocals.wav');
    expect(presigned!.url).not.toMatch(/cloudflarestorage\.com/);
  });

  it('kodiert den Key segmentweise, Schraegstriche bleiben Pfadtrenner', () => {
    configureR2('https://pub-x.r2.dev');
    const url = defaultStemStorage.presignPut('uploads/stems/job 3-My Song-vocals.wav')!.url;
    expect(url).toBe('/api/media/r2/uploads/stems/job%203-My%20Song-vocals.wav');
    // Schraegstriche bleiben Pfadtrenner, nur die Segmente sind kodiert.
    expect(url.split('/').filter(Boolean)).toHaveLength(6);
    expect(url).not.toContain('%2F');
  });

  it('ein Key ausserhalb der Whitelist wird nicht zur externen URL, sondern abgelehnt', () => {
    // stemObjectKey() erzeugt nur [a-z0-9-] (safeStemBase) - dieser Fall kann im
    // Stem-Pfad nicht entstehen. Er belegt nur: der Guard faellt NICHT auf eine
    // oeffentliche R2-Basis zurueck, wenn doch einmal ein fremder Key kommt.
    configureR2('https://pub-x.r2.dev');
    const url = defaultStemStorage.presignPut('uploads/stems/ä-vocals.wav')!.url;
    expect(url).toBe('/api/media/r2/invalid');
    expect(url).not.toMatch(/r2\.dev|cloudflarestorage\.com/);
  });

  it('der Pod bekommt weiterhin einen signierten PUT auf den S3-Host', () => {
    configureR2('https://pub-x.r2.dev');
    const presigned = defaultStemStorage.presignPut('uploads/stems/job4-a.wav-vocals.wav');
    expect(presigned!.putUrl).toMatch(/^https:\/\/663ece9f219d4704b826b80715e82034\.r2\.cloudflarestorage\.com\//);
    expect(presigned!.putUrl).toMatch(/X-Amz-Signature=/);
    expect(presigned!.putUrl).not.toBe(presigned!.url);
  });

  it('ohne R2-Konfiguration gibt es keinen Presigned-PUT (Base64-Weg)', () => {
    expect(defaultStemStorage.presignPut('uploads/stems/job5-a.wav-vocals.wav')).toBeNull();
  });
});

describe('separateOnRp5 mit defaultStemStorage: Stems und Bibliothek same-origin', () => {
  beforeEach(() => {
    for (const k of TOUCHED) delete process.env[k];
    configureR2('https://pub-663ece9f219d4704b826b80715e82034.r2.dev');
  });
  afterEach(restoreEnv);

  it('alle fuenf Stem-URLs und Bibliothekseintraege beginnen mit /api/media/r2/', async () => {
    const entries: { entry: StemLibraryEntry; storage: string }[] = [];
    const res = await separateOnRp5({ data: AUDIO, filename: 'My Song.mp3' }, {}, {
      runTask: async () => ({ provider: 'runpod-voice', result: { stemsUploaded: FIVE, melodyAvailable: true, notes: [] } }),
      writeLibrary: async (entry, storage) => { entries.push({ entry, storage }); },
      newJobId: () => 'job9',
    });

    expect(res.storage).toBe('r2');
    expect(Object.keys(res.stems)).toEqual(FIVE);
    for (const key of FIVE) {
      expect(res.stems[key], key).toBe(`/api/media/r2/${stemObjectKey('job9', 'My Song.mp3', key)}`);
      expect(res.stems[key], key).not.toMatch(/r2\.dev|cloudflarestorage\.com/);
    }
    expect(entries).toHaveLength(FIVE.length);
    for (const { entry } of entries) {
      expect(entry.url, entry.key).toMatch(/^\/api\/media\/r2\/uploads\/stems\//);
      expect(entry.url, entry.key).not.toMatch(/r2\.dev|cloudflarestorage\.com/);
    }
    // Kein Base64 in der Antwort (unveraendert).
    expect(JSON.stringify(res)).not.toMatch(/[A-Za-z0-9+/]{200,}/);
  });

  it('die Route der App deckt den Stem-Key ab (uploads/-Praefix bleibt erlaubt)', async () => {
    const { isAllowedR2Key } = await import('../server/routes/mediaProxyRoutes');
    expect(isAllowedR2Key(stemObjectKey('job9', 'My Song.mp3', 'vocals'))).toBe(true);
  });
});
