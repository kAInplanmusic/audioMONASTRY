# Plugin-Prompt-Matrix (GAP-5 / P3-1 / P3-2)

> **Kein Score in dieser Datei ist ein Messwert.** Die Score-Spalte der früheren
> Fassung war ein MOCK (Stand 2026-09-03: `model: 'mock'`, `score: 5`, ohne
> einen einzigen Modellaufruf – Audit-Befund INFRA-AI-001). Echte Scores stehen
> ausschließlich in `test-results/ai-eval-report.md` (Artefakt von
> `npm run eval:ai`). Ohne erreichbares Modell meldet der Lauf ehrlich
> **UNCHECKED** – und genau das ist der Status in dieser Tabelle, weil für die
> Rollen noch kein solcher Report vorliegt.
>
> Die Tabelle unten ist **generiert** aus
> `src/core/ai/orchestrator/promptRoles.ts` (`formatCoverageTable()`), nicht
> abgeschrieben. Neu erzeugen (ohne Modellaufruf, offline):
>
> ```bash
> npx tsx scripts/seed-prompt-evals.ts
> # → test-results/prompt-coverage.json (Rollen × Prompt/Few-Shots/MCP/Eval/Gate/Status)
> # → test-results/system-prompts-seed.json (DB-ready: system_prompts, plugin_prompt_versions)
> ```

## Verbindliche Rollenliste

* **Plugin-/System-Rollen (18):** `EVAL_PLUGIN_IDS` in
  `src/core/ai/orchestrator/evalMatrix.ts` – 16 echte MONKs
  (`mixer, drop, song, effect, syntisampler, drumsampler, instru, biblio, voice,
  sound, stem, spatial, eq, dsp, master, record`) + System-Module `ai`, `perfor`.
  Diese Liste ist der Vertrag; die alte Tabellenbeschriftung („21 Plugins“) und
  die Altnamen sind überholt.
* **Planer-Rolle (1):** `moa` = `MOA_GLOBAL_PROMPT_KEY`
  (`src/core/ai/orchestrator/promptStore.ts`). Der Planer-Prompt existierte
  bisher nur als Text in `docs/AI_PROMPTS.md`; jetzt ist er als Konstante
  (`MOA_GLOBAL_SYSTEM_PROMPT`) materialisiert und Teil des DB-Seeds.
* **Bild-/Video-Rollen (3):** `imageHq`, `videoReal`, `videoAbstract`
  (`GPU_ROLE_IDS`, `src/config/aiInfrastructure.ts`). Sie sind **keine**
  Plugin-Rollen: Bild/Video entstehen über die deterministischen Prompt-Bauer
  `buildVisionPrompt()`/`buildMotionPrompt()` (`src/core/ai/vision/visionPrompt.ts`),
  nicht über einen LLM-Systemprompt. Der Katalog hält für sie den Bau-Vertrag
  (Eingaben, Stile, Grenzen, MCP-Tool) fest.

Sprache: Deutsch + englische Keywords (D18).

## Abdeckung je Rolle (generiert)

