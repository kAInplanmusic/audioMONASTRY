-- ============================================================================
-- audioMONASTRY · AI-Migration 007 – Audio-Embedding-Space (CLAP) für dropMONK
-- ============================================================================
-- Version: 007 · Datum: 2026-09-10
-- Zweck: Ähnlichkeitssuche über AUDIO-Embeddings (dropMONK: „ich habe drei
--        passende Samples gefunden") ohne den bestehenden TEXT-Embedding-Pfad
--        zu beschädigen.
--
-- Ausgangslage / Defekt:
--   * `public.sample_embeddings.embedding` ist `vector(256)` und gehört zum
--     LOKALEN Text-Embedding (`EMBEDDING_DIMS = 256` in
--     `src/core/ai/orchestrator/textEmbedding.ts`). Das ist konsistent und
--     bleibt unverändert.
--   * CLAP (`laion/larger_clap_music`, Task `audio.embed`) liefert 512
--     Dimensionen. pgvector erlaubt pro Spalte nur EINE Dimension – Text- und
--     Audio-Vektoren können sich daher keine Spalte teilen.
--   * Folglich existierte für Audio-Embeddings bisher kein Ablageort: die
--     dropMONK-Sample-Suche über Ähnlichkeit konnte nie Treffer liefern.
--
-- Lösung: eigener Tabellen-/RPC-Satz für den Audio-Space. Der Text-Space bleibt
-- unangetastet (keine Datenmigration, kein Dimensionswechsel).
-- Sicherheit: RLS aktiv, nur service_role (Server-RPC). Kein anon-Zugriff.
-- ============================================================================

begin;

-- Registriere Migration 007
insert into public.ai_migrations (version, description)
values ('007', 'Audio-Embedding-Space (CLAP 512-dim) für dropMONK-Sample-Suche')
on conflict (version) do nothing;

-- pgvector sicherstellen (falls Migration 004 noch nicht gelaufen ist)
create extension if not exists vector;

-- ---------------------------------------------------------------------------
-- Audio-Embeddings (CLAP larger_clap_music, 512 Dimensionen)
-- ---------------------------------------------------------------------------
create table if not exists public.sample_audio_embeddings (
  id          uuid primary key default gen_random_uuid(),
  sample_id   text not null unique,
  -- Herkunft des Vektors: ein Wechsel des Encoders erfordert eine Neuindexierung.
  model       text not null default 'clap-music',
  -- Feste Dimension erzwingt den Abgleich mit dem Encoder.
  dims        integer not null default 512 check (dims = 512),
  embedding   vector(512) not null,
  updated_at  timestamptz not null default now()
);

create index if not exists sample_audio_embeddings_hnsw_idx
  on public.sample_audio_embeddings
  using hnsw (embedding vector_cosine_ops);

alter table public.sample_audio_embeddings enable row level security;

drop policy if exists "service_all_sample_audio_embeddings" on public.sample_audio_embeddings;
create policy "service_all_sample_audio_embeddings" on public.sample_audio_embeddings
  for all to service_role using (true) with check (true);

-- ---------------------------------------------------------------------------
-- match_audio_samples-RPC: Kosinus-Ähnlichkeit im Audio-Raum (<=> = distance)
-- ---------------------------------------------------------------------------
drop function if exists public.match_audio_samples(vector, integer);

create or replace function public.match_audio_samples(
  query_embedding vector(512),
  match_count integer default 10
)
returns table (sample_id text, similarity double precision)
language sql stable
as $$
  select
    se.sample_id,
    1 - (se.embedding <=> query_embedding) as similarity
  from public.sample_audio_embeddings se
  order by se.embedding <=> query_embedding
  limit match_count;
$$;

revoke all on function public.match_audio_samples(vector, integer) from public;
grant execute on function public.match_audio_samples(vector, integer) to service_role;

-- ---------------------------------------------------------------------------
-- Indexierungs-Fortschritt (dropMONK: „sind alle Samples indexiert?")
-- Ohne vollständige Indexierung bleibt die Ähnlichkeitssuche unvollständig –
-- die Zahl ist deshalb explizit abfragbar.
-- ---------------------------------------------------------------------------
create or replace function public.sample_audio_embedding_stats()
returns table (total_indexed bigint, models text[])
language sql stable
as $$
  select count(*)::bigint, coalesce(array_agg(distinct se.model), '{}') from public.sample_audio_embeddings se;
$$;

revoke all on function public.sample_audio_embedding_stats() from public;
grant execute on function public.sample_audio_embedding_stats() to service_role;

commit;
