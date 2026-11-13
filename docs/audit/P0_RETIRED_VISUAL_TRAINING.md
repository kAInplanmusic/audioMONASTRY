# Phase 0 follow-up: retire the orphaned visual training entry point

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
