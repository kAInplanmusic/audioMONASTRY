-- ============================================================================
-- audioMONASTRY · Live-Migration 006 – AI-Session-Tabellen + Indizes (WF-5)
-- ============================================================================
-- Version: 006 · Datum: 2026-09-06
-- Zweck: ai_sessions/ai_jobs/ai_model_usage/ai_errors/ai_cost_estimates
--         in der Live-DB anlegen (idempotent), RLS + Policies aktivieren und
--         fehlende Sekundär-Indizes ergänzen.
-- Sicherheit: anon = lesen, service_role = schreiben (analog ai_migration_001).
-- ============================================================================

begin;

create table if not exists public.ai_migrations (
  version       text primary key,
  applied_at    timestamptz not null default now(),
  description   text not null default ''
);

insert into public.ai_migrations (version, description)
values ('006', 'AI-Session-Tabellen + Indizes (WF-5)')
on conflict (version) do nothing;

-- ----------------------------------------------------------------------------
-- AI Sessions (Session-Lifecycle)
-- ----------------------------------------------------------------------------
create table if not exists public.ai_sessions (
  session_id     text primary key,
  state          text not null default 'CREATED',
  created_at     timestamptz not null default now(),
  last_activity  timestamptz not null default now(),
  active_jobs    integer not null default 0,
  loaded_models  jsonb not null default '[]'::jsonb,
  endpoint_state text not null default 'inactive'
);

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

-- ----------------------------------------------------------------------------
-- AI Errors
-- ----------------------------------------------------------------------------
create table if not exists public.ai_errors (
  id         bigint generated always as identity primary key,
  job_id     text,
  session_id text,
  model      text,
  provider   text,
  error      text,
  created_at timestamptz not null default now()
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

-- ----------------------------------------------------------------------------
-- Indizes (WF-5: Session-/Job-Auswertungen)
-- ----------------------------------------------------------------------------
create index if not exists ai_sessions_state_idx on public.ai_sessions (state);
create index if not exists ai_sessions_created_idx on public.ai_sessions (created_at desc);
create index if not exists ai_jobs_session_idx on public.ai_jobs (session_id, created_at desc);
create index if not exists ai_jobs_dedupe_idx on public.ai_jobs (dedupe_key) where dedupe_key is not null;
create index if not exists ai_model_usage_model_idx on public.ai_model_usage (model, created_at desc);
create index if not exists ai_model_usage_session_idx on public.ai_model_usage (session_id, created_at desc);
create index if not exists ai_errors_session_idx on public.ai_errors (session_id, created_at desc);
create index if not exists ai_errors_job_idx on public.ai_errors (job_id, created_at desc);
create index if not exists ai_cost_session_idx on public.ai_cost_estimates (session_id, created_at desc);

-- ----------------------------------------------------------------------------
-- Row Level Security (anon = lesen, service_role = schreiben)
-- ----------------------------------------------------------------------------
alter table public.ai_migrations enable row level security;
alter table public.ai_sessions enable row level security;
alter table public.ai_jobs enable row level security;
alter table public.ai_model_usage enable row level security;
alter table public.ai_errors enable row level security;
alter table public.ai_cost_estimates enable row level security;

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

commit;
