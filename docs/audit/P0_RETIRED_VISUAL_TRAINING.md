# Phase 0 follow-up: retire the orphaned visual training entry point

> Integrationshinweis: Original-Konsolenartefakte unverändert im Evidence-Registry; Zuordnung unter [p0/README.md](p0/README.md).

2026-11-13 UTC · follows `3d1f130` · user authorized retirement of old visual training together with the previously retired image/video generators. This closes the earlier pending LoRA decision for the missing provider starter. No replacement Vast trainer is introduced.

## Scope and exact removals

`package.json` removes only `lora:plan` and `lora:train`: both invoke the already deleted `scripts/runpod-lora-train.py`. The file remains absent. Curation/dataset commands and all three Python test aliases remain, because each still exercises existing source. The `test:python` chain already points to those three existing suites and remains unchanged; no surviving test gate was dropped.

No entire test file is deleted. The exact 44 removed test names, before/after counts and preservation comparison are recorded in `p0/retired-training-test-inventory.log`.

- `tests/test_visual_lora_pipeline.py`: remove only `GateTest` (nine cases), which invokes the deleted RunPod starter for planning, price/approval gate, duplicate pod checks, creation, runtime limit, cleanup and report output. Remove its unused fake provider SDK/helpers and dead `TRAIN` constant. Keep all nine `KurationTest`, five `DatasetTest` and five local `BootstrapTest` cases.
- `tests/test_lora_segments.py`: retain the file because it also verifies existing independent local scripts. Remove `SegmentPlanungTest` (seven), `ResumeQuelleTest` (three), `VorabRechnungTest` (seven), `StarterFortschrittTest` (five), `VolumeKostenTest` (five), and eight methods of `FortschrittsmarkerTest`. These 35 cases exclusively invoke functions or CLI operations of the deleted starter. Remove its eager import, fake SDK and unused setup helpers. Preserve both independent progress-CLI tests, all six volume-staging tests and all eleven bootstrap/checkpoint tests.

The surviving progress/bootstrap cases read their actual valid JSONL output with `json.loads(last_line)` instead of importing the removed starter's parser. Expected field values, error exits, file existence, upload completion and checkpoint-before-completion ordering assertions remain intact. An AST comparison confirms every retained test method is unchanged except that parser substitution; no remaining assertion is relaxed. The comparison uses immutable checkpoint `3d1f130` as its source.

## Explicitly preserved components

No renderer, existing-media preparation, curation, dataset generation, runtime audio/LLM handler, image manifest or provider implementation changes. Existing `scripts/lora/bootstrap.sh`, `vorstaging.sh`, `lora-progress.py`, `trainer-aitoolkit.sh` and `aitk-segment.py` remain. Their independent local/stub coverage remains useful and does not require the removed provider starter. There is no sufficient evidence that the AI Toolkit adapter has no other consumers: the repository retains bootstrap/staging and visual-vorrat helpers, and its complete 16-test adapter suite exercises those existing source files. It is therefore preserved as instructed, without adding any active training entry point or claiming a Vast training capability. Historical FLUX/SDXL names inside local fixtures describe existing files/tests and do not restore generation.

## Verification

Commands, exact UTC ISO dates, original stdout/stderr and exit codes are in JSON-formatted `.log` records:

| Check | Result | Evidence |
| --- | --- | --- |
| Local curation/dataset/bootstrap suite | PASS, 19 tests | `p0/retired-training-media.log` |
| Independent progress/staging/bootstrap suite | PASS, 19 tests | `p0/retired-training-segments.log` |
| Existing AI Toolkit adapter suite | PASS, 16 tests | `p0/retired-training-aitk.log` |
| Preserved test ASTs / removal inventory | PASS, all 38 retained methods preserve their contracts; 44 obsolete methods listed | `p0/retired-training-test-inventory.log` |

The provided `/workspace/work/round2-python/bin/python` venv was used. Tests use temp files, stub trainers, local file URLs and loopback servers; no real GPU/provider/database action occurs. The segments suite emits existing unclosed-loopback-socket ResourceWarnings while passing; they were retained in its output rather than suppressed. Minor comment/import/blank-line cleanup after those test runs does not alter executable test behavior, as confirmed by the final preservation comparison.

The earlier global verification limitations remain: proven spatial/A100 baseline failures, unresolved current-image inherited pin equivalence (six static tests reading deleted `Dockerfile.runpod`) and independently handled documentation reconciliation. Those six image assertions were not removed, renamed or weakened in this follow-up. No new full-suite success is claimed. The parent orchestrator owns final integrated verification.

No latency or DSP callback changes; no collaboration/session/B2B changes. No secrets used, cloud changes, build, deployment, push or merge.


## Betreiber-Nachtrag: Claude-Fortsetzung, 2026-11-13

Der frühere konservative Zwischenstand oben bleibt als Historie erhalten. Der Betreiber hat die Entfernung der in den Claude-Screenshots benannten LoRA-/Bildvorrat-Pipeline jetzt ausdrücklich zur Fertigstellung gegeben. Nach Import-/Aufruferprüfung wurden `scripts/visual-vorrat/` und die nur davon bzw. von ihren Tests genutzten Trainer-/Staging-Adapter unter `scripts/lora/` entfernt. Kein Live-Renderer und keine Medienbibliothek wurden entfernt; bestehende Medienkuration und Dataset-Export bleiben erhalten.

Die zwei vollständig entfernten Testdateien `test_lora_segments.py` (19 verbleibende reine Staging-/Fortschrittsfälle) und `test_lora_trainer_aitoolkit.py` (16 Adapterfälle) hatten ausschließlich die entfernten Helfer als Gegenstand. Aus `test_visual_lora_pipeline.py` entfallen nur die fünf Bootstrap-Fälle; Kuration-/Dataset-Verträge bleiben vollständig erhalten. Das ist eine explizite Feature-Ausmusterung, kein Überspringen verbleibender Funktionen. Die zugehörigen npm-Gates sowie bereits auf fehlende Dateien zeigende alte Provider-Gates wurden bereinigt.

Acht historische Markdown-Quellen wurden mit tatsächlichem `git show 7903862:<Pfad>` unter `CLAUDE-RETIRED-HISTORY-*` in der Registry archiviert. Eventuelle Secret-Schwärzungen sind pro Beleg gezählt; Quellcommits bleiben erhalten. Der frühere Visual-Trainingsleitfaden ist somit kein aktiver Betriebsauftrag mehr. Aktuelle Hinweise in den erhaltenen Kuration-/Dataset-Werkzeugen verweisen hierher.


Die ausgemusterten Leitfäden VISUAL_LORA_TRAINING und VISUAL_LORA_STACK sowie der frühere generative VISUALMONK-Spec-Stand liegen im Archiv; die aktive VisualMONK-Spezifikation beschreibt nur den erhaltenen Renderer. Der ältere R2-Test importierte ein längst gelöschtes Provider-Skript. Die von Claude bereits nach vast-fleet-module portierten Manifest-/Image-Verträge werden unter test_vast_weight_manifest.py erhalten und von der nativen Testsuite entdeckt. Neun rein RunPod-spezifische Admission-Fälle (GPU-Katalog, Secure/Community-Cloud, DataCenter-Retry) entfallen mit dem entfernten Adapter; native Ressourcen-, Preis-, Budget-, Rollback- und Cursor-Verträge bleiben unter test_vast_fleet_plan.py und test_vast_migration.py erhalten. Der vollständige vorherige Testquelltext ist unter CLAUDE-LEGACY-R2-CONTRACTS archiviert; eine echte GPU-Admission wird dadurch nicht behauptet.
