# Audio-Engine-Refactor und Nutzer-Schema-Migration — Auftragsklärung und Messstand

**Datum:** 2026-09-30
**Basis:** Branch `main`, HEAD `d76e64b`, Arbeitsbaum mit vorbestehenden Änderungen (u. a. `MASTERTODOENDE.json`)
**Auftrag (wörtlich):** „Refaktoriere die komplette Audio-Engine des gesamten Projekts und migriere das Datenbankschema aller Nutzer."
**Ergebnis dieser Ausarbeitung:** Auftrag in dieser Form **nicht ausführbar**. Beide Teile haben je einen harten Blocker, der nicht durch Fleiß, sondern nur durch Entscheidung auflösbar ist. Alle Zahlen unten sind gemessen, nicht geschätzt; die Rohausgaben stehen in §7.

> **Kurzfassung.**
> 1. Die Audio-Engine ist **grün**: 79/79 Tests in 10 Engine-/Worklet-Dateien, Audio-Gate OK. Ein „kompletter" Umbau hat **kein Akzeptanzkriterium** und würde gesunden, bereits auditierten Code (`docs/audit-audioweg.md`, alle Befunde F1–F7 gefixt) ohne Messgröße umschreiben.
> 2. „Schema aller Nutzer migrieren" ist **gegenstandslos**: die Produktionsdatenbank hat **0 Nutzer** (`auth.users` = 0) und insgesamt **2** nutzerbezogene Zeilen. Zusätzlich ist die Backup-Lage leer (`backups: []`, PITR aus) — ein Schema-Eingriff wäre derzeit **nicht rückholbar**.

---

## 1. Gemessener Ist-Stand — Audio-Engine

| Größe | Messwert | Quelle |
|---|---|---|
| Audio-Code gesamt | **15.583 LOC** in `src/audio/**`, `src/core/audio/**`, `src/utils/audio*` | `wc -l` über die getrackten Dateien |
| Engine-Fassade | **2.513 LOC** `src/utils/audioEngine.ts` | `wc -l` |
| Worklet-Prozessoren | **40+** Dateien in `src/audio/worklets/*.ts` (größte: `spatialProcessor.ts` 502, `itSynthProcessor.ts` 502, `v2SinkProcessor.ts` 440) | `wc -l`, sortiert |
| DSP-Stacks | drei parallel: TS-Worklets, Rust/WASM (`dspKernel_rs`, `hrtf_conv`), nativer Dienst `services/audio-runtime` (v0.3.0, `main.rs` 14.034 B) | `Cargo.toml`, Verzeichnis |
| AudioContext-Erzeugung | **genau eine** direkte `new AudioContext()` im Repo (`src/core/audio/backends/WebAudioBackend.ts:21`); die Factory `src/utils/audioContextFactory.ts` (54 LOC) kapselt den Rest | `git grep` |
| Test-Baseline Engine | **79 Tests / 10 Dateien grün** in 7,21 s | §7.1 |
| Audio-Qualitäts-Gate | **OK**: `golden-1s.wav: I=-12.0 LUFS, TPK=-8.4 dBTP, Peak=-8.4 dBFS` | §7.2 |
| SSOT-Lage | alle `AUDIO-P0-002`, `AUDIO-P1-001/002/003/011`, `AUDIO-P3-001` = **DONE** | `MASTERTODOENDE.json` |

**Folgerung:** Es gibt keinen offenen Audio-Befund in der SSOT und keinen messbaren Mangel. „Refaktorieren" hätte hier kein Ziel, das man am Ende überprüfen könnte — außer einem rein ästhetischen (Modulschnitt), s. §4.

## 2. Gemessener Ist-Stand — Datenbank (Produktion)

Projekt `pwtwtqbcynsjtkxlkrwh.supabase.co` (`audioMONASTRY`, `ACTIVE_HEALTHY`, PostgreSQL 17.6, eu-west-1), alle Abfragen **lesend** über die Management API.

