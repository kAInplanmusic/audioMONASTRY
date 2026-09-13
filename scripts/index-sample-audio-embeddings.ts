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
 * Voraussetzungen: Migration 007 ist eingespielt; `.env` enthält SUPABASE_URL +
 * Service-Role-Key sowie RUNPOD_ENDPOINT_ID_EARS + RUNPOD_API_KEY.
 *
 * Aufruf:  npx tsx scripts/index-sample-audio-embeddings.ts
 *          INDEX_LIMIT=3 npx tsx scripts/index-sample-audio-embeddings.ts   (Teillauf)
 */
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { PRESET_SAMPLE_DATABASE, type AudioSample } from '../src/data/samples';
import { orchestralSamples } from '../src/data/orchestralLibrary';
import { supabaseServerKey } from '../src/config/supabaseKeys';
import { renderPresetWav } from '../src/audio/sampleAudioRender';

dotenv.config();

const CLAP_MODEL = 'clap-music';
const CLAP_DIMS = 512;

interface EmbedConfig {
  endpointId: string;
  apiKey: string;
}

/** Einbettet ein WAV über den ears-Endpoint (`task=embed`, CLAP 512-dim). */
async function embedAudio(wav: Buffer, cfg: EmbedConfig): Promise<number[]> {
  const body = JSON.stringify({
    input: {
      task: 'embed',
      model: CLAP_MODEL,
      input: { audioBase64: wav.toString('base64') },
    },
  });
  const resp = await fetch(`https://api.runpod.ai/v2/${cfg.endpointId}/runsync`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(600_000),
  });
  if (!resp.ok) throw new Error(`runsync HTTP ${resp.status}`);
  const payload = (await resp.json()) as { status?: string; output?: Record<string, unknown> };
  const out = payload.output ?? {};
  // Job-Status COMPLETED sagt nichts über den Worker-Ausgang (siehe
  // runpod-smoke.py): ein Fehler steckt in output.status/code.
  if (payload.status !== 'COMPLETED' || out.status === 'error' || out.code) {
    throw new Error(`Worker-Fehler: ${String(out.code ?? payload.status)} (${String(out.message ?? '')})`);
  }
  const result = (out.result ?? {}) as { embedding?: number[]; dim?: number };
  const embedding = result.embedding;
  if (!Array.isArray(embedding) || embedding.length !== CLAP_DIMS) {
    throw new Error(`unerwartete Embedding-Form: ${embedding?.length ?? 'keine'} (erwartet ${CLAP_DIMS})`);
  }
  return embedding;
}

/** Nur Einträge mit renderbaren Parametern sind indexierbar. */
function renderable(samples: AudioSample[]): { usable: AudioSample[]; skipped: AudioSample[] } {
  const usable: AudioSample[] = [];
  const skipped: AudioSample[] = [];
  for (const s of samples) {
    (s.parameters && typeof s.parameters === 'object' ? usable : skipped).push(s);
  }
  return { usable, skipped };
}

async function main(): Promise<void> {
  const url = (process.env.SB_URL ?? process.env.SUPABASE_URL ?? '').trim();
  const key = supabaseServerKey();
  const endpointId = (process.env.RUNPOD_ENDPOINT_ID_EARS ?? '').trim();
  const apiKey = (process.env.RUNPOD_API_KEY ?? process.env.RP_API_KEY ?? '').trim();
  if (!url || !key) throw new Error('SB_URL / SB_SERVICE_ROLE fehlen in der .env');
  if (!endpointId || !apiKey) throw new Error('RUNPOD_ENDPOINT_ID_EARS / RUNPOD_API_KEY fehlen in der .env');

  const db = createClient(url, key, { auth: { persistSession: false } });
  const all = [...PRESET_SAMPLE_DATABASE, ...orchestralSamples()];
  const { usable, skipped } = renderable(all);
  const limit = Number(process.env.INDEX_LIMIT ?? 0);
  const targets = limit > 0 ? usable.slice(0, limit) : usable;

  console.log(`[index] ${targets.length} von ${all.length} Samples indexierbar`
    + (skipped.length ? `, ${skipped.length} ohne Parameter übersprungen` : ''));

  let written = 0;
  const failures: string[] = [];
  for (const [i, sample] of targets.entries()) {
    try {
      const wav = renderPresetWav(sample.parameters);
      const embedding = await embedAudio(wav, { endpointId, apiKey });
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