| Rolle (ID) | Art | Systemprompt (Version) | Few-Shots | MCP-Tools | Eval-Fälle | Min-Score | Status |
|---|---|---|---|---|---|---|---|
| mixer | plugin-monk | v2 (968 Zeichen) | 3 | 3 | 4 | 4.50 | UNCHECKED |
| drop | plugin-monk | v2 (833 Zeichen) | 3 | 3 | 4 | 4.00 | UNCHECKED |
| song | plugin-monk | v2 (739 Zeichen) | 2 | 2 | 3 | 4.00 | UNCHECKED |
| effect | plugin-monk | v2 (711 Zeichen) | 2 | 2 | 3 | 4.00 | UNCHECKED |
| syntisampler | plugin-monk | v2 (1074 Zeichen) | 3 | 5 | 6 | 4.00 | UNCHECKED |
| drumsampler | plugin-monk | v2 (1043 Zeichen) | 3 | 3 | 4 | 4.00 | UNCHECKED |
| instru | plugin-monk | v2 (652 Zeichen) | 1 | 1 | 2 | 4.00 | UNCHECKED |
| biblio | plugin-monk | v2 (917 Zeichen) | 3 | 3 | 4 | 4.00 | UNCHECKED |
| voice | plugin-monk | v2 (907 Zeichen) | 3 | 3 | 4 | 4.00 | UNCHECKED |
| sound | plugin-monk | v2 (686 Zeichen) | 2 | 2 | 3 | 4.00 | UNCHECKED |
| stem | plugin-monk | v2 (703 Zeichen) | 2 | 2 | 3 | 4.00 | UNCHECKED |
| spatial | plugin-monk | v2 (777 Zeichen) | 2 | 2 | 3 | 4.00 | UNCHECKED |
| eq | plugin-monk | v2 (616 Zeichen) | 1 | 1 | 2 | 4.50 | UNCHECKED |
| dsp | plugin-monk | v2 (617 Zeichen) | 1 | 1 | 2 | 4.50 | UNCHECKED |
| master | plugin-monk | v2 (727 Zeichen) | 2 | 2 | 3 | 4.50 | UNCHECKED |
| record | plugin-monk | v2 (823 Zeichen) | 3 | 3 | 4 | 4.00 | UNCHECKED |
| ai | system-module | v2 (685 Zeichen) | 2 | 2 | 3 | 4.00 | UNCHECKED |
| perfor | system-module | v2 (843 Zeichen) | 3 | 3 | 4 | 4.00 | UNCHECKED |
| moa | planner | v2 (1113 Zeichen) | 2 | 0 | 2 | 4.00 * | UNCHECKED |
| imageHq | gpu-role | v2 (623 Zeichen) | 3 | 4 | 2 | 4.00 * | UNCHECKED |
| videoReal | gpu-role | v2 (744 Zeichen) | 3 | 3 | 2 | 4.00 * | UNCHECKED |
| videoAbstract | gpu-role | v2 (762 Zeichen) | 3 | 3 | 2 | 4.00 * | UNCHECKED |

**Summen:** 22 Rollen · 22 Systemprompts · 52 Few-Shots · 53 MCP-Tools ·
69 Eval-Fälle · 18 Rollen mit Matrix-Gate · 22 × UNCHECKED (kein Report = kein
erfundener Score).

`*` = für diese Rolle gibt es **keinen** Eintrag in `EVAL_PLUGIN_IDS`, also kein
verbindliches Gate. Der gezeigte Wert ist der Default von `evalSpecFor()`
(4.00) – er ist ausdrücklich ein Vorschlag, keine Abnahmehürde.

### Spalten-Definitionen

| Spalte | Quelle | Bedeutung |
|---|---|---|
| Systemprompt (Version) | `promptRoles.composeRoleSystemPrompt()` | v2 = Rollensatz (`PLUGIN_MOA_SYSTEM_PROMPTS`) + „Erlaubte Kommandos“ + Fehlerregel + Antwortformat + Few-Shots. v1 war der nackte Rollensatz. |
| Few-Shots | `PLUGIN_COMMAND_CATALOG` je Rolle | Ein Beispiel pro Kommando (gedeckelt auf 3), Eingabe aus `PLUGIN_MOA_TASKS`, Antwort ein gültiger JSON-Plan. |
| MCP-Tools | `mcpRuntime.createDefaultMcpRuntime()` | Tool-Namen werden tatsächlich registriert (`${rolle}.${kommando}`; Bild/Video: `image.*`, `video_real.*`, `video_abstract.*`). |
| Eval-Fälle | `promptRoles.evalCasesFor()` | Ein Fall je Katalog-Kommando + 1 Negativ-Fall (erfundenes Kommando muss unter das Gate fallen). |
| Min-Score | `evalMatrix.PLUGIN_EVAL_MATRIX` | Gate für `npm run eval:ai` und die Nightly-CI. |
| Status | `test-results/ai-eval-report.json` | PASS/FAIL/UNCHECKED – ohne Report UNCHECKED. |

