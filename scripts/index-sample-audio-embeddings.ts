/**
 * audioMONASTRY · Batch-Indexer für den Audio-Embedding-Space (AI-P1-003 P4)
 * ==========================================================================
 * Füllt `public.sample_audio_embeddings` (Migration 007, `vector(512)`, CLAP).
 *
 * Warum es diesen Indexer braucht: der TEXT-Pfad (`seed-sample-embeddings.ts`,
 * Migration 005, 256-dim) ist ein anderer Space – pgvector erlaubt pro Spalte
 * nur eine Dimension. Für den AUDIO-Space existierte bisher kein Schreiber,
 * deshalb konnte `match_audio_samples` nie Treffer liefern.
 *
 * Woher das Audio kommt: die Sample-Bibliothek hat KEINE Audiodateien – die
 * Presets sind aus `parameters` synthetisiert. Gerendert wird deshalb offline
 * mit `src/audio/sampleAudioRender.ts`, das exakt den Hörproben-Pfad der App
 * spiegelt (`audioEngine.previewSynthesizedSample`).
 *
 * Voraussetzungen: Migration 007 ist eingespielt; `.env` enthält SB_URL +
 * SB_SERVICE_ROLE sowie die ears-Rolle (RP_ENDPOINT_ID_EARS + RP_API_KEY; die
 * Legacy-Schreibweisen RUNPOD_ENDPOINT_ID_EARS / RUNPOD_API_KEY und die
 * Fallbacks RP_ENDPOINT_ID / RP_AGENT_KEY werden mitgelesen - DB-P1-004).
 *
 * Aufruf:  npx tsx scripts/index-sample-audio-embeddings.ts
 *          INDEX_LIMIT=3 npx tsx scripts/index-sample-audio-embeddings.ts   (Teillauf)
 */
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { PRESET_SAMPLE_DATABASE, type AudioSample } from '../src/data/samples';
import { orchestralSamples } from '../src/data/orchestralLibrary';
import { renderPresetWav } from '../src/audio/sampleAudioRender';
import { RunPodProvider } from '../src/core/ai/orchestrator/runpodProvider';
import {
  CLAP_DIMS,
  CLAP_MODEL,
  parseIndexLimit,
  pickIndexableSamples,
  resolveIndexerConfig,
} from './embeddingIndex';

dotenv.config();

/**
 * Einbettet ein WAV über die ears-Rolle (`audio.embed`, CLAP 512-dim).
 *
 * Bewusst über den kanonischen `RunPodProvider.runLong()` statt per eigenem
 * `fetch`: der Provider kennt Auth, Retry, Fehler-Mapping und vor allem das
 * Polling. `runsync` (der eigene Weg vorher) endet bei einem Kaltstart der
 * Flotte mit `IN_QUEUE` - live gemessen 2026-09-17 endeten zwei Embryos des
 * Batch-Laufs nach 3 Minuten mit `Worker-Fehler: IN_QUEUE`, der Lauf war damit
 * nicht reproduzierbar.
 */
async function embedAudio(wav: Buffer, provider: RunPodProvider): Promise<number[]> {
  const out = (await provider.runLong('audio.embed', CLAP_MODEL, {
    audioBase64: wav.toString('base64'),
  })) as { result?: { embedding?: number[]; dim?: number } } | null;
  const embedding = out?.result?.embedding;
  if (!Array.isArray(embedding) || embedding.length !== CLAP_DIMS) {
    throw new Error(`unerwartete Embedding-Form: ${embedding?.length ?? 'keine'} (erwartet ${CLAP_DIMS})`);
  }
  return embedding;
}

async function main(): Promise<void> {
  const resolved = resolveIndexerConfig(process.env);
  if (!resolved.config) {
    throw new Error(`fehlende Konfiguration in der .env: ${resolved.missing.join(', ')}`);
  }
  const { supabaseUrl: url, supabaseKey: key } = resolved.config;
  const provider = new RunPodProvider('ears');

  const db = createClient(url, key, { auth: { persistSession: false } });
  const all = [...PRESET_SAMPLE_DATABASE, ...orchestralSamples()];
  const { usable, skipped } = pickIndexableSamples<AudioSample>(all);
  const limit = parseIndexLimit(process.env.INDEX_LIMIT);
  const targets = limit > 0 ? usable.slice(0, limit) : usable;

  console.log(`[index] ${targets.length} von ${all.length} Samples indexierbar`
    + (skipped.length ? `, ${skipped.length} ohne Parameter übersprungen` : ''));

  let written = 0;
  const failures: string[] = [];
  for (const [i, sample] of targets.entries()) {
    try {
      const wav = renderPresetWav(sample.parameters);
      const embedding = await embedAudio(wav, provider);
      const { error } = await db.from('sample_audio_embeddings').upsert({
        sample_id: sample.id,
        model: CLAP_MODEL,
        dims: CLAP_DIMS,
        embedding,
      }, { onConflict: 'sample_id' });
      if (error) throw new Error(error.message);
      written += 1;
      console.log(`[index] ${i + 1}/${targets.length} ${sample.id} ✓ (${embedding.length} dims, ${wav.length} B WAV)`);
    } catch (e) {
      failures.push(`${sample.id}: ${(e as Error).message}`);
      console.warn(`[index] ${i + 1}/${targets.length} ${sample.id} ✗ ${(e as Error).message}`);
    }
  }

  const { data: stats, error: statsErr } = await db.rpc('sample_audio_embedding_stats');
  console.log(`\n[index] geschrieben: ${written}/${targets.length}, Fehler: ${failures.length}`);
  if (failures.length) for (const f of failures) console.warn(`  ✗ ${f}`);
  if (statsErr) console.warn(`[index] Stats-RPC fehlgeschlagen: ${statsErr.message}`);
  else console.log(`[index] sample_audio_embedding_stats(): ${JSON.stringify(stats)}`);

  if (written === 0) process.exit(1);
}

main().catch((e: unknown) => {
  console.error('index-sample-audio-embeddings fehlgeschlagen:', (e as Error).message);
  process.exit(1);
});
