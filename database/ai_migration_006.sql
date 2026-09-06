-- ============================================================================
-- audioMONASTRY · AI-Migration 006 – Query-Performance (WF-5)
-- ============================================================================
-- Version: 006 · Datum: 2026-09-06
-- Zweck: Fehlende Sekundär-Indizes für Session-/Job-Auswertungen ergänzen.
-- Voraussetzung: Migration 001 (ai_sessions, ai_jobs, ai_model_usage, ai_errors).
-- Sicherheit: Nicht-destruktiv (create index if not exists), RLS unverändert.
-- ============================================================================

begin;

-- Registriere Migration 006
insert into public.ai_migrations (version, description)
values ('006', 'Query-Performance: Session-/Job-Indizes (WF-5)')
on conflict (version) do nothing;

-- Sessions: Dashboard listet zuletzt aktive Sessions (created_at desc).
create index if not exists ai_sessions_created_idx
  on public.ai_sessions (created_at desc);

-- Model-Usage: Auswertung pro Session (Kosten/Latenz je Session).
create index if not exists ai_model_usage_session_idx
  on public.ai_model_usage (session_id, created_at desc);

-- Errors: Fehlerhistorie pro Session und pro Job.
create index if not exists ai_errors_session_idx
  on public.ai_errors (session_id, created_at desc);
create index if not exists ai_errors_job_idx
  on public.ai_errors (job_id, created_at desc);

commit;
