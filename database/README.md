# `database/` — historischer Migrationssatz (nicht mehr fortschreiben)

**Status ab 2026-09-23: HISTORISCH.** Der **angewandte** Satz ist
`supabase/migrations/`. Neue Schemaänderungen gehören ausschließlich dorthin.

## Warum dieser Hinweis existiert

Bis 2026-09-23 führte das Repo zwei Migrationssätze parallel, mit **überlappenden
Nummern und unterschiedlichem Inhalt**. Das war kein Schönheitsfehler, sondern
eine Sicherheitslücke (Befund `DB-P2-001`):

* `scripts/apply-supabase-migrations.ts` liest `readdirSync('supabase/migrations').sort()`
  — also **nur** diesen Satz.
* Dieser Satz legte die Tabellen `samples`, `sample_tags`, `music_tracks`,
  `library_links` **gar nicht an** (sie standen nur in `database/schema.sql`),
  ebenso wenig `mcp_audit_events`, `sample_audio_embeddings` und die drei
  `visual_*`-Tabellen.
* Folge: Ein RLS-Fix, der nur in `database/` stand, hätte auf einer per
  `supabase`-Satz provisionierten Datenbank **überhaupt nicht gewirkt** — und
  niemand hätte es bemerkt. Genau dieser Fall trat beim Fix `RC1-004` auf.

Zusätzlich griff die Reihenfolge: `007_rls_harden_anon_read.sql` entzieht `anon`
das Lesen — läuft aber **vor** `008`/`009`. Eine wörtliche Kopie der alten
`anon_read_*`-Policies nach 007 hätte den Fix wieder aufgehoben. Beim
Konsolidieren ist genau das passiert und wurde vom Vertragstest
(`tests/supabaseRls.test.ts`) gefangen.

## Was am 2026-09-23 passiert ist

Die fehlenden Objekte wurden **wörtlich** in den angewandten Satz übernommen
(kein neu getipptes SQL, damit keine Zeile verfälscht wird):

| Neu in `supabase/migrations/` | Herkunft | Fehlte vorher |
|---|---|---|
| `008_ai_runtime_tables.sql` | `ai_migration_001.sql` | `mcp_audit_events` + AI-Laufzeittabellen |
| `009_prompt_eval_indexes.sql` | `ai_migration_003.sql` | 7 Sekundär-Indizes der Prompt-/Eval-Tabellen |
| `010_audio_embeddings.sql` | `ai_migration_007.sql` | `sample_audio_embeddings` + `match_audio_samples` |
| `011_visual_tables.sql` | `ai_migration_008_visual.sql` | `visual_generations/_feedback/_embeddings` + `match_visuals` |
| `012_library_tables.sql` | `schema.sql` | `samples`, `sample_tags`, `music_tracks` |

> **Nachtrag 2026-09-23 (`DB-P3-001`):** `library_links` wird in 012 noch angelegt,
> aber im **angewandten** Satz von `supabase/migrations/015_drop_library_links.sql`
> wieder **entfernt** (0 Codepfade, live 0 Zeilen). Hier im historischen Satz bleibt
> die Definition stehen – der Satz beschreibt den Stand seiner Zeit und wird nicht
> rückwirkend umgeschrieben.

Nachweis der Vollständigkeit (gemessen, nicht geschätzt): Der Zustandsvergleich
beider Sätze (Tabellen, RLS, Policies, Indizes, Funktionen) meldet **keine**
Differenz mehr. `npx vitest run tests/supabaseRls.test.ts` prüft **beide** Sätze
getrennt gegen denselben Vertrag und ist grün.

Die anon-Grants auf den AI-/MCP-Tabellen sind bei der Übernahme in **aktive
`drop policy`** umgewandelt worden — eine Datenbank mit altem Stand 001 verliert
die Freigabe dadurch wirklich, statt sie stillschweigend zu behalten.

## Was hier noch liegt und warum

Die Dateien bleiben als **Historie** erhalten (git ist die Wahrheit, aber ein
lesbarer Verlauf im Baum hilft) und werden **nicht** mehr geändert:

* `ai_migration_001..009_rls_harden.sql`
* `schema.sql` — Achtung: hier sind die `anon`-Grants auf `sample_tags` und
  `library_links` am 2026-09-23 **entfernt** worden (`RC1-004`), damit eine
  frische Anwendung dieses Satzes nicht mehr Rechte vergibt als nötig.
* `reset.sql` — destruktiver Reset, bewusst separat und **nicht** Teil der Tests.

## Regel für die Zukunft

1. Neue Migrationen **nur** in `supabase/migrations/`, fortlaufend nummeriert.
2. Kein zweiter Satz. Wenn eine Migration hier gebraucht wird, gehört sie dort
   hin — und dieser Ordner wird nicht wiederbelebt.
3. Vor jedem RLS-relevanten Eingriff: `npx vitest run tests/supabaseRls.test.ts`.
   Der Test rechnet den **Endzustand** je Satz aus (create/drop in Dateireihenfolge),
   nicht die Anzahl der Statements — reine Dateizählung hat die Lücke oben
   verdeckt.
