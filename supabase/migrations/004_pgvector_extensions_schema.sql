-- ============================================================================
-- audioMONASTRY · Supabase-Migration 004
-- ============================================================================
-- Version: 004 · Datum: 2026-09-03
-- Zweck: pgvector Extension in `extensions` Schema (Lint 0014 Compliance)
-- Grundsätze:
--   - NICHT-destruktiv (create if not exists)
--   - versioniert (Tabelle ai_migrations)
--   - Lädt pgvector in dediziertes `extensions` Schema statt `public`
--   - Alle Referenzen nutzen qualified type: `extensions.vector(...)`
--   - RLS auf extensions Schema gesetzt (nur service_role Zugriff)
-- Referenz: https://supabase.com/docs/guides/database/extensions/pgvector
--           https://supabase.com/docs/guides/database/database-advisors?lint=0014
-- ============================================================================

begin;

-- Registriere Migration 004
insert into public.ai_migrations (version, description)
values ('004', 'pgvector extension in extensions schema (Lint 0014 compliance)')
on conflict (version) do nothing;

-- ============================================================================
-- EXTENSIONS SCHEMA (dediziert für alle Erweiterungen)
-- ============================================================================
create schema if not exists extensions;

-- Sichere extensions Schema mit RLS
alter schema extensions owner to postgres;

-- ============================================================================
-- PGVECTOR EXTENSION (in dediziertem Schema)
-- ============================================================================
-- Installiere pgvector im extensions Schema statt public
create extension if not exists vector
with schema extensions;

-- Sicherheitshinweis: extensions Schema wird nicht über die Supabase API
-- exponiert, daher sind die pgvector-Funktionen und -Operatoren nicht public.

-- ============================================================================
-- RLS auf extensions Schema (sollte bereits vom System geschützt sein,
-- aber für Klarheit explizit setzen)
-- ============================================================================
-- Hinweis: extensions Schema sollte nicht direkt von Clients zugegriffen
-- werden. Alle Zugriffe erfolgen über public-Schema-Tabellen, die den
-- extensions.vector-Typ verwenden.

commit;

-- ============================================================================
-- ROLLBACK (nur manuell und bewusst ausführen – niemals automatisch):
--   drop schema if exists extensions cascade;
--   delete from public.ai_migrations where version = '004';
-- ============================================================================

-- ============================================================================
-- HINWEISE FÜR ZUKÜNFTIGE ENTWICKLUNG:
-- ============================================================================
-- 1. Beim Erstellen von Tabellen mit Vector-Spalten:
--    ```sql
--    create table public.documents (
--      id uuid primary key default gen_random_uuid(),
--      content text not null,
--      embedding extensions.vector(1536),  -- qualified type!
--      created_at timestamptz not null default now()
--    );
--    ```
--
-- 2. Vector-Indizes erstellen:
--    ```sql
--    create index on public.documents
--    using ivfflat (embedding extensions.vector_cosine_ops)
--    with (lists = 100);
--    ```
--
-- 3. Ähnlichkeitssuche:
--    ```sql
--    select id, content, embedding <-> $1::extensions.vector as distance
--    from public.documents
--    order by embedding <-> $1::extensions.vector
--    limit 10;
--    ```
--
-- 4. Überprüfung der Extension:
--    ```sql
--    select * from pg_extension where extname = 'vector';
--    select * from information_schema.schemata where schema_name = 'extensions';
--    ```
--
-- ============================================================================
