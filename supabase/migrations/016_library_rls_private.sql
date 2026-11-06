-- ============================================================================
-- audioMONASTRY · 016_library_rls_private.sql
-- ============================================================================
-- Zweck (DB-2026-11-06-001, P1): Die Bibliotheks-Metadaten waren mit dem
-- anon-/publishable-Key vollstaendig lesbar. Der Key liegt im oeffentlichen
-- Client-Bundle (dist/assets/index-*.js), er ist also kein Geheimnis.
--
-- BELEG (live gemessen am 2026-11-06 gegen Projekt pwtwtqbcynsjtkxlkrwh,
-- PostgREST mit dem anon-Key aus .env, NICHT vermutet):
--   * GET /rest/v1/samples?select=id&limit=1        -> HTTP 206 + Zeile
--   * GET /rest/v1/music_tracks?select=id&limit=1   -> HTTP 206 + Zeile
--   * Zeilen: samples 995 (19 Spalten inkl. artist/url/lufs/file_size/
--     parameters/description), music_tracks 434.
--   * Ursache: 012_library_tables.sql:149-157 legte
--     `create policy "anon_read_samples" … for select to anon using (true)`
--     und `anon_read_music` ebenso an; 007_rls_harden_anon_read.sql:52
--     bestaetigt diese Ausnahme ausdruecklich.
--   * Die Audiodateien selbst waren bereits dicht (/api/media/r2 -> 401 ohne
--     Studio-Token) - offen waren nur die Metadaten.
--
-- WAS HIER PASSIERT:
--   1. Neue Spalte `is_public` (boolean, not null, default false) auf beiden
--      Tabellen. Sie ist der EINZIGE Weg, eine Zeile wieder oeffentlich zu
--      machen - eine bewusste Einzelentscheidung pro Zeile, kein
--      Tabellenschalter.
--   2. Die beiden anon-Policies werden ersetzt: statt `using (true)` gilt
--      `using (is_public = true)`. Der Bestand hat is_public=false, anon liest
--      deshalb 0 Zeilen (HTTP 200 mit []), ohne dass die Policy verschwindet -
--      der RLS-Vertrag (tests/supabaseRls.test.ts, DB-P2-002) bleibt lesbar.
--   3. Die Bibliothek im Browser liest NICHT mehr per PostgREST, sondern ueber
--      `GET /api/library` (Studio-Token, service_role serverseitig). Diese
--      Route liefert bewusst nur die Felder, die die UI braucht
--      (id/name/category/type/url/description/tags/parameters bzw.
--      id/name/artist/url/bpm) - artist/lufs/file_size/parameters-Details
--      bleiben damit auch fuer angemeldete Nutzer unnoetig breit verteilt.
--
-- WARUM NICHT `using (source = 'seed')`: Der Bestand hat die source-Werte
-- r2=950, seed=29, generated=16. `source='seed'` haette 29 Zeilen weiterhin
-- oeffentlich gelassen, obwohl der Browser sie ueber /api/library ohnehin
-- erhaelt - eine Oeffnung ohne Leser ist genau der Befund, den 007 beseitigt
-- hat. is_public=true als Opt-in ist die engere und ehrlichere Variante.
--
-- IDEMPOTENT: `add column if not exists`, `drop policy if exists` vor jedem
-- `create policy`, `on conflict do nothing`. Mehrfaches Anwenden ist folgenlos.
--
-- RUECKFAELLIG: Wer die Bibliothek wieder per anon-Key lesen will, setzt
--   update public.samples set is_public = true;      (bzw. music_tracks)
-- Das ist eine Datenentscheidung, keine Schema-Aenderung, und steht damit im
-- Audit-Log der Tabelle.
-- ============================================================================

-- --- 1) Opt-in-Spalte ---------------------------------------------------------
alter table public.samples
  add column if not exists is_public boolean not null default false;
alter table public.music_tracks
  add column if not exists is_public boolean not null default false;

comment on column public.samples.is_public is
  'DB-2026-11-06-001: einzige Bedingung, unter der anon diese Zeile lesen darf. Default false; Freigabe ist eine Zeilenentscheidung.';
comment on column public.music_tracks.is_public is
  'DB-2026-11-06-001: einzige Bedingung, unter der anon diese Zeile lesen darf. Default false; Freigabe ist eine Zeilenentscheidung.';

-- --- 2) anon-Policies ersetzen: using(true) -> using(is_public) --------------
drop policy if exists "anon_read_samples" on public.samples;
create policy "anon_read_samples" on public.samples
  for select to anon using (is_public = true);

drop policy if exists "anon_read_music" on public.music_tracks;
create policy "anon_read_music" on public.music_tracks
  for select to anon using (is_public = true);

-- Schreib-Policies (service_write_*) bleiben UNBERUEHRT: service_role schreibt
-- weiterhin Seed/Sync/Uploads.

-- --- 3) Nachweis fuer die Migrationstabelle ----------------------------------
insert into public.ai_migrations (version, description)
values ('013', 'DB-2026-11-06-001: anon-SELECT auf samples/music_tracks von using(true) auf is_public (default false) eingeengt - Metadaten nicht mehr oeffentlich, Bibliothek laeuft ueber /api/library')
on conflict (version) do nothing;
