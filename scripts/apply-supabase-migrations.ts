/**
 * audioMONASTRY · Supabase-Migrationen automatisch einspielen
 * ============================================================
 * Nutzt die Supabase Management API mit einem Personal Access Token
 * (SUPABASE_PAT), um alle SQL-Dateien aus `supabase/migrations/` in der
 * richtigen Reihenfolge auszuführen (idempotente Migrationen).
 *
 * Voraussetzungen in `.env`:
 *   SUPABASE_URL     (https://<ref>.supabase.co)
 *   SUPABASE_PAT     (sbp_...)
 *
 * Aufruf:  npm run supabase:apply
 */
import dotenv from 'dotenv';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

dotenv.config();

async function main(): Promise<void> {
  const url = (process.env.SUPABASE_URL ?? '').trim();
  const pat = (process.env.SUPABASE_PAT ?? '').trim();
  if (!url || !pat) {
    console.error('❌ SUPABASE_URL / SUPABASE_PAT fehlen in der .env.');
    process.exit(1);
  }
  const ref = new URL(url).hostname.split('.')[0];
  const endpoint = `https://api.supabase.com/v1/projects/${ref}/database/query`;

  const dir = path.resolve(process.cwd(), 'supabase/migrations');
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  let failed = 0;

  for (const file of files) {
    const sql = readFileSync(path.join(dir, file), 'utf8');
    console.log(`▶️  ${file}`);
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${pat}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: sql }),
    });
    const text = await resp.text();
    if (resp.ok) {
      console.log(`   ✅ ok`);
    } else {
      failed += 1;
      console.error(`   ❌ ${resp.status}: ${text.slice(0, 300)}`);
    }
  }

  if (failed > 0) {
    console.error(`\n${failed} Migration(en) fehlgeschlagen.`);
    process.exit(1);
  }
  console.log(`\n✅ Alle ${files.length} Migrationen eingespielt.`);
}

main().catch((e) => {
  console.error('supabase:apply fehlgeschlagen:', e);
  process.exit(1);
});
