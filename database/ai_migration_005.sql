-- ============================================================================
-- audioMONASTRY · AI-Migration 005 – Semantische Bibliotheks-Suche
-- ============================================================================
-- Version: 005 · Datum: 2026-09-03
-- Zweck: Embedding-Tabelle + `match_samples`-RPC für /api/library/search.
-- Voraussetzung: pgvector im `extensions`-Schema (Migration 004).
-- Sicherheit: RLS aktiv, nur service_role (Server-RPC). Kein anon-Zugriff.
-- ============================================================================

begin;

-- Registriere Migration 005
insert into public.ai_migrations (version, description)
values ('005', 'Semantische Bibliotheks-Suche: sample_embeddings + match_samples-RPC')
on conflict (version) do nothing;

-- pgvector sicherstellen (falls Migration 004 noch nicht gelaufen ist)
create extension if not exists vector with schema extensions;

-- Embedding-Tabelle (256-dim Vektor, pgvector im extensions-Schema)
create table if not exists public.sample_embeddings (
  id         uuid primary key default gen_random_uuid(),
  sample_id  text not null unique,
  embedding  extensions.vector(256) not null
);

create index if not exists sample_embeddings_hnsw_idx
  on public.sample_embeddings
  using hnsw (embedding extensions.vector_cosine_ops);

alter table public.sample_embeddings enable row level security;

drop policy if exists "service_all_sample_embeddings" on public.sample_embeddings;
create policy "service_all_sample_embeddings" on public.sample_embeddings
  for all to service_role using (true) with check (true);

-- match_samples-RPC: Kosinus-Ähnlichkeit (<=> = cosine distance)
create or replace function public.match_samples(
  query_embedding extensions.vector,
  match_count integer default 10
)
returns table (sample_id text, similarity double precision)
language sql stable
as $$
  select
    se.sample_id,
    1 - (se.embedding <=> query_embedding) as similarity
  from public.sample_embeddings se
  order by se.embedding <=> query_embedding
  limit match_count;
$$;

revoke all on function public.match_samples(extensions.vector, integer) from public;
grant execute on function public.match_samples(extensions.vector, integer) to service_role;

commit;
