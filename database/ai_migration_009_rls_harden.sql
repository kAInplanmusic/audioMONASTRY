-- ============================================================================
-- audioMONASTRY · ai_migration_009_rls_harden.sql
-- ============================================================================
-- Zweck (RC1-004, Audit 2026-09-23): anon/publishable-Key aus dem Client-Bundle
-- (belegt: "role":"anon" in dist/assets/index-*.js) hatte SELECT `using (true)`
-- auf Tabellen, die der Browser nie liest. Beweis siehe die gleichlautende
-- Datei supabase/migrations/007_rls_harden_anon_read.sql (vollstaendige
-- Belegkette: nur aiPersistence.ts beruehrt ai_*/mcp_*, und zwar mit
-- `supabaseServerKey()` = service_role, ausschliesslich server-seitig;
-- 0 Treffer im Client-Bundle; Browser-anon nur auf samples + music_tracks).
--
-- Diese Datei ist der Zwilling fuer den `database/`-Satz (Migrations-Drift
-- RC2-001). `drop policy if exists` ist idempotent - eingespielt wird, was
-- gefunden wird, und am Ende gibt es in keinem Fall noch anon-SELECT auf den
-- hier gelisteten Tabellen.
--
-- NICHT beruehrt: alle Schreib-Policies (service_write_*, service_all_*) und
-- die anon-SELECT-Policies auf samples und music_tracks.
-- ============================================================================

-- --- AI-/MCP-Betriebstabellen: nur service_role ------------------------------
drop policy if exists "anon_read_ai_migrations" on public.ai_migrations;
drop policy if exists "anon_read_ai_sessions" on public.ai_sessions;
drop policy if exists "anon_read_ai_jobs" on public.ai_jobs;
drop policy if exists "anon_read_ai_model_usage" on public.ai_model_usage;
drop policy if exists "anon_read_ai_errors" on public.ai_errors;
drop policy if exists "anon_read_ai_cost" on public.ai_cost_estimates;
drop policy if exists "anon_read_mcp_audit" on public.mcp_audit_events;

-- --- Prompt-/Eval-Tabellen: nur service_role ---------------------------------
drop policy if exists "anon_read_system_prompts" on public.system_prompts;
drop policy if exists "anon_read_plugin_prompt_versions" on public.plugin_prompt_versions;
drop policy if exists "anon_read_ai_evaluations" on public.ai_evaluations;
drop policy if exists "anon_read_ai_eval_runs" on public.ai_eval_runs;

-- --- Bibliotheks-Tabellen ohne Browser-Leser: nur service_role ---------------
drop policy if exists "anon_read_tags" on public.sample_tags;
drop policy if exists "anon_read_links" on public.library_links;

-- --- Nachweis fuer die Migrationstabelle ------------------------------------
insert into public.ai_migrations (version, description)
values ('009', 'RLS-Haertung: anon-SELECT entzogen fuer AI-/MCP-/Prompt-/Eval-Tabellen und sample_tags/library_links (RC1-004)')
on conflict (version) do nothing;
