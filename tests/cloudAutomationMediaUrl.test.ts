/**
 * MEDIA-2026-11-06-002: Kein Ingest-Pfad schreibt eine `pub-*.r2.dev`-URL.
 *
 * Warum es diesen Test gibt: `server/cloudAutomation.ts` hat beim Ingest die
 * oeffentliche R2-Basis in `samples.url`/`music_tracks.url` geschrieben. Der
 * Bucket ist privat, die URL antwortet mit 403 — der Eintrag zeigte also auf
 * eine tote Adresse und waere bei wieder aktivem Public Access eine direkte
 * Verlinkung an der Studio-Auth vorbei. Der Upload-Pfad (`server/cloud.ts`)
 * baut seit 88323dd8 `/api/media/r2/<key>`; dieser Test haelt den Ingest-Pfad
 * auf derselben Form fest.
 *
 * Lauf: npx vitest run tests/cloudAutomationMediaUrl.test.ts
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const writes: { table: string; payload: Record<string, unknown> }[] = [];

const fakeDb = {
  from(table: string) {
    return {
      upsert: async (payload: Record<string, unknown>) => {
        writes.push({ table, payload });
        return { error: null };
      },
      delete: () => ({
        eq: async () => ({ error: null }),
      }),
    };
  },
};

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => fakeDb,
}));

/** Ein formal gueltiger Service-Key (Formpruefung in src/config/supabaseKeys). */
const FAKE_KEY = `sb_secret_${'x'.repeat(40)}`;

describe('Ingest-Pfad schreibt same-origin-URLs', () => {
  beforeEach(() => {
    writes.length = 0;
    process.env.SB_URL = 'https://example.supabase.co';
    process.env.SB_SERVICE_ROLE = FAKE_KEY;
    // Diese duerfen NICHT in die URL einfliessen - der alte Pfad tat es.
    process.env.CFR2_PUBLIC_URL = 'https://pub-663ece9f219d4704b826b80715e82034.r2.dev';
    process.env.CFR2_ACCOUNT_ID = '663ece9f219d4704b826b80715e82034';
    process.env.CFR2_BUCKET = 'audiomonastrysamples';
  });

  it('r2MediaProxyUrl baut die Route der App, nicht die oeffentliche R2-Basis', async () => {
    const { r2MediaProxyUrl } = await import('../server/cloudAutomation');
    expect(r2MediaProxyUrl('uploads/samples/a b.wav')).toBe('/api/media/r2/uploads/samples/a%20b.wav');
    expect(r2MediaProxyUrl('music/Track - Artist.mp3')).toBe('/api/media/r2/music/Track%20-%20Artist.mp3');
    expect(r2MediaProxyUrl('uploads/samples/x.wav')).not.toContain('r2.dev');
    // Unsichere Keys bekommen keine scheinbar gueltige URL.
    expect(r2MediaProxyUrl('../etc/passwd')).toBe('/api/media/r2/invalid');
  });

  it('analyzeAudioKey setzt url auf /api/media/r2/, auch mit gesetzter CFR2_PUBLIC_URL', async () => {
    const { analyzeAudioKey } = await import('../server/cloudAutomation');
    const meta = analyzeAudioKey('samples/kick_01.wav', 1234);
    expect(meta).not.toBeNull();
    expect(meta?.url).toBe('/api/media/r2/samples/kick_01.wav');
    expect(JSON.stringify(meta)).not.toContain('r2.dev');
  });

  it('ingestAudioObject schreibt fuer samples die same-origin-URL in die Zeile', async () => {
    const { ingestAudioObject } = await import('../server/cloudAutomation');
    const res = await ingestAudioObject('uploads/samples/1793901596538-e2e-action-test.wav', 8);
    expect(res.ok).toBe(true);

    const sample = writes.find((w) => w.table === 'samples');
    expect(sample).toBeDefined();
    expect(sample?.payload.url).toBe('/api/media/r2/uploads/samples/1793901596538-e2e-action-test.wav');
    expect(String(sample?.payload.url)).not.toMatch(/r2\.dev|cloudflarestorage\.com/);
  });

  it('ingestAudioObject schreibt fuer music_tracks dieselbe Form', async () => {
    const { ingestAudioObject } = await import('../server/cloudAutomation');
    const res = await ingestAudioObject('music/Artist - Titel.mp3', 4096);
    expect(res.ok).toBe(true);

    const track = writes.find((w) => w.table === 'music_tracks');
    expect(track).toBeDefined();
    expect(track?.payload.url).toBe('/api/media/r2/music/Artist%20-%20Titel.mp3');
    expect(String(track?.payload.url)).not.toContain('r2.dev');
  });

  it('der Quelltext enthaelt keine oeffentliche R2-Basis mehr (Regressionswache)', () => {
    const quelle = readFileSync(path.join(process.cwd(), 'server', 'cloudAutomation.ts'), 'utf8');
    // Kommentare duerfen den Befund erklaeren; der CODE darf die URL nicht bauen.
    const code = quelle
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((zeile) => !zeile.trim().startsWith('//'))
      .join('\n');
    expect(code).not.toMatch(/r2\.dev/);
    expect(code).not.toContain('CFR2_PUBLIC_URL');
    expect(code).not.toContain('cloudflarestorage.com');
  });
});
