-- ============================================================================
-- audioMONASTRY · AI-Migration 008 – VisualMONK-Selbstlern-Loop
-- ============================================================================
-- Version: 008 · Datum: 2026-09-11
-- Zweck: Generierte Visuals + Nutzer-Feedback dauerhaft ablegen, damit die
--        VisualMONK-Show dazulernt (beste Prompts/Stile bevorzugen) und
--        aehnliche Bilder wiedergefunden werden koennen.
--
-- Bausteine:
--   * public.visual_generations  – jede Generierung (Prompt, Stil, Seed, R2)
--   * public.visual_feedback     – Bewertung je Nutzer (Session-Ende-Umfrage)
--   * public.visual_embeddings   – CLIP-Bild-Embedding (eigener Vektorraum)
--   * RPC match_visuals(embedding, count) – Aehnlichkeitssuche
--
-- Abgrenzung: Der TEXT-Embedding-Raum bleibt `sample_embeddings` (vector(256));
-- der AUDIO-Raum bleibt `sample_audio_embeddings` (vector(512), Migration 007).
-- Visuals bekommen einen EIGENEN Raum (pgvector erlaubt pro Spalte nur EINE
-- Dimension).
--
-- Sicherheit: RLS aktiv, nur service_role (Server). Kein anon-Zugriff.
-- ============================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- 1) Generierungen
-- ---------------------------------------------------------------------------
create table if not exists public.visual_generations (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  session_id    text,
  user_id       text,
  role          text not null default 'vision',
  model         text,
  prompt        text not null,
  style         text,
  energy        double precision,
  bpm           double precision,
  seed          bigint,
  r2_key        text,
  r2_url        text,
  duration_ms   integer
);

create index if not exists visual_generations_created_idx on public.visual_generations (created_at desc);
create index if not exists visual_generations_style_idx   on public.visual_generations (style);

-- ---------------------------------------------------------------------------
-- 2) Feedback (Session-Ende-Umfrage; der Kern des Selbstlernens)
-- ---------------------------------------------------------------------------
create table if not exists public.visual_feedback (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  generation_id  uuid references public.visual_generations(id) on delete cascade,
  user_id        text,
  session_id     text,
  rating         smallint not null check (rating between 1 and 5),
  keep           boolean not null default true,
  tags           text[] not null default '{}',
  comment        text,
  unique (generation_id, user_id)
);

create index if not exists visual_feedback_generation_idx on public.visual_feedback (generation_id);
create index if not exists visual_feedback_rating_idx     on public.visual_feedback (rating);

-- ---------------------------------------------------------------------------
-- 3) Embeddings (CLIP-Bildraum; 512 Dimensionen wie CLAP-Text/Bild-Bruecke)
-- ---------------------------------------------------------------------------
create table if not exists public.visual_embeddings (
  generation_id  uuid primary key references public.visual_generations(id) on delete cascade,
  created_at     timestamptz not null default now(),
  model          text not null,
  dims           integer not null,
  embedding      vector(512) not null
);

create index if not exists visual_embeddings_hnsw_idx
  on public.visual_embeddings using hnsw (embedding vector_cosine_ops);

-- ---------------------------------------------------------------------------
-- 4) Aehnlichkeitssuche
-- ---------------------------------------------------------------------------
create or replace function public.match_visuals(
  query_embedding vector(512),
  match_count integer default 12,
  min_rating integer default 0
)
returns table (
  generation_id uuid,
  prompt text,
  style text,
  r2_url text,
  rating numeric,
  similarity double precision
)
language sql stable
as $$
  select
    g.id,
    g.prompt,
    g.style,
    g.r2_url,
    coalesce(avg(f.rating), 0)::numeric as rating,
    1 - (e.embedding <=> query_embedding) as similarity
  from public.visual_embeddings e
  join public.visual_generations g on g.id = e.generation_id
  left join public.visual_feedback f on f.generation_id = g.id
  group by g.id, g.prompt, g.style, g.r2_url, e.embedding
  having coalesce(avg(f.rating), 0) >= min_rating
  order by e.embedding <=> query_embedding
  limit greatest(1, least(match_count, 100));
$$;

-- ---------------------------------------------------------------------------
-- 5) RLS: nur service_role (Server-RPC)
-- ---------------------------------------------------------------------------
alter table public.visual_generations enable row level security;
alter table public.visual_feedback   enable row level security;
alter table public.visual_embeddings enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'visual_generations' and policyname = 'visual_generations_service_only') then
    create policy visual_generations_service_only on public.visual_generations
      for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'visual_feedback' and policyname = 'visual_feedback_service_only') then
    create policy visual_feedback_service_only on public.visual_feedback
      for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'visual_embeddings' and policyname = 'visual_embeddings_service_only') then
    create policy visual_embeddings_service_only on public.visual_embeddings
      for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 6) Auswertung: bester Stil je Energie-Bucket (Grundlage fuer Prompt-Vorschlaege)
-- ---------------------------------------------------------------------------
create or replace view public.visual_style_ranking as
  select
    g.style,
    count(*)                    as generations,
    round(avg(f.rating), 2)     as avg_rating,
    count(f.id)                 as feedback_count
  from public.visual_generations g
  left join public.visual_feedback f on f.generation_id = g.id
  group by g.style
  order by avg_rating desc nulls last, generations desc;

commit;
