-- ============================================================================
-- audioMONASTRY · 007_rls_harden_anon_read.sql
-- ============================================================================
-- Zweck (RC1-004, Audit 2026-09-23): Der anon/publishable-Key liegt im
-- Client-Bundle (belegt: dist/assets/index-*.js und audio-core-*.js enthalten
-- ein JWT mit "role":"anon"). Die bisherigen RLS-Policies gaben diesem Key
-- SELECT mit `using (true)` auf Tabellen, die der Browser NIE liest.
--
-- BELEG (gemessen 2026-09-23, nicht vermutet):
--   * `rg -l "\.from\('ai_" src/ server/` -> ausschliesslich
--     src/core/ai/orchestrator/aiPersistence.ts.
--   * aiPersistence.ts baut seinen Client mit `supabaseServerKey()`
--     (= service_role) und wird importiert von server.ts,
--     server/routes/aiRoutes.ts und server/routes/mediaRoutes.ts - KEIN
--     Browser-Import.
--   * `rg -o "ai_jobs|ai_sessions|ai_errors|mcp_audit_events|ai_cost_estimates"
--     dist/assets/*.js` -> 0 Treffer im Client-Bundle.
--   * Einzige anon-Leser im Browser: src/lib/supabaseClient.ts mit den Tabellen
--     `samples` (Zeile 73) und `music_tracks` (Zeile 85).
--
-- Deshalb: anon-SELECT nur noch auf `samples` und `music_tracks`.
-- Alle Schreib-Policies (service_write_*, service_all_*) bleiben UNBERUEHRT.
--
-- HINWEIS ZUR MIGRATIONS-DRIFT (offener Befund RC2-001): dieses Repo fuehrt
-- ZWEI Migrationssaetze - `supabase/migrations/` (wird von
-- scripts/apply-supabase-migrations.ts gelesen) und `database/` (wird von
-- tests/migrations.test.ts und der Doku referenziert) - mit teils gleichen
-- Nummern und unterschiedlichem Inhalt. Diese Datei liegt im ANGEWANDTEN Satz;
-- die inhaltlich gleiche Haertung liegt zusaetzlich als
-- database/ai_migration_009_rls_harden.sql bereit. `drop policy if exists`
-- ist idempotent, deshalb ist das Ergebnis unabhaengig davon, welcher Satz
-- eingespielt wird: es gibt danach in KEINEM Fall noch anon-SELECT auf den
-- hier gelisteten Tabellen.
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
-- samples + music_tracks BEHALTEN ihre anon-SELECT-Policy (der Browser braucht
-- sie); sample_tags und library_links werden nur serverseitig bzw. gar nicht
-- gelesen (`rg -l "\.from\('library_links'\)" src/ server/` -> 0 Treffer).
drop policy if exists "anon_read_tags" on public.sample_tags;
drop policy if exists "anon_read_links" on public.library_links;

-- --- Nachweis fuer die Migrationstabelle ------------------------------------
insert into public.ai_migrations (version, description)
values ('009', 'RLS-Haertung: anon-SELECT entzogen fuer AI-/MCP-/Prompt-/Eval-Tabellen und sample_tags/library_links (RC1-004)')
on conflict (version) do nothing;
