-- ============================================================================
-- audioMONASTRY · AI-Infrastruktur – Supabase-Migration 002
-- ============================================================================
-- Version: 002 · Datum: 2026-08-31
-- Zweck: Systemprompts & Evaluierung (P3-1 / GAP-5 / GAP-8)
-- Grundsätze:
--   - NICHT-destruktiv (create table if not exists)
--   - versioniert (Tabelle ai_migrations)
--   - RLS analog ai_migration_001 (anon read, service_role write)
-- ============================================================================

insert into public.ai_migrations (version, description)
values ('002', 'system_prompts, plugin_prompt_versions, ai_evaluations, ai_eval_runs')
on conflict (version) do nothing;

-- ----------------------------------------------------------------------------
-- Systemprompts (Versionierung je Plugin)
-- ----------------------------------------------------------------------------
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

create table if not exists public.plugin_prompt_versions (
  id          uuid primary key default gen_random_uuid(),
  plugin_id   text not null,
  version     integer not null,
  prompt_id   uuid references public.system_prompts(id) on delete set null,
  changelog   text not null default '',
  created_at  timestamptz not null default now(),
  unique (plugin_id, version)
);

-- ----------------------------------------------------------------------------
-- Evaluierungen (AuditEval/AuditScore-Ergebnisse)
-- ----------------------------------------------------------------------------
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

create table if not exists public.ai_eval_runs (
  run_id    uuid primary key default gen_random_uuid(),
  plugin_id text not null,
  status    text not null default 'RUNNING',
  summary   jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- RLS (FA-P1-1-Muster): anon read, service_role write
-- ----------------------------------------------------------------------------
alter table public.system_prompts enable row level security;
alter table public.plugin_prompt_versions enable row level security;
alter table public.ai_evaluations enable row level security;
alter table public.ai_eval_runs enable row level security;

drop policy if exists "anon_read_system_prompts" on public.system_prompts;
create policy "anon_read_system_prompts" on public.system_prompts for select to anon using (true);
drop policy if exists "anon_read_plugin_prompt_versions" on public.plugin_prompt_versions;
create policy "anon_read_plugin_prompt_versions" on public.plugin_prompt_versions for select to anon using (true);
drop policy if exists "anon_read_ai_evaluations" on public.ai_evaluations;
create policy "anon_read_ai_evaluations" on public.ai_evaluations for select to anon using (true);
drop policy if exists "anon_read_ai_eval_runs" on public.ai_eval_runs;
create policy "anon_read_ai_eval_runs" on public.ai_eval_runs for select to anon using (true);

drop policy if exists "service_write_system_prompts" on public.system_prompts;
create policy "service_write_system_prompts" on public.system_prompts for all to service_role using (true) with check (true);
drop policy if exists "service_write_plugin_prompt_versions" on public.plugin_prompt_versions;
create policy "service_write_plugin_prompt_versions" on public.plugin_prompt_versions for all to service_role using (true) with check (true);
drop policy if exists "service_write_ai_evaluations" on public.ai_evaluations;
create policy "service_write_ai_evaluations" on public.ai_evaluations for all to service_role using (true) with check (true);
drop policy if exists "service_write_ai_eval_runs" on public.ai_eval_runs;
create policy "service_write_ai_eval_runs" on public.ai_eval_runs for all to service_role using (true) with check (true);

-- ============================================================================
-- ROLLBACK (nur manuell und bewusst ausführen – niemals automatisch):
--   drop table if exists public.ai_eval_runs;
--   drop table if exists public.ai_evaluations;
--   drop table if exists public.plugin_prompt_versions;
--   drop table if exists public.system_prompts;
--   delete from public.ai_migrations where version = '002';
-- ============================================================================
