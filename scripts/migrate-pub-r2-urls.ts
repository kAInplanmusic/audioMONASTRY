#!/usr/bin/env tsx
/**
 * MEDIA-2026-11-06-002: Alt-Zeilen mit `pub-*.r2.dev` auf die App-Route umschreiben.
 * ==============================================================================
 * WARUM: `server/cloudAutomation.ts` hat beim Ingest die oeffentliche R2-Basis
 * in `samples.url` / `music_tracks.url` geschrieben. Der Bucket ist privat, die
 * URL antwortet mit 403 - die Zeile zeigt auf eine tote Adresse, und wuerde der
 * Bucket je wieder oeffentlich, waere die Datei direkt verlinkt (an der
 * Studio-Auth vorbei). Der Code ist gefixt; die bereits geschriebenen Zeilen
 * bleiben ohne diesen Lauf tot.
 *
 * UMKREIS, BEWUSST ENG: nur Zeilen, deren `url` mit `https://pub-<hex>.r2.dev/`
 * beginnt. Keine andere Zeile wird angefasst - weder `is_public`, noch
 * `source`, noch URLs auf anderen Hosts. Der Key ist der Pfad hinter dem Host;
 * die neue URL ist `/api/media/r2/<key>` (dieselbe Form wie server/cloud.ts).
 *
 * MODI
 *   npx tsx scripts/migrate-pub-r2-urls.ts            Dry-Run: zeigt Vorher/Nachher
 *   npx tsx scripts/migrate-pub-r2-urls.ts --apply    schreibt die Zeilen
 *
 * SICHERHEIT: jede Aenderung ist an `id` UND die alte `url` gebunden
 * (`.eq('id', …).eq('url', alt)`); hat ein paralleler Lauf die Zeile schon
 * geaendert, trifft das Update 0 Zeilen und wird als Abweichung gemeldet.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { supabaseServerKey } from '../src/config/supabaseKeys';

const APPLY = process.argv.includes('--apply');
const TABELLEN = ['samples', 'music_tracks'] as const;
/** Nur DIESE Form wird umgeschrieben. */
const PUB_HOST = /^pub-[a-z0-9]+\.r2\.dev$/i;

interface Zeile { id: string; url: string }

function ladeEnvDatei(): void {
  let inhalt: string;
  try {
    inhalt = readFileSync(path.join(process.cwd(), '.env'), 'utf8');
  } catch {
    return;
  }
  for (const zeile of inhalt.split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(zeile.trim());
    if (!m) continue;
    const [, name, roh] = m;
    if (process.env[name] !== undefined) continue;
    const wert = roh.trim().replace(/^["']|["']$/g, '');
    if (wert !== '') process.env[name] = wert;
  }
}

/** `https://pub-x.r2.dev/uploads/a b.wav` -> `/api/media/r2/uploads/a%20b.wav` */
export function sameOriginUrl(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!PUB_HOST.test(u.hostname)) return null;
  const key = u.pathname.replace(/^\/+/, '');
  if (!key) return null;
  let encoded: string;
  try {
    encoded = key.split('/').map((s) => encodeURIComponent(decodeURIComponent(s))).join('/');
  } catch {
    return null; // kaputte Prozentkodierung: nicht raten
  }
  return `/api/media/r2/${encoded}`;
}

async function main(): Promise<number> {
  ladeEnvDatei();
  const url = (process.env.SB_URL || process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '').trim();
  const key = supabaseServerKey(process.env as Record<string, string | undefined>);
  if (!url || !key) {
    console.error('❌ SB_URL und Service-Key muessen gesetzt sein (SB_SERVICE_ROLE / SUPABASE_SERVICE_ROLE_KEY).');
    return 2;
  }
  const db = createClient(url, key, { auth: { persistSession: false } });
  console.log(`Projekt: ${url}`);
  console.log(`Modus:   ${APPLY ? 'APPLY (schreibt)' : 'DRY-RUN (schreibt nichts)'}`);

  let gesamtVorher = 0;
  let gesamtNachher = 0;
  let fehler = 0;

  for (const tabelle of TABELLEN) {
    const { data, error } = await db.from(tabelle).select('id,url').like('url', 'https://pub-*.r2.dev/*');
    if (error) {
      console.error(`❌ ${tabelle}: Lesen fehlgeschlagen: ${error.message}`);
      return 2;
    }
    const zeilen = (data ?? []) as Zeile[];
    // Doppelt pruefen: `.like` ist grob, die Host-Form entscheidet.
    const betroffen = zeilen.filter((z) => sameOriginUrl(z.url) !== null);
    console.log(`\n== ${tabelle}`);
    console.log(`   Vorher  pub-*.r2.dev: ${betroffen.length}`);
    gesamtVorher += betroffen.length;

    for (const z of betroffen) {
      const neu = sameOriginUrl(z.url)!;
      if (!APPLY) {
        console.log(`   ~ ${z.id}: ${z.url} -> ${neu}`);
        continue;
      }
      const { data: geaendert, error: schreibFehler } = await db
        .from(tabelle)
        .update({ url: neu })
        .eq('id', z.id)
        .eq('url', z.url)
        .select('id');
      if (schreibFehler) {
        fehler += 1;
        console.error(`   ❌ ${z.id}: ${schreibFehler.message}`);
        continue;
      }
      if (!geaendert || geaendert.length === 0) {
        fehler += 1;
        console.error(`   ⚠️  ${z.id}: 0 Zeilen getroffen (parallel geaendert?) - nicht ueberschrieben`);
        continue;
      }
      console.log(`   ✅ ${z.id}`);
    }

    // Nachher-Zaehlung: erneut messen, nicht aus dem Loop ableiten.
    const { data: rest, error: restFehler } = await db.from(tabelle).select('id,url').like('url', 'https://pub-*.r2.dev/*');
    if (restFehler) {
      console.error(`❌ ${tabelle}: Nachher-Zaehlung fehlgeschlagen: ${restFehler.message}`);
      return 2;
    }
    const restBetroffen = ((rest ?? []) as Zeile[]).filter((z) => sameOriginUrl(z.url) !== null);
    gesamtNachher += restBetroffen.length;
    console.log(`   Nachher pub-*.r2.dev: ${restBetroffen.length}${restBetroffen.length ? ' -> ' + restBetroffen.map((z) => z.id).join(', ') : ''}`);

    // Kontrolle: wie viele Zeilen stehen jetzt auf der App-Route?
    const { count } = await db
      .from(tabelle)
      .select('id', { count: 'exact', head: true })
      .like('url', '/api/media/r2/*');
    console.log(`   Zeilen auf /api/media/r2/: ${count ?? '?'}`);
  }

  console.log('\n== Bilanz');
  console.log(`   pub-*.r2.dev vorher:  ${gesamtVorher}`);
  console.log(`   pub-*.r2.dev nachher: ${gesamtNachher}`);
  console.log(`   Fehler:               ${fehler}`);
  return fehler === 0 && gesamtNachher === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error('❌ Abbruch:', error);
    process.exit(2);
  });
