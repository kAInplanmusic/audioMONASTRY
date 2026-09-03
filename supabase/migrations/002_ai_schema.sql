-- ============================================================================
-- audioMONASTRY · AI-Infrastruktur – Supabase-Migration 002
-- ============================================================================
-- Version: 002 · Datum: 2026-08-31
-- Zweck: Systemprompts & Evaluierung (P3-1 / GAP-5 / GAP-8)
-- Grundsätze:
--   - NICHT-destruktiv (create table if not exists)
--   - versioniert (Tabelle ai_migrations)
--   - Policies werden in Migration 003 definiert
-- Hinweis: Diese Datei ist nur Referenz. Die Migration wurde bereits ausgeführt.
--          Zukünftige Änderungen gehören in 003_ai_policies.sql
-- ============================================================================

begin;

-- Stelle sicher, dass ai_migrations Tabelle existiert (aus Migration 001)
create table if not exists public.ai_migrations (
  version text primary key,
  description text not null,
  applied_at timestamptz not null default now()
);

-- Registriere Migration 002
insert into public.ai_migrations (version, description)
values ('002', 'system_prompts, plugin_prompt_versions, ai_evaluations, ai_eval_runs')
on conflict (version) do nothing;

-- ---------------------------------------------------------------------------
-- System Prompts (Versionierung je Plugin)
-- ---------------------------------------------------------------------------
create table if not exists public.system_prompts (
  id          uuid primary key default gen_random_uuid(),
  plugin_id   text not null,
  role        text not null default 'system',
  version     integer not null default 1,
  content     text not null,
  enabled     boolean not null default true,
  meta        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists system_prompts_plugin_idx on public.system_prompts (plugin_id, version desc);

-- Plugin Prompt Versions (Versionsverlauf je Plugin)
create table if not exists public.plugin_prompt_versions (
  id          uuid primary key default gen_random_uuid(),
  plugin_id   text not null,
  version     integer not null,
  prompt_id   uuid references public.system_prompts(id) on delete set null,
  changelog   text not null default '',
  created_at  timestamptz not null default now(),
  unique (plugin_id, version)
);

create index if not exists plugin_prompt_versions_plugin_idx on public.plugin_prompt_versions (plugin_id);
create index if not exists plugin_prompt_versions_prompt_idx on public.plugin_prompt_versions (prompt_id);

-- ---------------------------------------------------------------------------
-- AI Evaluations (AuditEval/AuditScore-Ergebnisse)
-- HINWEIS: input/output enthalten möglicherweise sensible Daten!
--          RLS ist aktiv, aber NO anon-Policies (siehe 003_ai_policies.sql)
-- ---------------------------------------------------------------------------
create table if not exists public.ai_evaluations (
  id             uuid primary key default gen_random_uuid(),
  plugin_id      text not null,
  task           text not null,
  prompt_version integer not null default 1,
  model          text not null default '',
  provider       text not null default '',
  input          jsonb not null default '{}'::jsonb,
  output         jsonb not null default '{}'::jsonb,
  score          numeric(5, 3) not null default 0,
  metrics        jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now()
);

create index if not exists ai_evaluations_plugin_idx on public.ai_evaluations (plugin_id, created_at desc);

-- AI Evaluation Runs (Batch-Durchläufe)
create table if not exists public.ai_eval_runs (
  run_id      uuid primary key default gen_random_uuid(),
  plugin_id   text not null,
  status      text not null default 'RUNNING',
  summary     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists ai_eval_runs_plugin_idx on public.ai_eval_runs (plugin_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Enable RLS (Policies folgen in Migration 003)
-- ---------------------------------------------------------------------------
alter table public.system_prompts enable row level security;
alter table public.plugin_prompt_versions enable row level security;
alter table public.ai_evaluations enable row level security;
alter table public.ai_eval_runs enable row level security;

-- Hinweis: ai_migrations benötigt auch RLS, aber ohne Policies (geschützt!)
alter table public.ai_migrations enable row level security;

commit;

-- ============================================================================
-- ROLLBACK (nur manuell und bewusst ausführen – niemals automatisch):
--   drop table if exists public.ai_eval_runs;
--   drop table if exists public.ai_evaluations;
--   drop table if exists public.plugin_prompt_versions;
--   drop table if exists public.system_prompts;
--   delete from public.ai_migrations where version = '002';
-- ============================================================================