## Lücken-Tabelle (was am 2026-09-21 geschlossen wurde)

| Bereich | Vorher | Nachher |
|---|---|---|
| Systemprompts (Plugins) | 18 Rollensätze à 1 Satz, ohne Kommandos/Fehlerregel/Format – der Iterations-Loop patchte die Kommandos zur Laufzeit nach | 18 Rollenprompts v2 (dieselben Sätze + Kommandos + Fehlerregel + Antwortformat + Few-Shots) |
| Planer-Prompt (`moa`) | nur als Text in `docs/AI_PROMPTS.md`; im Code fiel `moaSystemPromptForPlugin('')` auf einen generischen Satz zurück | Konstante `MOA_GLOBAL_SYSTEM_PROMPT` + eigene Zeile im DB-Seed (`plugin_id = 'moa'`) |
| Few-Shots | 0 (nirgends im Code) | 41 für Plugin-Rollen, 2 Planer, 9 Bild/Video = 52 |
| MCP-Tool-Zuordnung je Rolle | implizit (nur aus dem Katalog ableitbar, nirgends geprüft) | 43 Plugin-Tools + 10 Bild/Video-Tools explizit je Rolle, im Test gegen eine echte `McpRuntime` geprüft |
| Eval-Datensatz je Rolle | keine deklarierten Fälle (nur `task: 'plan'` in der Matrix) | 69 Fälle (43 Kommando-Fälle + 18 Negativ-Fälle + 2 Planer + 6 Bild/Video) |
| Fehlerregel | universal „wähle 'status'“ – für 9 der 18 Rollen falsch (`status` fehlt bei mixer, syntisampler, drumsampler, instru, biblio, voice, spatial, eq, dsp) | rollenrichtig: `status` nur, wo das Kommando existiert, sonst „melde den Fehler und wiederhole das Kommando nicht“ |
| Fehlender Eintrag | stiller Fallback im Seed (`?? 'Du bist ein audioMONASTRY-Produktions-Agent…'`) | `MissingRolePromptError` + `roleCoverageGaps()`; Tests werden rot |
| Bild-/Video-Rollen | Prompt-Bauer vorhanden, aber keine Rollen-/Tool-/Eval-Zuordnung | `imageHq`/`videoReal`/`videoAbstract` im Katalog (Bau-Vertrag, Stile, MCP-Tools, Eval-Fälle) |

## Befunde: Drift zwischen Katalog, Matrix und Doku

1. **Altnamen in der alten Tabelle** – `masterplayer`, `instrument`,
   `synthesizer`, `drum`, `sampler`, `mcp`, `controller`, `library`,
   `mastering`, `recording`, `performance` sind der Vor-Umbenennungs-Stand.
   Verbindlich sind die 18 IDs aus `EVAL_PLUGIN_IDS`. Für 10 dieser Altnamen gab
   es nie einen Katalog-Eintrag – `tests/aiEvaluation.test.ts` fiel dort still
   auf `status` zurück und war grün, ohne etwas zu prüfen (jetzt korrigiert,
   Test erzeugt für unbekannte IDs einen Fehler).
2. **`transport` und `midi-controller`** stehen im Kommando-Katalog
   (`src/utils/prompts.ts`, jeweils mit Prompt und Default-Task), haben aber
   **keine** Plugin-Rolle: kein Eintrag in `EVAL_PLUGIN_IDS`, keine Route in
   `pluginAudioRouter`, keine Registry-Karte. Sie sind im Katalog ausdrücklich
   als `NON_ROLE_CATALOG_IDS` festgehalten und getestet – eine bewusste
   Zuordnung, kein Zufall.
