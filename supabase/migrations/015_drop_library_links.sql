-- ============================================================================
-- audioMONASTRY · 015_drop_library_links.sql
-- ============================================================================
-- ENTSCHIEDEN AM 2026-09-23 (DB-P3-001). Die Tabelle `public.library_links`
-- wird entfernt.
--
-- WARUM ENTSCHIEDEN UND NICHT WEITER GEPRUEFT:
-- Die Tabelle stand seit drei Runden als offener Punkt da ("loeschen oder Nutzen
-- belegen"). Beides ist gemessen:
--   * Kein Codepfad: `rg -l "\.from\('library_links'\)" src/ server/` -> 0 Treffer.
--     Kein Leser, kein Schreiber, kein Test.
--   * Keine Daten: live gemessen am 2026-09-23 im Projekt pwtwtqbcynsjtkxlkrwh ->
--     0 Zeilen (list_tables: "library_links" rows=0, rls_enabled=true).
--   * Kein Sicherheitsbeitrag: ihr anon-Leserecht war bereits in Iteration 2
--     entzogen worden (RC1-004).
-- Eine leere Tabelle ohne Leser ist kein Vorrat, sondern eine offene Frage, die
-- bei jeder Schema-Diskussion wieder auftaucht. Sie wird deshalb geschlossen.
--
-- WIEDERHERSTELLBAR: die Definition steht unveraendert in
-- supabase/migrations/012_library_tables.sql und in der Git-Historie. Braucht
-- ein spaeteres Feature Querverweise zwischen Bibliotheksobjekten, ist die
-- Tabelle in einer Minute wieder da - mit einer dann BEKANNTEN Nutzung.
--
-- `drop table if exists` ist idempotent: mehrfaches Anwenden ist folgenlos, und
-- auf einer Datenbank ohne die Tabelle passiert nichts.
--
-- HINWEIS ZUR DRIFT: 012 legt die Tabelle an, 015 entfernt sie. Netto bleibt
-- keine Tabelle - das ist die uebliche Migrationsform und fuer eine bereits
-- angewendete Datenbank der einzig richtige Weg. Aeltere Migrationen werden
-- NICHT rueckwirkend umgeschrieben (sonst haetten Systeme, die 012 schon
-- eingespielt haben, einen anderen Zustand als das Repo).
-- ============================================================================

drop table if exists public.library_links cascade;

insert into public.ai_migrations (version, description)
values ('012', 'DB-P3-001: Tabelle library_links entfernt (0 Codepfade, 0 Zeilen) - Definition bleibt in 012 wiederherstellbar')
on conflict (version) do nothing;