| Größe | Messwert | Quelle |
|---|---|---|
| Nutzer | **0** (`auth.users`) | §7.3 |
| Nutzerbezogene Spalten | nur 4 Tabellen: `ai_jobs.user_id`, `mcp_audit_events.user_id`, `visual_feedback.user_id`, `visual_generations.user_id` | §7.4 |
| Nutzerbezogene Zeilen | **2** (`visual_generations` 1, `mcp_audit_events` 1; `ai_jobs`/`visual_feedback` je 0) | §7.5 |
| Fachliche Daten | `sample_tags` 780, `samples` 515, `ai_evaluations` 285, `music_tracks` 90, Embeddings je 41, `system_prompts` 22 | §7.5 |
| Tabellen | 19 in `public`, RLS auf 19/19, 21 Policies | §7.4 |
| Repo ↔ Live | **deckungsgleich**: 19/19 Tabellen vorhanden, keine fehlende Spalte aus Repo-`ALTER TABLE` | §7.6 |
| Angewandte Migrationen | 4 Einträge in `supabase_migrations.schema_migrations` (2026-09-23: `rls_harden_anon_read_rc1_004`, `rls_contract_report_db_p2_002_v2`, `drop_library_links_db_p3_001`, `system_prompts_unique_plugin_role_version`) | §7.7 |
| Historische Spur | `public.ai_migrations` 001–012 mit Beschreibung + `applied_at` | §7.7 |
| **Backups** | `backups: []` — **leer**; `pitr_enabled: false`, `walg_enabled: true` | §7.8 |
| RLS-Vertragstests | 49 Tests / 4 Dateien grün | §7.9 |

**Folgerung:** „Das Schema aller Nutzer migrieren" hat keinen Gegenstand — es existieren keine Nutzer. Ein Eingriff würde 2 nutzerbezogene Zeilen betreffen. Das eigentliche Risiko läge nicht in der Datenmenge, sondern darin, dass **kein Wiederherstellungspunkt existiert**: ohne Backup ist jede fehlgeschlagene Migration endgültig.

## 3. Was „komplette Audio-Engine" konkret umfassen würde

Für den Fall, dass der Umbau gewollt ist, hier der vollständige Umfang statt einer Schätzung:

1. Engine-Fassade `src/utils/audioEngine.ts` (2.513 LOC) in Module schneiden (SSOT `AUDIO-P1-002` erklärt das Ziel für erledigt, die Datei ist aber noch 2.513 LOC groß → Nachlauf offen).
2. Kontext-/Graph-Aufbau: `audioContextFactory.ts`, `src/context/AudioContext.tsx` (291 LOC), `src/core/audio/AudioGraph.ts` (239), `src/core/audio/backends/V2LiveSink.ts` (294), `src/core/audio/V2MonitorGraph.ts` (274).
3. Live-Pfad: `src/core/audio/live/V2SinkEngine.ts` (630), `src/audio/worklets/v2SinkProcessor.ts` (440), `src/audio/masterStreamTap.ts`, `src/audio/v2SyncMirror.ts`.
4. 40+ Worklets + `WorkletGraphRuntime.ts` (100), `workletSpecs.ts` (166), `workletParamBridge.ts` (183), `createWorkletNode.ts` (33).
5. Rust/WASM: `src/audio/wasm/dspKernel_rs`, `hrtf_conv`, `WasmPluginHost.ts`, `spatialBus.ts` (219), `src/audio/spatial/node.ts` (418).
6. Bounce/Offline (`OfflineBounceEngine.ts`), Sampling/SFZ (`sfzBridge.ts`, `core/sampler/sfzStreaming.ts`), Drum-Render (197), AI-Stem-Split (`ai/localDemucs.ts`).
7. Nativer Dienst `services/audio-runtime` (Rust, cpal) — eigene Versionierung, eigener Lebenszyklus.

Das sind Änderungen an ≥126 Dateien in einem Signalweg, dessen einziges hartes Kriterium (Latenz, Bit-Genauigkeit, „kein zweiter Pfad zu `destination`") heute nur durch die bestehenden 79 Tests und die Golden-WAVs abgesichert ist. Ohne vorab vereinbarte Akzeptanzkriterien (z. B. „Bit-Parität der Golden-WAVs", „Latenzbudget unverändert", „alle Worklets bleiben k-/a-rate-korrekt") ist der Umbau nicht abnehmbar.

## 4. Belegte, offene Refactor-Kandidaten (falls der Umbau gewollt ist)

Diese Punkte sind **im Code belegt**, nicht vermutet — sie sind der sachliche Kern eines Refactors:

