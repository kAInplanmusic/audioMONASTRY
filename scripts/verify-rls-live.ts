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
 *   SB_ANON_KEY         anon-/publishable-Key fuer die REST-Gegenprobe
 *                       (Fallback: VITE_SUPABASE_ANON_PUB, VITE_SB_ANON_PUB).
 *                       Fehlt er, wird die Gegenprobe als uebersprungen gemeldet -
 *                       der Policy-Bericht allein sagt nur, was DA STEHT.
 *
 * TEST-2026-11-06-002: `rls_contract_report()` liefert seit 014 auch
 * `using_condition`. Die Zusammenfassung bewertet sie jetzt mit: `using (true)`
 * = offen, `using (is_public = true)` = bedingt (Bestand false -> 0 Zeilen).
 * Zusaetzlich fragt die REST-Gegenprobe die Tabellen mit dem anon-Key ab; nur
 * sie belegt, ob eine Bedingung im Bestand wirklich dicht ist.
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
import {
  RLS_CONTRACT,
  checkAnonProbe,
  checkRlsContract,
  formatRlsSummary,
  summarizeRls,
  type AnonProbeRow,
  type RlsReportRow,
} from '../server/rlsContract';

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

/**
 * REST-Gegenprobe mit dem anon-Key.
 *
 * Warum nicht nur `pg_policies`: die Policy beschreibt den Soll-Zustand.
 * `using (is_public = true)` ist im Bestand dicht, obwohl eine anon-Policy
 * existiert - das ist der Befund TEST-2026-11-06-002. Der anon-Key liegt im
 * oeffentlichen Bundle; wer ihn hat, kann genau diese Anfrage stellen. Gemessen
 * wird deshalb mit demselben Key, nicht mit service_role.
 *
 * `limit=1` genuegt: 1 gelieferte Zeile = lesbar, 0 = dicht (oder leer).
 * Fehler werden als `rows: 0` mit Grund gefuehrt, nicht verschwiegen.
 */
async function probeAnonRead(url: string, anonKey: string, tables: readonly string[]): Promise<AnonProbeRow[]> {
  const out: AnonProbeRow[] = [];
  for (const table of tables) {
    const ziel = `${url}/rest/v1/${encodeURIComponent(table)}?select=id&limit=1`;
    try {
      const res = await fetch(ziel, {
        headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}`, Accept: 'application/json' },
      });
      const body = await res.text();
      let rows = 0;
      try {
        const parsed: unknown = JSON.parse(body);
        if (Array.isArray(parsed)) rows = parsed.length;
      } catch {
        // Kein JSON (Fehlerseite) - rows bleibt 0, der Status spricht.
      }
      out.push({
        table,
        status: res.status,
        rows: res.ok ? rows : 0,
        error: res.ok ? undefined : body.replace(/\s+/g, ' ').slice(0, 120),
      });
    } catch (error) {
      out.push({ table, status: 0, rows: 0, error: String(error).slice(0, 120) });
    }
  }
  return out;
}

async function main(): Promise<number> {
  ladeEnvDatei();
  const url = readEnv('SB_URL') || readEnv('SUPABASE_URL') || readEnv('VITE_SUPABASE_URL');
  const key =
    readEnv('SB_SERVICE_ROLE') ||
    readEnv('SB_SECRET') ||
    readEnv('SUPABASE_SERVICE_ROLE') ||
    readEnv('SUPABASE_SERVICE_ROLE_KEY');

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

  const anonKey = readEnv('SB_ANON_KEY') || readEnv('VITE_SUPABASE_ANON_PUB') || readEnv('VITE_SB_ANON_PUB') || readEnv('SUPABASE_ANON_KEY');
  const tabellen = [...new Set([...rows.map((r) => r.tablename), ...RLS_CONTRACT.anonReadTables])].sort();
  const probe: AnonProbeRow[] = anonKey
    ? await probeAnonRead(url, anonKey, tabellen)
    : [];
  verstoesse.push(...checkAnonProbe(summary, probe));

  console.log('=== RLS-Live-Abgleich (DB-P2-002) ===');
  console.log(`Projekt:  ${url}`);
  console.log(`Migrationen gelesen: ${dateien.length} Dateien aus supabase/migrations/`);
  console.log(formatRlsSummary(summary, verstoesse, probe));
  if (!anonKey) {
    console.log('');
    console.log('HINWEIS: REST-Gegenprobe UEBERSPRUNGEN — kein anon-Key (SB_ANON_KEY/VITE_SUPABASE_ANON_PUB).');
    console.log('         Der Bericht oben beschreibt dann nur die Policies, nicht den gemessenen Zugriff.');
  }
  console.log('');

  if (verstoesse.length > 0) {
    console.error('❌ VERTRAG VERLETZT — die Dateien im Repo beschreiben einen anderen Zustand');
    console.error('   als die Datenbank. Das ist genau der Fall RC1-004 vom 2026-09-23.');
    return 1;
  }

  if (summary.anonLiestBedingt.length > 0) {
    const gemessen = summary.anonLiestBedingt
      .map((t) => {
        const p = probe.find((x) => x.table === t);
        return p ? `${t}=${p.rows}` : `${t}=?`;
      })
      .join(', ');
    console.log('✅ Vertrag erfuellt: RLS ist ueberall aktiv, anon hat KEINE unbedingte');
    console.log(`   Lesepolicy. Bedingt freigegeben sind ${summary.anonLiestBedingt.join(', ')} —`);
    console.log(`   REST mit dem anon-Key: ${gemessen} Zeilen (0 = dicht).`);
    console.log('   Die Migrationsdateien decken sich mit der Datenbank.');
    return 0;
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
