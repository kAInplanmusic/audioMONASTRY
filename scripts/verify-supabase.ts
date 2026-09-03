import dotenv from 'dotenv';
dotenv.config();
import { createClient } from '@supabase/supabase-js';
import { embedText } from '../src/core/ai/orchestrator/textEmbedding';

async function main() {
  const url = process.env.SUPABASE_URL!;
  const key = process.env.SUPABASE_LEGACY_PAT || process.env.SUPABASE_SERVICE_ROLE!;
  const db = createClient(url, key, { auth: { persistSession: false } });
  const { data: migs } = await db.from('ai_migrations').select('version').order('version');
  const { count } = await db.from('sample_embeddings').select('*', { count: 'exact', head: true });
  const { data: matches, error } = await db.rpc('match_samples', {
    query_embedding: embedText('Acid Bass 303'),
    match_count: 3,
  });
  console.log('Migrationen:', (migs ?? []).map((m: any) => m.version).join(', '));
  console.log('sample_embeddings count:', count);
  console.log('match_samples("Acid Bass 303"):', error ? 'FEHLER ' + error.message : JSON.stringify(matches));
}
main();
