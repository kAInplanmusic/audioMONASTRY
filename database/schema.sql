-- ============================================================================
-- audioMONASTRY – Supabase-Schema (externe Sample-/Musik-Datenbank)
-- ============================================================================
-- Anwendung: im Supabase-Dashboard unter "SQL Editor" einmalig ausführen
-- (bzw. via `psql`/Migration). Das Skript ist NICHT-DESTRUKTIV (P-6):
--   - `create table if not exists` legt fehlende Tabellen an
--   - `alter table … add column if not exists` migriert Alt-Tabellen
--   - es werden KEINE Tabellen gelöscht oder Daten entfernt
-- Für einen bewussten, destruktiven Reset: database/reset.sql verwenden.
--
-- Tabellen:
--   samples         Metadaten der Sample-Bibliothek (AudioSample-Äquivalent)
--   sample_tags     Querverweis: Sample -> Tag (normalisiert)
--   music_tracks    Musik-Bibliothek (MusicTrack-Äquivalent)
--   library_links   generische Querverweise (Sample<->Instrument/Preset/Playlist,
--                   Stem-Familien etc.) – erweiterbar für alle Module
--
-- Hinweis: Eigentliche Audio-Blobs liegen in Cloudflare R2; die URLs der
-- Objekte werden in samples.url / music_tracks.url hinterlegt.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- SAMPLES
-- ----------------------------------------------------------------------------
create table if not exists public.samples (
  id          text primary key,                    -- stabiler Bezeichner (z.B. 'bass-909-kick')
  name        text not null,
  category    text not null default 'mids',        -- bass | mids | highs
  type        text not null default 'Kick',        -- Kick, Clap, Acid Bass, ...
  kind        text not null default 'sample',      -- sample | recording | stem | sound | voice
  artist      text,                                -- Artist/Urheber (falls vorhanden)
  style       text,                                -- Stil (Techno, House, ...)
  key         text,                                -- Tonart (z.B. 'Am', 'F#')
  bpm         numeric,                             -- Tempo (Upload-Scan oder manuell)
  duration_seconds numeric,                        -- Dauer in Sekunden (Scan)
  sample_rate integer,                             -- Samplerate in Hz (Scan)
  lufs        numeric,                             -- Integrierte Lautheit (Scan)
  file_size   bigint,                              -- Byte-Größe des Audio-Blobs
  url         text,                                -- R2-Public-/Streaming-URL (oder synthesiert: null)
  description text not null default '',
  tags        jsonb not null default '[]'::jsonb,  -- denormierte Tags (für Schnellfilter)
  parameters  jsonb not null default '{}'::jsonb,  -- frequency, decay, pitchDecay, oscillatorType, ...
  source      text not null default 'seed',        -- 'seed' | 'opfs' | 'generated' | 'r2' | 'upload'
  created_at  timestamptz not null default now()
);

-- P-6: Migration bestehender Alt-Tabellen ohne Datenverlust.
alter table public.samples add column if not exists kind text not null default 'sample';
alter table public.samples add column if not exists artist text;
alter table public.samples add column if not exists style text;
alter table public.samples add column if not exists key text;
alter table public.samples add column if not exists bpm numeric;
alter table public.samples add column if not exists duration_seconds numeric;
alter table public.samples add column if not exists sample_rate integer;
alter table public.samples add column if not exists lufs numeric;
alter table public.samples add column if not exists file_size bigint;
alter table public.samples add column if not exists source text not null default 'seed';

create index if not exists samples_kind_idx on public.samples (kind);
create index if not exists samples_style_idx on public.samples (style);
create index if not exists samples_bpm_idx on public.samples (bpm);

-- Querverweis: Sample<->Tags (normalisiert, für relationale Abfragen)
create table if not exists public.sample_tags (
  sample_id text not null references public.samples(id) on delete cascade,
  tag       text not null,
  primary key (sample_id, tag)
);

-- ----------------------------------------------------------------------------
-- MUSIC TRACKS
-- ----------------------------------------------------------------------------
create table if not exists public.music_tracks (
  id         text primary key,                     -- z.B. Web-Pfad oder R2-Objekt-Key
  name       text not null,
  artist     text not null default 'Unknown',
  url        text not null,                        -- '/music/...' oder R2-Public-URL
  bpm        integer,
  style      text,                                 -- Genre/Stil
  key        text,                                 -- Tonart
  duration_seconds numeric,                        -- Dauer in Sekunden
  tags       jsonb not null default '[]'::jsonb,   -- Tags (Stimmung, Instrument, ...)
  created_at timestamptz not null default now()
);

-- P-6: Alt-Tabellen-Migration (ohne Datenverlust).
alter table public.music_tracks add column if not exists style text;
alter table public.music_tracks add column if not exists key text;
alter table public.music_tracks add column if not exists duration_seconds numeric;
alter table public.music_tracks add column if not exists tags jsonb not null default '[]'::jsonb;

-- ----------------------------------------------------------------------------
-- LIBRARY LINKS (generische Querverweise quer über alle Module)
-- ----------------------------------------------------------------------------
create table if not exists public.library_links (
  id           uuid primary key default gen_random_uuid(),
  src_table    text not null,                      -- 'samples' | 'music_tracks' | 'instruments' | 'playlists'
  src_id       text not null,
  dst_table    text not null,                      -- Zieltabelle
  dst_id       text not null,
  rel          text not null default 'related',    -- Beziehungstyp (owned_by, remix_of, mapped_to, ...)
  meta         jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);
create index if not exists library_links_src_idx on public.library_links (src_table, src_id);
create index if not exists library_links_dst_idx on public.library_links (dst_table, dst_id);

-- ----------------------------------------------------------------------------
-- Row Level Security (Client nutzt ANON; nur Lesen für Samples/Music)
-- ----------------------------------------------------------------------------
alter table public.samples enable row level security;
alter table public.sample_tags enable row level security;
alter table public.music_tracks enable row level security;
alter table public.library_links enable row level security;

-- anon/publishable darf Samples + Musik lesen (kein Schreiben)
create policy "anon_read_samples" on public.samples
  for select to anon using (true);
create policy "anon_read_tags" on public.sample_tags
  for select to anon using (true);
create policy "anon_read_music" on public.music_tracks
  for select to anon using (true);
create policy "anon_read_links" on public.library_links
  for select to anon using (true);

-- service_role schreibt (Seed/Sync)
create policy "service_write_samples" on public.samples
  for all to service_role using (true) with check (true);
create policy "service_write_tags" on public.sample_tags
  for all to service_role using (true) with check (true);
create policy "service_write_music" on public.music_tracks
  for all to service_role using (true) with check (true);
create policy "service_write_links" on public.library_links
  for all to service_role using (true) with check (true);
