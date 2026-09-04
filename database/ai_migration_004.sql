-- ============================================================================
-- audioMONASTRY · AI-Infrastruktur – Supabase-Migration 004
-- ============================================================================
-- Version: 004 · Datum: 2026-09-03
-- Zweck: pgvector Extension in `extensions` Schema (Lint 0014 Compliance)
-- Grundsätze:
--   - NICHT-destruktiv (create if not exists)
--   - versioniert (Tabelle ai_migrations)
--   - Lädt pgvector in dediziertes `extensions` Schema statt `public`
--   - Alle Referenzen nutzen qualified type: `extensions.vector(...)`
-- Referenz: https://supabase.com/docs/guides/database/extensions/pgvector
-- ============================================================================

insert into public.ai_migrations (version, description)
values ('004', 'pgvector extension in extensions schema (Lint 0014 compliance)')
on conflict (version) do nothing;

-- ============================================================================
-- EXTENSIONS SCHEMA (dediziert für alle Erweiterungen)
-- ============================================================================
create schema if not exists extensions;

-- ============================================================================
-- PGVECTOR EXTENSION (in dediziertem Schema)
-- ============================================================================
-- Installiere pgvector im extensions Schema statt public
create extension if not exists vector
with schema extensions;

-- Sicherheitshinweis: extensions Schema wird nicht über die Supabase API
-- exponiert, daher sind die pgvector-Funktionen und -Operatoren nicht public.

-- ============================================================================
-- ROLLBACK (nur manuell und bewusst ausführen – niemals automatisch):
--   drop schema if exists extensions cascade;
--   delete from public.ai_migrations where version = '004';
-- ============================================================================

-- ============================================================================
-- HINWEISE FÜR ZUKÜNFTIGE ENTWICKLUNG:
-- ============================================================================
-- 1. Beim Erstellen von Tabellen mit Vector-Spalten nutzen Sie qualified types:
--    ```sql
--    create table public.documents (
--      id uuid primary key default gen_random_uuid(),
--      content text not null,
--      embedding extensions.vector(1536),
--      created_at timestamptz not null default now()
--    );
--    ```
--
-- 2. Vector-Indizes mit qualified operator classes:
--    ```sql
--    create index on public.documents
--    using ivfflat (embedding extensions.vector_cosine_ops)
--    with (lists = 100);
--    ```
--
-- 3. Ähnlichkeitssuche mit qualified type casting:
--    ```sql
--    select id, embedding <-> $1::extensions.vector as distance
--    from public.documents
--    order by embedding <-> $1::extensions.vector
--    limit 10;
--    ```
--
-- ============================================================================
