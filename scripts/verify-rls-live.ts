#!/usr/bin/env tsx
/**
 * audioMONASTRY · Live-Abgleich des RLS-Zustands (DB-P2-002)
 * ==========================================================
 * Hält den Soll-Zustand aus dem Repo gegen das Ist der laufenden Datenbank.
 *
 * WARUM DAS GEBRAUCHT WIRD: Am 2026-09-23 lag die RLS-Härtung `RC1-004` seit
 * Iteration 2 committet im Repo und war **nie angewendet** worden. Live durfte
 * `anon` weiterhin SELECT auf 13 Tabellen, darunter `system_prompts` und
 * `ai_evaluations` — der anon-Key liegt im öffentlichen Bundle. Alle Gates waren
 * grün, weil `tests/supabaseRls.test.ts` die MigrationsDATEIEN prüft. Eine
 * Migrationsdatei ist kein Vollzug; dieser Aufruf ist der fehlende Messpunkt.
 *
 * BENÖTIGT ZUGANGSDATEN und läuft deshalb NICHT im normalen `verify`:
 *   SB_URL              Supabase-Projekt-URL
 *   SB_SERVICE_ROLE     Service-Role-Schlüssel (die Funktion ist nur dafür freigegeben)
 *
 * Aufruf:  npm run verify:rls-live
 * Rückgabe: exit 0 = Vertrag erfüllt, exit 1 = Verstoß, exit 2 = nicht messbar.
 */
import { createClient } from '@supabase/supabase-js';
import { checkRlsContract, formatRlsSummary, summarizeRls, type RlsReportRow } from '../server/rlsContract';

function readEnv(name: string): string {
  return String(process.env[name] ?? '').trim();
}

async function main(): Promise<number> {
  const url = readEnv('SB_URL') || readEnv('SUPABASE_URL');
  const key = readEnv('SB_SERVICE_ROLE') || readEnv('SB_SECRET') || readEnv('SUPABASE_SERVICE_ROLE');

  if (!url || !key) {
    console.error(
      '❌ RLS-Live-Abgleich nicht messbar: SB_URL und SB_SERVICE_ROLE muessen gesetzt sein.\n' +
        '   Das ist KEIN bestandener Test - nur ein fehlender Messwert.',
    );
    return 2;
  }

  const db = createClient(url, key, { auth: { persistSession: false } });
  const { data, error } = await db.rpc('rls_contract_report');

  if (error) {
    console.error(`❌ RPC rls_contract_report fehlgeschlagen: ${error.message}`);
    if (/does not exist|schema cache/i.test(error.message)) {
      console.error('   Die Messfunktion fehlt in dieser Datenbank. Einspielen:');
      console.error('   supabase/migrations/014_rls_contract_report.sql');
    }
    return 2;
  }

  const rows = (data ?? []) as RlsReportRow[];
  const verstoesse = checkRlsContract(rows);
  const summary = summarizeRls(rows);

  console.log('=== RLS-Live-Abgleich (DB-P2-002) ===');
  console.log(`Projekt: ${url}`);
  console.log(formatRlsSummary(summary, verstoesse));
  console.log('');

  if (verstoesse.length > 0) {
    console.error('❌ VERTRAG VERLETZT — die Dateien im Repo beschreiben einen anderen Zustand');
    console.error('   als die Datenbank. Das ist genau der Fall RC1-004 vom 2026-09-23.');
    return 1;
  }

  console.log('✅ Vertrag erfuellt: anon liest genau die Tabellen, die der Browser braucht, und RLS ist ueberall aktiv.');
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error('❌ Abgleich abgebrochen:', error);
    process.exit(2);
  });
