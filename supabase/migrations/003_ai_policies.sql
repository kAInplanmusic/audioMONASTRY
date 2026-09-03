-- ============================================================================
-- audioMONASTRY · AI-Infrastruktur – Supabase-Migration 003
-- ============================================================================
-- Version: 003 · Datum: 2026-09-03
-- Zweck: Row Level Security Policies für AI-Infrastruktur
-- Grundsätze:
--   - Idempotent (drop policy if exists, dann create)
--   - Sicherheit: input/output in ai_evaluations sind NICHT öffentlich
--   - nur service_role hat Zugriff auf ai_migrations und ai_evaluations
--   - system_prompts/plugin_prompt_versions sind für anon lesbar (kein Kod)
-- ============================================================================

begin;

-- Registriere Migration 003
insert into public.ai_migrations (version, description)
values ('003', 'Row Level Security Policies für AI-Infrastruktur')
on conflict (version) do nothing;

-- ============================================================================
-- SYSTEM PROMPTS: anon can read (safe), service_role can write
-- ============================================================================
drop policy if exists "anon_read_system_prompts" on public.system_prompts;
create policy "anon_read_system_prompts" on public.system_prompts
  for select to anon using (true);

drop policy if exists "service_write_system_prompts" on public.system_prompts;
create policy "service_write_system_prompts" on public.system_prompts
  for all to service_role using (true) with check (true);

-- ============================================================================
-- PLUGIN PROMPT VERSIONS: anon can read (safe), service_role can write
-- ============================================================================
drop policy if exists "anon_read_plugin_prompt_versions" on public.plugin_prompt_versions;
create policy "anon_read_plugin_prompt_versions" on public.plugin_prompt_versions
  for select to anon using (true);

drop policy if exists "service_write_plugin_prompt_versions" on public.plugin_prompt_versions;
create policy "service_write_plugin_prompt_versions" on public.plugin_prompt_versions
  for all to service_role using (true) with check (true);

-- ============================================================================
-- AI EVALUATIONS: KEINE anon-Policy! (input/output sind sensibel)
--                 nur service_role hat Zugriff
-- ============================================================================
drop policy if exists "anon_read_ai_evaluations" on public.ai_evaluations;
drop policy if exists "service_write_ai_evaluations" on public.ai_evaluations;
create policy "service_write_ai_evaluations" on public.ai_evaluations
  for all to service_role using (true) with check (true);

-- ============================================================================
-- AI EVAL RUNS: KEINE anon-Policy! (summary könnte sensible Daten enthalten)
--              nur service_role hat Zugriff
-- ============================================================================
drop policy if exists "anon_read_ai_eval_runs" on public.ai_eval_runs;
drop policy if exists "service_write_ai_eval_runs" on public.ai_eval_runs;
create policy "service_write_ai_eval_runs" on public.ai_eval_runs
  for all to service_role using (true) with check (true);

-- ============================================================================
-- AI MIGRATIONS: KEINE anon-Policy! (nur für Verwaltung & Audits)
--               nur service_role hat Zugriff
-- ============================================================================
drop policy if exists "anon_read_ai_migrations" on public.ai_migrations;
drop policy if exists "service_write_ai_migrations" on public.ai_migrations;
create policy "service_write_ai_migrations" on public.ai_migrations
  for all to service_role using (true) with check (true);

commit;

-- ============================================================================
-- SICHERHEITSHINWEIS:
-- - ai_evaluations / ai_eval_runs haben RLS aktiviert OHNE anon-Policies
-- - Dies bedeutet: anon-User können diese Tabellen nicht lesen
-- - Nur service_role kann Zugriff haben (Backend/Admin)
-- - Sensible Daten (input/output) sind somit geschützt
-- ============================================================================
