import dotenv from 'dotenv';
dotenv.config();
import { createClient } from '@supabase/supabase-js';
import { embedText } from '../src/core/ai/orchestrator/textEmbedding';
import { supabaseServerKey } from '../src/config/supabaseKeys';

async function main() {
  const url = process.env.SUPABASE_URL!;
  // Zentrale Prioritätsordnung: Service-Role/Secret vor dem (toten) Legacy-PAT.
  const key = supabaseServerKey();
  if (!url || !key) {
    console.error('❌ SUPABASE_URL / SUPABASE_SERVICE_ROLE fehlen in der .env.');
    process.exit(1);
  }
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