1. **K1 — WASM-Kernel wird geladen und verworfen (Audit-Befund F8, dort „Empfehlung", also offen).**
   `WasmBackend.init()` kompiliert und instanziiert den Kernel und behält davon nur `this.ready` (Boolean); die Instanz wird nicht gehalten, gerendert wird in JS (§7.10). Die Klasse wird **nur** von `tests/coreExtra.test.ts` benutzt — im Produktivpfad kommt sie nicht vor. Zu entscheiden: echte WASM-Ausführung implementieren (Feature) oder die Attrappe entfernen (Refactor) — beides ist legitim, aber die Entscheidung ist eine Betreiberentscheidung, kein Automatismus.
2. **K2 — Engine-Fassade 2.513 LOC** trotz `AUDIO-P1-002` = DONE (s. §3.1).
3. **K3 — offene Deep-Audit-Befunde mit Audio-Bezug** (Status OPEN in der SSOT, `DA-2026-09-29-001`): „Audio-Routing ist nicht implementiert und wirft immer einen Fehler" (P1), „Preset-`data` ohne Schema-/Typ-Validierung → unsichere Deserialisierung in den Audio-Graph" (P2), „Benutzer-Presets in `localStorage` widersprechen dem Multi-User-State-Mirroring" (P2), „Stale `lockStatusRef` durch useEffect-Update" (P2).
4. **K4 — Nutzer-Schema (Brücke zur zweiten Auftragshälfte):** Das Schema führt `user_id` in 4 Tabellen, die App fällt aber laut Audit-Befund auf `'localUser'` zurück. Solange es keinen Nutzerbegriff gibt, ist jede „Nutzer-Migration" eine Migration auf Verdacht.

## 5. Warum hier nichts umgebaut und nichts migriert wurde

- Ein Umbau über 126 Dateien ohne Akzeptanzkriterium ist keine Refaktorierung, sondern eine Neuentwicklung mit Regressionsrisiko auf einem laufenden Signalweg — und er würde im Zweifel die bereits erbrachten Nachweise (F1–F7, Golden-WAV-Gate) entwerten, statt sie zu nutzen.
- Ein Schema-Eingriff in Produktion ist ein Live-Schreibzugriff auf echte Daten. Er ist hier zusätzlich **technisch nicht zu verantworten**, weil `backups: []` und PITR aus ist: es gäbe keinen Weg zurück. Die Offsite-Spur ist unabhängig davon zu prüfen (Bucket `audiomonastry-backups` fehlt laut früherem Befund).
- Es wurden ausschließlich **lesende** Abfragen gegen die Datenbank ausgeführt (`select`, `information_schema`, `/database/backups`). Kein DDL, kein DML, kein Deploy, kein Eingriff in die Flotte.

## 6. Was für den Auftrag fehlt (Entscheidungen, nicht Arbeit)

| # | Fehlt | Auflösbar durch |
|---|---|---|
| E1 | Ziel + Akzeptanzkriterien des Engine-Refactors | Betreiberaussage (z. B. Bit-Parität der Golden-WAVs, Latenz-Budget, Testabdeckung) |
| E2 | Schnittmenge: Facade / Worklets / WASM+Rust / Bounce+Spatial+SFZ | Auswahl |
| E3 | Entscheidung K1: WASM echt ausführen oder Attrappe entfernen | Auswahl |
| E4 | Zielschema der „Nutzer-Migration" (was soll anders sein?) | Beschreibung des Zielbilds |
| E5 | Wiederherstellungspunkt: Backup vor jedem DDL | Backup-Nachweis (Supabase-Backup-Liste **und** Offsite-Bestand) |
| E6 | Freigabe für Live-Schreibzugriff | ausdrückliche Freigabe |

## 7. Rohausgaben (Belege, wörtlich)

**7.1** Engine-Tests
```
NODE_ENV=test node node_modules/vitest/vitest.mjs run tests/audioEngine.test.ts \
  tests/audioContextFactory.test.ts tests/audioNoOpFacadeGuard.test.ts tests/dspQuality.test.ts \
  tests/v2DspParityExtended.test.ts tests/v2AudioGraph.test.ts tests/pluginAudioPipeline.test.ts \
  tests/loadAudioWorklets.test.ts tests/clockProcessorWorklet.test.ts tests/masteringProcessorWorklet.test.ts
→ Test Files 10 passed (10) | Tests 79 passed (79) | Duration 7.21s
```

**7.2** Audio-Gate
```
bash scripts/audio-gate.sh
→ PASS tests/fixtures/audio/golden-1s.wav: I=-12.0 LUFS, TPK=-8.4 dBTP, Peak=-8.4 dBFS
→ AUDIO-GATE: OK (1 Datei(en))
```

**7.3** Nutzer
```sql
select (select count(*) from auth.users) as auth_users;   -- [{'auth_users': 0}]
```

**7.4** Nutzerbezogene Spalten / RLS
```sql
select table_name,column_name from information_schema.columns
 where table_schema='public' and column_name ~* '(user|owner|profile|tenant|account)';
→ ai_jobs.user_id, mcp_audit_events.user_id, visual_feedback.user_id, visual_generations.user_id
→ policies 21 | rls_tabellen 19 | tabellen 19
```

**7.5** Tabellen mit Zeilenzahl (`n_live_tup`)
```
sample_tags 780 · samples 515 · ai_evaluations 285 · music_tracks 90 ·
sample_audio_embeddings 41 · sample_embeddings 41 · system_prompts 22 · ai_errors 21 ·
plugin_prompt_versions 20 · ai_migrations 10 · mcp_audit_events 1 · visual_generations 1 ·
ai_eval_runs 0 · ai_cost_estimates 0 · visual_feedback 0 · visual_embeddings 0 ·
ai_jobs 0 · ai_sessions 0 · ai_model_usage 0
```

**7.6** Repo ↔ Live
```
Tabellen live (public): 19 | Tabellen im Repo-Satz referenziert: 22
→ live fehlend: keine (der Treffer `documents` stammt aus einem Kommentar-Beispiel in
  004_pgvector_extensions_schema.sql, Zeile 62 — Fehltreffer des Regex, kein Drift)
→ live vorhanden, im Repo nicht definiert: keine
→ fehlende Spalten aus Repo-ALTER TABLE: keine
```

**7.7** Migrations-Ledger
```sql
select version,name from supabase_migrations.schema_migrations order by version;
→ 20260923171908 rls_harden_anon_read_rc1_004
→ 20260923175852 rls_contract_report_db_p2_002_v2
→ 20260923181917 drop_library_links_db_p3_001
→ 20260923225518 system_prompts_unique_plugin_role_version
-- public.ai_migrations: 001–012, je mit Beschreibung + applied_at (2026-09-03 … 2026-09-23)
```

**7.8** Backups
```json
{"region":"eu-west-1","walg_enabled":true,"pitr_enabled":false,"backups":[],"physical_backup_data":{}}
```

**7.9** DB-Vertragstests
```
NODE_ENV=test node node_modules/vitest/vitest.mjs run tests/migrations.test.ts \
  tests/rlsContract.test.ts tests/supabaseRls.test.ts tests/supabaseKeys.test.ts
→ Test Files 4 passed (4) | Tests 49 passed (49)
```

**7.10** WASM-Instanz wird verworfen (`src/core/audio/backends/WasmBackend.ts`, 65 LOC)
```ts
28|      const mod = await WebAssembly.compile(await resp.arrayBuffer());
29|      const { exports } = await WebAssembly.instantiate(mod, {});
30|      this.ready = typeof (exports as Record<string, unknown>).dsp_process === 'function';
-- `exports` wird nach Zeile 30 nicht mehr verwendet; kein Feld hält die Instanz.
```

## 8. Empfohlene Reihenfolge, sobald E1–E6 beantwortet sind

1. Wiederherstellungspunkt schaffen und **belegen** (nicht behaupten): Supabase-Backup-Liste nicht-leer **und** Offsite-Bestand nachgewiesen (Skill-Referenz `hetzner-deploy-credentials.md` / `storage-and-backups.md`).
2. Refactor in Schnitten mit jeweils grünem Golden-WAV- und Test-Nachweis; Bit-Parität als Regressionsschwelle vorab festlegen.
3. Nutzer-Migration erst, wenn ein Nutzerbegriff existiert (E4); additive, idempotente Migrationen im **angewandten** Satz `supabase/migrations/` (nicht in `database/`, das ist seit 2026-09-23 historisch), Anwendung nur mit E5 + E6.
