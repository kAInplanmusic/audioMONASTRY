-- ============================================================================
-- audioMONASTRY – DESTRUKTIVER Reset (bewusst!)
-- ----------------------------------------------------------------------------
-- Löscht alle vier Tabellen samt Daten. NUR verwenden, wenn die Datenbank
-- absichtlich zurückgesetzt werden soll. Danach `database/schema.sql` im
-- SQL-Editor ausführen, um das aktuelle Schema wieder anzulegen.
--
-- Audio-Blobs in Cloudflare R2 sind hiervon NICHT betroffen (nur Metadaten).
-- ============================================================================

drop table if exists public.samples cascade;
drop table if exists public.sample_tags cascade;
drop table if exists public.music_tracks cascade;
drop table if exists public.library_links cascade;

-- Danach:  database/schema.sql  ausführen.
