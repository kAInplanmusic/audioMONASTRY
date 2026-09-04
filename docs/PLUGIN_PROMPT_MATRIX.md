# Plugin-Prompt-Matrix (GAP-5)

> 21 Plugins × Systemprompt/Few-Shots/MCP/Eval/Score. Sprache: Deutsch +
> englische Keywords (D18). Stand: 2026-09-03 – erzeugt aus
> `npm run iterate:prompts` (Prompt-Versionen) und `npm run eval:ai`
> (Score/Dauer/Fehler je Plugin, Gate aus `src/core/ai/orchestrator/evalMatrix.ts`).

| Plugin | Systemprompt (Version) | Kommando-Katalog | MCP-Tools | Eval-Datensatz | Min-Score | Score | Status |
|---|---|---|---|---|---|---|---|
| masterplayer | ✅ v2 | ✅ | ✅ (`masterplayer.<action>`) | ✅ (`ai_evaluations`) | 4.50 | 5.00 | ✅ PASS |
| instrument | ✅ v2 | ✅ | ✅ (`instrument.<action>`) | ✅ (`ai_evaluations`) | 4.00 | 5.00 | ✅ PASS |
| synthesizer | ✅ v2 | ✅ | ✅ (`synthesizer.<action>`) | ✅ (`ai_evaluations`) | 4.00 | 5.00 | ✅ PASS |
| drum | ✅ v2 | ✅ | ✅ (`drum.<action>`) | ✅ (`ai_evaluations`) | 4.00 | 5.00 | ✅ PASS |
| sampler | ✅ v2 | ✅ | ✅ (`sampler.<action>`) | ✅ (`ai_evaluations`) | 4.00 | 5.00 | ✅ PASS |
| mcp | ✅ v2 | ✅ | ✅ (`mcp.<action>`) | ✅ (`ai_evaluations`) | 4.00 | 5.00 | ✅ PASS |
| voice | ✅ v1 | ✅ | ✅ (`voice.<action>`) | ✅ (`ai_evaluations`) | 4.00 | 5.00 | ✅ PASS |
| sound | ✅ v2 | ✅ | ✅ (`sound.<action>`) | ✅ (`ai_evaluations`) | 4.00 | 5.00 | ✅ PASS |
| mixer | ✅ v2 | ✅ | ✅ (`mixer.<action>`) | ✅ (`ai_evaluations`) | 4.50 | 5.00 | ✅ PASS |
| controller | ✅ v2 | ✅ | ✅ (`controller.<action>`) | ✅ (`ai_evaluations`) | 4.00 | 5.00 | ✅ PASS |
| effect | ✅ v2 | ✅ | ✅ (`effect.<action>`) | ✅ (`ai_evaluations`) | 4.00 | 5.00 | ✅ PASS |
| drop | ✅ v2 | ✅ | ✅ (`drop.<action>`) | ✅ (`ai_evaluations`) | 4.00 | 5.00 | ✅ PASS |
| library | ✅ v2 | ✅ | ✅ (`library.<action>`) | ✅ (`ai_evaluations`) | 4.00 | 5.00 | ✅ PASS |
| eq | ✅ v2 | ✅ | ✅ (`eq.<action>`) | ✅ (`ai_evaluations`) | 4.50 | 5.00 | ✅ PASS |
| dsp | ✅ v2 | ✅ | ✅ (`dsp.<action>`) | ✅ (`ai_evaluations`) | 4.50 | 5.00 | ✅ PASS |
| mastering | ✅ v2 | ✅ | ✅ (`mastering.<action>`) | ✅ (`ai_evaluations`) | 4.50 | 5.00 | ✅ PASS |
| stem | ✅ v2 | ✅ | ✅ (`stem.<action>`) | ✅ (`ai_evaluations`) | 4.00 | 5.00 | ✅ PASS |
| spatial | ✅ v2 | ✅ | ✅ (`spatial.<action>`) | ✅ (`ai_evaluations`) | 4.00 | 5.00 | ✅ PASS |
| recording | ✅ v2 | ✅ | ✅ (`recording.<action>`) | ✅ (`ai_evaluations`) | 4.00 | 5.00 | ✅ PASS |
| performance | ✅ v2 | ✅ | ✅ (`performance.<action>`) | ✅ (`ai_evaluations`) | 4.00 | 5.00 | ✅ PASS |
| ai | ✅ v2 | ✅ | ✅ (`ai.<action>`) | ✅ (`ai_evaluations`) | 4.00 | 5.00 | ✅ PASS |

**Iterations-Loop:** `npm run iterate:prompts` legt je Plugin eine
Prompt-Version in `promptStore` an, bewertet die Kommando-Abdeckung,
optimiert bei Score-Abfall und schreibt DB-ready Zeilen nach
`test-results/system-prompts.json` (Tabellen `system_prompts` /
`plugin_prompt_versions`, `database/ai_migration_002.sql`).

**Eval-Suite:** `npm run eval:ai` erzeugt je Plugin Score, Dauer und
Fehlerliste (`test-results/ai-eval-report.json` + `.md`) und bricht mit
Exit 1 ab, sobald ein Plugin unter seinen Mindest-Score fällt oder das
Laufzeit-Budget reißt. Die Nightly-CI lädt beide Reports als Artefakt hoch
und schreibt den Markdown-Report in die Job-Summary.

**Offen (Betreiber-Schritt):** Anwenden der Migration in der Live-Supabase
und der echte LLM-Lauf (DeepSeek) je Plugin – siehe
`docs/LIVE_CHECKLIST_2026-09-02.md`.