3. **`masterplayer`** ist laut `src/plugins/registry.ts` ein System-Modul
   (`SYSTEM_MODULES`, ohne Plugin-Slot, ohne Komponente). Die alte Tabelle
   führte ihn als Plugin mit „v2 / PASS“ – beides falsch. Er hat weder
   Kommando-Katalog noch Prompt; ein Prompt dafür wäre geraten (Betreiberfrage).
4. **MCP-Tool-Präfixe der Video-Rollen:** die Flotten-Rolle heißt `videoReal`,
   das MCP-Tool `video_real.img2video` (Unterstrich). Beide Schreibweisen sind
   gewachsen; der Katalog übernimmt sie unverändert, damit Tool-Aufruf und
   Endpoint zusammenpassen.
5. **„21 Kern-Kommandos“** (Kommentare in `eval-ai.ts`, alte Prompt-Doku): der
   Katalog führt heute 43 Kommandos über 18 Rollen. Die Zahl in der Doku war
   überholt.
6. **GPU-Rollen `brain`, `ears`, `voiceGen`, `music`, `orchestrator`** haben
   MCP-Tools (`audio.*`, `music.*`, `agent.orchestrate`), aber keinen Eintrag in
   diesem Prompt-Katalog – sie sind keine Plugin-/Prompt-Rollen. Festgehalten
   als `GPU_ROLES_WITHOUT_PROMPT_SPEC`.

## Wie die Abdeckung erzwungen wird (Tests)

| Test | Was rot wird |
|---|---|
| `tests/promptCatalog.test.ts` | `roleCoverageGaps()` ≠ leer, fehlender/zu kurzer Systemprompt, Few-Shots, MCP-Tools, Eval-Fälle, wenige-Shot mit Kommando außerhalb des Katalogs, Seed ohne Rolle |
| `tests/promptMatrix.test.ts` | Rolle ohne Matrix-Gate, Katalog-/Rollen-Drift, unbekannte Catalog-ID, Seed unvollständig |
| `tests/aiPromptEval.test.ts` | Eval-Fall liefert nicht den erwarteten Score, Negativ-Fall über dem Gate, erfundener Score/Status |
| `tests/promptIteration.test.ts` | Rollenprompt v2 wirkt nicht in einer Runde; Fehlerregel nennt ein unbekanntes Kommando |
| `tests/aiEvaluation.test.ts` | verbindliche Rolle ohne Kommando-Katalog (vorher stiller Fallback) |

Beweis (einmal ausgeführt, danach zurückgenommen): `drop` ohne Few-Shots und
`voice` ohne Systemprompt ⇒ 11 Tests in 3 Dateien rot, u. a.
`expected [ 'drop: Few-Shots fehlen', 'voice: Systemprompt fehlt/zu kurz' ] to deeply equal []`.

## Betrieb

* **DB-seed (offline):** `npx tsx scripts/seed-prompt-evals.ts` –
  `system_prompts` / `plugin_prompt_versions` (Schema:
  `database/ai_migration_002.sql`) + Abdeckungsreport.
* **Prompt-Iteration:** `npm run iterate:prompts -- --mode=coverage` (offline,
  Vorprüfung) bzw. `--mode=effect` (echtes Modell, Kosten!). Der Loop hängt bei
  Bedarf `roleCommandBlock()` aus dem Katalog an – dieselbe Quelle wie der
  Rollenprompt, damit es keine zweite Wahrheit gibt.
* **Eval:** `npm run eval:ai` (echtes Modell, Gate = Min-Score der Matrix);
  ohne erreichbares Modell Exit 0 mit **UNCHECKED** (`--require-model` macht daraus
  Exit 1).
* **Offen (Betreiber-Schritt):** Migration in der Live-Supabase anwenden und den
  echten LLM-Lauf je Rolle fahren, damit die Status-Spalte echte PASS/FAIL-Werte
  bekommt – siehe `MASTERTODOENDE.json`.
