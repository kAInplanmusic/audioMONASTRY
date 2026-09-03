/**
 * audioMONASTRY · Sample-Embeddings befüllen (Supabase)
 * ======================================================
 * Erzeugt für jeden Eintrag der Preset-Bibliothek + Orchester-CC0-Katalog
 * einen 256-dim Embedding-Vektor (deterministisch via `embedText`) und
 * schreibt ihn per Upsert in `public.sample_embeddings` (Migration 005).
 *
 * Voraussetzungen:
 *   1. Supabase-Migration 005 ist eingespielt (SQL Editor, siehe README/Doku)
 *   2. `.env` enthält SUPABASE_URL + SUPABASE_SERVICE_ROLE
 *
 * Aufruf:  npx tsx scripts/seed-sample-embeddings.ts
 * Bzw.:    npm run supabase:seed-embeddings
 */
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { PRESET_SAMPLE_DATABASE } from '../src/data/samples';
import { orchestralSamples } from '../src/data/orchestralLibrary';
import { embedText } from '../src/core/ai/orchestrator/textEmbedding';

dotenv.config();

async function main(): Promise<void> {
  const url = (process.env.SUPABASE_URL ?? '').trim();
  const key = (process.env.SUPABASE_LEGACY_PAT ?? process.env.SUPABASE_SERVICE_ROLE ?? '').trim();
  if (!url || !key) {
    console.error('❌ SUPABASE_URL / SUPABASE_SERVICE_ROLE fehlen in der .env.');
    process.exit(1);
  }

  const db = createClient(url, key, { auth: { persistSession: false } });
  const samples = [...PRESET_SAMPLE_DATABASE, ...orchestralSamples()];
  let upserted = 0;

  for (const s of samples) {
    const embedding = embedText(`${s.name} ${s.description}`);
    const { error } = await db.from('sample_embeddings').upsert({
      sample_id: s.id,
      embedding,
    }, { onConflict: 'sample_id' });
    if (error) {
      console.warn(`⚠️ ${s.id}:`, error.message);
    } else {
      upserted += 1;
    }
  }

  console.log(`✅ ${upserted}/${samples.length} Sample-Embeddings in public.sample_embeddings geschrieben.`);
  if (upserted === 0) process.exit(1);
}

main().catch((e) => {
  console.error('seed-sample-embeddings fehlgeschlagen:', e);
  process.exit(1);
});
