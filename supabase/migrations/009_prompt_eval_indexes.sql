-- ============================================================================
-- Konsolidierung DB-P2-001 (2026-09-23) - HERKUNFT: database/ai_migration_003.sql
-- ============================================================================
-- Warum diese Datei hier liegt:
-- Im angewandten supabase-Satz fehlten die Sekundaer-Indizes der Prompt-/Eval-
-- Tabellen (idx_system_prompts_plugin_id, idx_plugin_prompt_versions_*, 
-- idx_ai_evaluations_*, idx_ai_eval_runs_*). Die Tabellen selbst legt bereits
-- 002_ai_schema.sql an - es fehlten nur die Indizes.
--
-- BEWUSST NICHT uebernommen: die anon_read_*-Policies aus 003. Reihenfolge!
-- 007_rls_harden_anon_read.sql (RC1-004) entzieht anon das Lesen auf genau
-- diesen Tabellen; da 009 alphabetisch NACH 007 laeuft, wuerde ein Kopieren der
-- Policies den Fix wieder aufheben. Die Indizes sind davon unabhaengig.
--
-- Der Inhalt der Index-Statements ist woertlich aus der Quelle uebernommen.
-- ============================================================================

begin;

insert into public.ai_migrations (version, description)
values ('003', 'Prompt-/Eval-Indizes (konsolidiert aus database/ai_migration_003.sql)')
on conflict (version) do nothing;

create index if not exists idx_system_prompts_plugin_id
  on public.system_prompts (plugin_id, version desc);
create index if not exists idx_plugin_prompt_versions_plugin_id
  on public.plugin_prompt_versions (plugin_id);
create index if not exists idx_plugin_prompt_versions_prompt_id
  on public.plugin_prompt_versions (prompt_id);
create index if not exists idx_ai_evaluations_plugin_id
  on public.ai_evaluations (plugin_id);
create index if not exists idx_ai_evaluations_created_at
  on public.ai_evaluations (created_at desc);
create index if not exists idx_ai_eval_runs_plugin_id
  on public.ai_eval_runs (plugin_id);
create index if not exists idx_ai_eval_runs_created_at
  on public.ai_eval_runs (created_at desc);

commit;
