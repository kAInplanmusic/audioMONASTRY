#!/usr/bin/env tsx
/**
 * audioMONASTRY · Live-Abgleich des RLS-Zustands (DB-P2-002)
 * ==========================================================
 * Hält den Soll-Zustand aus dem Repo gegen das Ist der laufenden Datenbank —
 * in BEIDE Richtungen:
 *
 *   Ist  -> Vertrag : anon liest genau {samples, music_tracks}, RLS ueberall aktiv
 *   Datei -> Live    : was die Migrationen anlegen/entfernen, muss live so sein
 *
 * WARUM DAS GEBRAUCHT WIRD: Am 2026-09-23 lag die RLS-Haertung `RC1-004` seit
 * Iteration 2 committet im Repo und war **nie angewendet** worden. Live durfte
 * `anon` weiterhin SELECT auf 13 Tabellen, darunter `system_prompts` und
 * `ai_evaluations` — der anon-Key liegt im oeffentlichen Bundle. Alle Gates waren
 * gruen, weil `tests/supabaseRls.test.ts` die MigrationsDATEIEN prueft.
 * Eine Migrationsdatei ist kein Vollzug; dieser Aufruf ist der fehlende Messpunkt.
 *
 * BENOETIGT ZUGANGSDATEN:
 *   SB_URL              Supabase-Projekt-URL
 *   SB_SERVICE_ROLE     Service-Role-Schluessel (die Messfunktion ist nur dafuer frei)
 *
 * MODI
 *   npm run verify:rls-live          Abgleich; exit 0 = erfuellt, 1 = Verstoss,
 *                                    2 = nicht messbar (fehlende Zugangsdaten/Funktion)
 *   npm run verify:rls-live -- --gate  wie oben, ABER: fehlen die Zugangsdaten,
 *                                    wird ausdruecklich UEBERSPRUNGEN (exit 0) statt
 *                                    zu scheitern. Fuer die Pruefkette: laeuft, wo
 *                                    gemessen werden KANN, und schweigt sonst -
 *                                    aber es sagt, dass es schweigt.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { checkRlsContract, formatRlsSummary, summarizeRls, type RlsReportRow } from '../server/rlsContract';

const GATE = process.argv.includes('--gate');

/**
 * `.env` selbst einlesen.
 *
 * Ohne das misst das Skript im Gate nichts: `npm run` reicht keine .env durch,
 * und `process.env` ist auf dem Entwicklungsrechner leer. Gelesen wird nur, was
 * noch nicht gesetzt ist - eine echte Umgebungsvariable hat Vorrang.
 */
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

/**
 * Die ANGEWENDETE Migrationsmenge. `database/` bleibt bewusst draussen: das ist
 * der historische, nicht angewendete Satz (siehe database/README.md) mit
 * ueberlappenden Nummern. Wuerde man ihn mitlesen, entstuenden Scheinwidersprueche.
 */
function migrationsDateien(): { name: string; sql: string }[] {
  const ordner = path.join(process.cwd(), 'supabase', 'migrations');
  return readdirSync(ordner)
    .filter((n) => n.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, sql: readFileSync(path.join(ordner, name), 'utf8') }));
}

function readEnv(name: string): string {
  return String(process.env[name] ?? '').trim();
}

async function main(): Promise<number> {
  ladeEnvDatei();
  const url = readEnv('SB_URL') || readEnv('SUPABASE_URL');
  const key = readEnv('SB_SERVICE_ROLE') || readEnv('SB_SECRET') || readEnv('SUPABASE_SERVICE_ROLE');

  if (!url || !key) {
    if (GATE) {
      console.log('⏭️  RLS-Live-Abgleich UEBERSPRUNGEN: SB_URL/SB_SERVICE_ROLE nicht gesetzt.');
      console.log('    Das ist kein bestandener Test. Auf einem Rechner mit .env (z.B. Hetzner)');
      console.log('    laeuft er mit; ohne Zugangsdaten kann er nichts messen und taeuscht nichts vor.');
      return 0;
    }
    console.error(
      '❌ RLS-Live-Abgleich nicht messbar: SB_URL und SB_SERVICE_ROLE muessen gesetzt sein.\n' +
        '   Das ist KEIN bestandener Test - nur ein fehlender Messwert.',
    );
    return 2;
  }

  const dateien = migrationsDateien();
  const db = createClient(url, key, { auth: { persistSession: false } });
  const { data, error } = await db.rpc('rls_contract_report');

  if (error) {
    console.error(`❌ RPC rls_contract_report fehlgeschlagen: ${error.message}`);
    if (/does not exist|schema cache/i.test(error.message)) {
      console.error('   Die Messfunktion fehlt in dieser Datenbank. Einspielen:');
      console.error('   supabase/migrations/014_rls_contract_report.sql');
    }
    // Im Gate ist "nicht messbar mit vorhandenen Zugangsdaten" ein Fehler:
    // wir HATTEN die Mittel und haben keine Antwort bekommen.
    return GATE ? 1 : 2;
  }

  const rows = (data ?? []) as RlsReportRow[];
  const verstoesse = checkRlsContract(rows, undefined, { dateien });
  const summary = summarizeRls(rows);

  console.log('=== RLS-Live-Abgleich (DB-P2-002) ===');
  console.log(`Projekt:  ${url}`);
  console.log(`Migrationen gelesen: ${dateien.length} Dateien aus supabase/migrations/`);
  console.log(formatRlsSummary(summary, verstoesse));
  console.log('');

  if (verstoesse.length > 0) {
    console.error('❌ VERTRAG VERLETZT — die Dateien im Repo beschreiben einen anderen Zustand');
    console.error('   als die Datenbank. Das ist genau der Fall RC1-004 vom 2026-09-23.');
    return 1;
  }

  console.log('✅ Vertrag erfuellt: anon liest genau die Tabellen, die der Browser braucht, RLS ist');
  console.log('   ueberall aktiv, und die Migrationsdateien decken sich mit der Datenbank.');
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error('❌ Abgleich abgebrochen:', error);
    process.exit(2);
  });
