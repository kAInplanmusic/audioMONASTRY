-- ============================================================================
-- audioMONASTRY · AI-Infrastruktur – Supabase-Migration 001
-- ============================================================================
-- Version: 001 · Datum: 2026-08-31
-- Zweck: AI-Sessions, AI-Jobs, Model-Usage, AI-Errors, Cost-Estimates,
--        MCP-Audit-Events in der BESTEHENDEN Supabase-Datenbank ablegen.
-- Grundsätze:
--   - NICHT-destruktiv (create table if not exists)
--   - versioniert (Dateiname + Tabelle ai_migrations)
--   - Rollback: siehe Abschnitt am Ende (bewusst manuell, nie automatisch)
-- ============================================================================

create table if not exists public.ai_migrations (
  version       text primary key,
  applied_at    timestamptz not null default now(),
  description   text not null default ''
);

insert into public.ai_migrations (version, description)
values ('001', 'AI sessions/jobs/model_usage/errors/cost_estimates/mcp_audit')
on conflict (version) do nothing;

-- ----------------------------------------------------------------------------
-- AI Sessions (Session-Lifecycle)
-- ----------------------------------------------------------------------------
create table if not exists public.ai_sessions (
  session_id    text primary key,
  state         text not null default 'CREATED',
  created_at    timestamptz not null default now(),
  last_activity timestamptz not null default now(),
  active_jobs   integer not null default 0,
  loaded_models jsonb not null default '[]'::jsonb,
  endpoint_state text not null default 'inactive'
);

create index if not exists ai_sessions_state_idx on public.ai_sessions (state);

-- ----------------------------------------------------------------------------
-- AI Jobs (Job-System inkl. Dedup-Key)
-- ----------------------------------------------------------------------------
create table if not exists public.ai_jobs (
  job_id       text primary key,
  session_id   text references public.ai_sessions(session_id) on delete set null,
  user_id      text not null default 'localUser',
  task         text not null,
  model        text not null,
  provider     text not null,
  status       text not null default 'QUEUED',
  created_at   timestamptz not null default now(),
  started_at   timestamptz,
  completed_at timestamptz,
  duration_ms  integer,
  error        text,
  dedupe_key   text
);

create index if not exists ai_jobs_session_idx on public.ai_jobs (session_id, created_at desc);
create index if not exists ai_jobs_dedupe_idx on public.ai_jobs (dedupe_key) where dedupe_key is not null;

-- ----------------------------------------------------------------------------
-- AI Model Usage (Inferenz-Zähler je Modell)
-- ----------------------------------------------------------------------------
create table if not exists public.ai_model_usage (
  id           bigint generated always as identity primary key,
  session_id   text,
  model        text not null,
  task         text not null,
  provider     text not null,
  inference_ms integer not null default 0,
  created_at   timestamptz not null default now()
);

create index if not exists ai_model_usage_model_idx on public.ai_model_usage (model, created_at desc);

-- ----------------------------------------------------------------------------
-- AI Errors
-- ----------------------------------------------------------------------------
create table if not exists public.ai_errors (
  id           bigint generated always as identity primary key,
  job_id       text,
  session_id   text,
  model        text,
  provider     text,
  error        text,
  created_at   timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- AI Cost Estimates
-- ----------------------------------------------------------------------------
create table if not exists public.ai_cost_estimates (
  id                 bigint generated always as identity primary key,
  job_id             text,
  session_id         text,
  estimated_cost_usd numeric(10, 6) not null default 0,
  created_at         timestamptz not null default now()
);

create index if not exists ai_cost_session_idx on public.ai_cost_estimates (session_id, created_at desc);

-- ----------------------------------------------------------------------------
-- MCP Audit Events
-- ----------------------------------------------------------------------------
create table if not exists public.mcp_audit_events (
  id           bigint generated always as identity primary key,
  tool         text not null,
  user_id      text not null default 'localUser',
  session_id   text,
  permission   text not null default 'READ',
  ok           boolean not null default true,
  created_at   timestamptz not null default now()
);

-- ============================================================================
-- Row Level Security (FA-P1-1): public-Tabellen sind ohne RLS mit dem anon-Key
-- les-/schreibbar. Daher werden RLS + Policies analog schema.sql aktiviert:
--   anon = lesen, service_role = schreiben.
-- ============================================================================
alter table public.ai_migrations enable row level security;
alter table public.ai_sessions enable row level security;
alter table public.ai_jobs enable row level security;
alter table public.ai_model_usage enable row level security;
alter table public.ai_errors enable row level security;
alter table public.ai_cost_estimates enable row level security;
alter table public.mcp_audit_events enable row level security;

drop policy if exists "anon_read_ai_migrations" on public.ai_migrations;
create policy "anon_read_ai_migrations" on public.ai_migrations for select to anon using (true);
drop policy if exists "anon_read_ai_sessions" on public.ai_sessions;
create policy "anon_read_ai_sessions" on public.ai_sessions for select to anon using (true);
drop policy if exists "anon_read_ai_jobs" on public.ai_jobs;
create policy "anon_read_ai_jobs" on public.ai_jobs for select to anon using (true);
drop policy if exists "anon_read_ai_model_usage" on public.ai_model_usage;
create policy "anon_read_ai_model_usage" on public.ai_model_usage for select to anon using (true);
drop policy if exists "anon_read_ai_errors" on public.ai_errors;
create policy "anon_read_ai_errors" on public.ai_errors for select to anon using (true);
drop policy if exists "anon_read_ai_cost" on public.ai_cost_estimates;
create policy "anon_read_ai_cost" on public.ai_cost_estimates for select to anon using (true);
drop policy if exists "anon_read_mcp_audit" on public.mcp_audit_events;
create policy "anon_read_mcp_audit" on public.mcp_audit_events for select to anon using (true);

drop policy if exists "service_write_ai_migrations" on public.ai_migrations;
create policy "service_write_ai_migrations" on public.ai_migrations for all to service_role using (true) with check (true);
drop policy if exists "service_write_ai_sessions" on public.ai_sessions;
create policy "service_write_ai_sessions" on public.ai_sessions for all to service_role using (true) with check (true);
drop policy if exists "service_write_ai_jobs" on public.ai_jobs;
create policy "service_write_ai_jobs" on public.ai_jobs for all to service_role using (true) with check (true);
drop policy if exists "service_write_ai_model_usage" on public.ai_model_usage;
create policy "service_write_ai_model_usage" on public.ai_model_usage for all to service_role using (true) with check (true);
drop policy if exists "service_write_ai_errors" on public.ai_errors;
create policy "service_write_ai_errors" on public.ai_errors for all to service_role using (true) with check (true);
drop policy if exists "service_write_ai_cost" on public.ai_cost_estimates;
create policy "service_write_ai_cost" on public.ai_cost_estimates for all to service_role using (true) with check (true);
drop policy if exists "service_write_mcp_audit" on public.mcp_audit_events;
create policy "service_write_mcp_audit" on public.mcp_audit_events for all to service_role using (true) with check (true);

-- ============================================================================
-- ROLLBACK (nur manuell und bewusst ausführen – niemals automatisch):
--   drop table if exists public.mcp_audit_events;
--   drop table if exists public.ai_cost_estimates;
--   drop table if exists public.ai_errors;
--   drop table if exists public.ai_model_usage;
--   drop table if exists public.ai_jobs;
--   drop table if exists public.ai_sessions;
--   delete from public.ai_migrations where version = '001';
-- ============================================================================
