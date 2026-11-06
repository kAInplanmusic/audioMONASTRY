/**
 * DB-2026-11-06-001 · Bibliothek kommt vom Server, nicht mehr per anon-REST
 * ========================================================================
 * Der Befund: `samples` und `music_tracks` waren mit dem anon-Key lesbar
 * (RLS `using (true)`), live gemessen 995 + 434 Zeilen. Fix in zwei Teilen:
 *
 *   1. Migration 016 engt die anon-Policies auf `is_public = true` ein
 *      (Bestand: alles false → 0 Zeilen).
 *   2. `GET /api/library` liefert die Bibliothek hinter der Studio-Auth mit
 *      service_role — und zwar nur die Spalten, die die UI braucht.
 *
 * Dieser Test prueft die Naht, die den Fix tragen: die Route (Antwortform,
 * Spaltenwhitelist, 503 ohne Konfiguration, 502 bei Lesefehler) und die
 * statische Zusicherung, dass der Browser KEINEN PostgREST-Leser mehr hat.
 */
process.env.NODE_ENV ??= 'test';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** Steuerung des Supabase-Stubs (wird von den vi.mock-Factories gelesen). */
const stub = {
  url: 'https://stub.supabase.co',
  key: 'service-role-stub-key',
  rows: {} as Record<string, unknown[]>,
  failTable: '' as string,
  selects: [] as string[],
};

vi.mock('../src/config/supabaseKeys', () => ({
  supabaseUrl: () => stub.url,
  supabaseServerKey: () => stub.key,
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from(table: string) {
      const builder = {
        select(cols: string) {
          stub.selects.push(`${table}:${cols}`);
          return builder;
        },
        order() {
          return builder;
        },
        // `readLibraryTable` beendet die Kette mit .range() und awaitet sie.
        range() {
          if (stub.failTable === table) return Promise.resolve({ data: null, error: { message: 'boom' } });
          return Promise.resolve({ data: stub.rows[table] ?? [], error: null });
        },
      };
      return builder;
    },
  }),
}));

const { registerMediaRoutes } = await import('../server/routes/mediaRoutes');

let server: Server;
let baseUrl = '';

beforeAll(async () => {
  const app = express();
  registerMediaRoutes(app);
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  stub.url = 'https://stub.supabase.co';
  stub.key = 'service-role-stub-key';
  stub.failTable = '';
  stub.selects = [];
  stub.rows = {
    samples: [
      { id: 's1', name: 'Kick', category: 'mids', type: 'kick', url: '/api/media/r2/samples/k.wav', description: '', tags: [], parameters: {} },
    ],
    music_tracks: [{ id: 'm1', name: 'Jazz Back', artist: 'Simone Tavazzi', url: '/api/media/r2/music/m.mp3', bpm: 96 }],
  };
});

async function getLibrary(): Promise<{ status: number; body: Record<string, unknown> }> {
  const resp = await fetch(`${baseUrl}/api/library`);
  return { status: resp.status, body: (await resp.json()) as Record<string, unknown> };
}

describe('GET /api/library', () => {
  it('liefert samples und music in einer Antwort', async () => {
    const { status, body } = await getLibrary();
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.samples).toHaveLength(1);
    expect(body.music).toHaveLength(1);
    expect(body.counts).toEqual({ samples: 1, music: 1 });
  });

  it('fragt nur die UI-Spalten ab (kein select *)', async () => {
    await getLibrary();
    expect(stub.selects).toContain('samples:id,name,category,type,url,description,tags,parameters');
    expect(stub.selects).toContain('music_tracks:id,name,artist,url,bpm');
    expect(stub.selects.some((s) => s.endsWith(':*'))).toBe(false);
    // Metadaten, die NICHT ins Browser-JSON gehoeren:
    const sampleCols = stub.selects.find((s) => s.startsWith('samples:')) ?? '';
    for (const column of ['lufs', 'file_size', 'sample_rate', 'artist']) {
      expect(sampleCols).not.toContain(column);
    }
  });

  it('antwortet 503 ohne Supabase-Konfiguration (fail-closed, keine leere Bibliothek)', async () => {
    stub.key = '';
    const { status, body } = await getLibrary();
    expect(status).toBe(503);
    expect(body.ok).toBe(false);
    expect(body.error).toBe('supabase-not-configured');
    expect(body.samples).toEqual([]);
  });

  it('antwortet 502, wenn die Datenbank nicht lesbar ist', async () => {
    stub.failTable = 'music_tracks';
    const { status, body } = await getLibrary();
    expect(status).toBe(502);
    expect(body.ok).toBe(false);
    expect(body.error).toBe('library-read-failed');
  });
});

describe('statische Zusicherung: kein anon-PostgREST-Leser mehr im Browser', () => {
  const clientSource = readFileSync(path.resolve(process.cwd(), 'src/lib/supabaseClient.ts'), 'utf8');

  it('importiert kein PostgREST und liest die Tabellen nicht selbst', () => {
    expect(clientSource).not.toContain('PostgrestClient');
    expect(clientSource).not.toMatch(/\.from\(['"](samples|music_tracks)['"]\)/);
    expect(clientSource).not.toContain('SUPABASE_ANON_PUB');
  });

  it('holt die Bibliothek ueber die Server-Route', () => {
    expect(clientSource).toContain("fetch('/api/library'");
  });

  it('Migration 016 engt anon auf is_public ein statt using (true)', () => {
    const raw = readFileSync(
      path.resolve(process.cwd(), 'supabase/migrations/016_library_rls_private.sql'),
      'utf8',
    ).toLowerCase();
    // Kommentare zaehlen nicht: der Kopf der Datei ZITIERT die alte Freigabe,
    // um sie zu erklaeren. Geprueft wird ausgefuehrtes SQL.
    const migration = raw
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n');
    expect(migration).toContain('add column if not exists is_public boolean not null default false');
    expect(migration).toMatch(/drop policy if exists "anon_read_samples"/);
    expect(migration).toMatch(/drop policy if exists "anon_read_music"/);
    expect(migration).toContain('for select to anon using (is_public = true)');
    // Die alte Freigabe darf im ausgefuehrten SQL nirgends wieder auftauchen.
    expect(migration).not.toMatch(/to anon using \(true\)/);
  });
});
