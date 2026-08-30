/**
 * scripts/cloud_sync.ts – Einmaliger Abgleich R2 → Supabase
 * =========================================================
 * Listet alle Audio-Objekte im R2-Bucket und pflegt sie mit
 * Kategorien/Tags in Supabase ein.
 *
 * Aufruf:
 *   npx tsx scripts/cloud_sync.ts
 */
import { syncR2ToSupabase, listR2Audio, analyzeAudioKey } from '../server/cloudAutomation';

async function main(): Promise<void> {
  const files = await listR2Audio();
  console.log(`Audio-Objekte in R2: ${files.length}`);

  const preview = files.slice(0, 10).map((f) => {
    const meta = analyzeAudioKey(f.key, f.size);
    return { key: f.key, kind: meta?.kind, type: meta?.type, tags: meta?.tags };
  });
  console.log('Vorschau:');
  for (const p of preview) console.log(' ', p.key, '→', p.kind, p.type, p.tags?.join(','));

  const result = await syncR2ToSupabase();
  console.log('Sync-Ergebnis:', result);
}

main().catch((e) => {
  console.error('Sync fehlgeschlagen:', e);
  process.exit(1);
});
