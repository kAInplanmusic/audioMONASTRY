# Plugin-Prompt-Matrix (GAP-5)

> 21 Plugins × Systemprompt/Few-Shots/MCP/Eval/Score. Sprache: Deutsch +
> englische Keywords (D18). Stand: 2026-08-31.

| Plugin | Systemprompt | Few-Shots | MCP-Tools | Eval-Datensatz | Iteration | Score |
|---|---|---|---|---|---|---|
| masterplayer | ⬜ | ⬜ | – | ⬜ | – | – |
| instrument | ⬜ | ⬜ | ⬜ | ⬜ | – | – |
| synthesizer | ⬜ | ⬜ | ⬜ | ⬜ | – | – |
| drum | ⬜ | ⬜ | ⬜ | ⬜ | – | – |
| sampler | ⬜ | ⬜ | ⬜ | ⬜ | – | – |
| sequencer | ✅ (Basis) | ⬜ | ✅ (load_pattern) | ⬜ | – | – |
| voice | ⬜ | ⬜ | ✅ (tts/sing) | ⬜ | – | – |
| sound | ⬜ | ⬜ | ⬜ | ⬜ | – | – |
| mixer | ✅ (Basis) | ⬜ | ⬜ | ⬜ | – | – |
| controller | ⬜ | ⬜ | ⬜ | ⬜ | – | – |
| effect | ⬜ | ⬜ | ✅ (fx.automate) | ⬜ | – | – |
| drop | ⬜ | ⬜ | ⬜ | ⬜ | – | – |
| library | ⬜ | ⬜ | ✅ (sample.search) | ⬜ | – | – |
| eq | ⬜ | ⬜ | ⬜ | ⬜ | – | – |
| dsp | ⬜ | ⬜ | ⬜ | ⬜ | – | – |
| mastering | ⬜ | ⬜ | ⬜ | ⬜ | – | – |
| stem | ⬜ | ⬜ | ✅ (stem.separate) | ⬜ | – | – |
| spatial | ⬜ | ⬜ | ⬜ | ⬜ | – | – |
| recording | ⬜ | ⬜ | ⬜ | ⬜ | – | – |
| performance | ⬜ | ⬜ | ⬜ | ⬜ | – | – |
| ai | ✅ (global) | ⬜ | ⬜ | ⬜ | – | – |

**Vorgehen (Iterations-Loop):** Prompt in `promptStore` anlegen → Eval-Suite
über `evaluationStore` → Score → Prompt optimieren → neue Version. Persistenz
über `database/ai_migration_002.sql` (system_prompts / ai_evaluations /
ai_eval_runs).
