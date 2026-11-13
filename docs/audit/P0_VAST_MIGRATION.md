# Phase 0: native Vast migration checkpoint

2026-11-13 UTC · branch `fix/p0-vast-migration-typecheck` · base `591dbd30bcf28f3bd96dd5f999e751770fa41078`.

**Status: partial / verification not globally green.** TypeScript compilation is repaired: 65 diagnostics before, zero after. Existing native TS paths are exercised with mocked providers; no GPU, provider provisioning, database write or deployment was executed. Python decisions below remain pending. This checkpoint permits the orchestrator's subsequent phases; it does not claim complete verification.

## Changes and contracts

- `src/core/ai/orchestrator/vastProvider.ts:77`: restored native `/run` + `/status` asynchronous jobs, same-job receipt validation, worker errors, bounded retries/deadlines and remote cancellation. Short tasks retain `/runsync`. Ten-minute inference deadline starts after wake/queue, matching the previous provider contract; cancellation has a separate two-second bound. Tests cover native completion, invalid receipts, errors, abort, timeout and preemption without real providers.
- `scripts/embeddingIndex.ts:51`: indexer preflight now accepts the actual native `VAST_POD_URL_EARS` + `AI_POD_TOKEN` contract; productive Supabase calls are unchanged and were never run. Indexer consumes the native result envelope. `src/core/ai/LlmRouter.ts:406` preserves optional explicit `VAST_BRAIN_OPENAI_URL` streaming.
- `src/core/ai/orchestrator/modelRegistry.ts:10`: TS imports the full 22-model service manifest, matching the Python runtime loader. Existing task aliases and component/CPU metadata remain meaningful. Zero-VRAM models derive `cpuOnly`; missing optional fields use actual Python defaults, without invented model sizes. Provider accounting types and warmup concurrency now match existing runtime behavior.
- `server/routes/aiRoutes.ts:377`: the three retired generation routes return HTTP 410 without scheduling generation or saving artifacts. The old FLUX/Wan clip pipeline, generator schemas/controls and retired prompt roles were removed pursuant to the explicit user decision. The single existing-media vis renderer, current visuals UI, feedback/styles, sequencing, merge and banks remain.
- `package.json`: Python verification invokes existing `test_vast_*.py` once, replacing references to deleted deploy/warm/guard suites. Production suites are no longer duplicated. Runtime/Python features without an existing equivalent were not silently replaced or skipped.
- Migration fixtures now use native URLs, envelopes, actual selected models and all eight active physical roles. Model eviction fixtures explicitly provide controlled model catalogs so the same eviction/core-protection assertions remain meaningful. Mocked fleet tests preserve checkpoint, ownership, fail-closed, retry, budget and presence contracts; no control-plane production implementation was changed.

## Deliberate test changes

`tests/visionJobClient.test.ts` was removed because it exclusively tested the retired FLUX/Wan generation job client and its old breaker/retry wrapper. `tests/visualGate.test.ts` was removed because it exclusively tested the retired generation gate. This follows the user's explicit retirement decision; current rendering tests remain.

`tests/vision.test.ts` retains prompt/style/feedback tests and removes only nonexistent generation client/schema cases. `tests/visualShowOrchestrator.test.ts` retains sequencing/merge/artifact tests and removes retired clip-generation/ETA/motion cases. New `tests/retiredVisualGeneration.test.ts` asserts all three routes return 410 and invoke neither generation nor artifact storage. New native-job and manifest parity suites cover the replacement runtime contracts. Assertions were not weakened to accept either old or new behavior.

The final presence fixture expects the native rejoin's complete eight-message sequence while still requiring no additional readiness request. Its focused rerun passes all six cases (`p0/checkpoint-brain-final.log`).

## Verification evidence

Every record under `p0/` contains command, ISO timestamp, exit code and captured output (JSON-formatted `.log` console artifacts). Recognizable synthetic credential-shaped test strings are redacted with counts. Earlier failed attempts remain recorded. Node 22.23.5 and existing dependencies were used; credentials were scrubbed before checks. Original diagnostic groups are in `p0/typecheck-groups.json`; original 65 diagnostics are in `p0/typecheck-before.log`.

| Gate | Actual result | Evidence |
| --- | --- | --- |
| Typecheck | PASS, zero diagnostics, repeated after migrations | `p0/verified-typecheck.log`, `p0/final-typecheck.log` |
| `npm run verify` | Executed; stops at lint failure after passing typecheck; remaining gates separately executed | `p0/checkpoint-verify.log`, `p0/final-verify.log` |
| Lint | FAIL: unchanged `SpatialClubSetup.tsx:97` unused `i`; base reproduction available | `p0/final-lint-verified.log`, `p0/baseline-checks.log` |
| Full Vitest | 3863 tests: 3860 pass, 3 fail. One P0 fixture subsequently repaired and focused 6/6 pass; two other findings remain below. No full-suite rerun claimed after final fixture correction | `p0/final-tests.log`, `p0/checkpoint-brain-final.log` |
| Focused runtime/migration tests | PASS, 18 files / 185 tests | `p0/focused-verified.log` |
| Python top chain | FAIL: Vast 61 tests / 1 unchanged A100 survey failure; later subgates executed individually | `p0/test-python-after.log`, `p0/baseline-checks.log` |
| Python LoRA | FAIL: 28 tests / 9 failures; missing retired training executable | `p0/test-python-lora.log` |
| Python LoRA segments | FAIL: deleted training executable import | `p0/test-python-lora-segments.log` |
| Python AI Toolkit LoRA | PASS, 16 tests | `p0/test-python-lora-aitk.log` |
| Python fleet | FAIL: 295 tests / 3 failures / 1 skip; all failures historical negative-control commit `a9b1487` unavailable in shallow checkout | `p0/test-python-fleet.log` |
| Python services / device / production | PASS: 2 / 15 / 35 tests | respective `p0/test-python-*.log` |
| Python runtime | FAIL: 335 tests / 49 errors; deleted productive helper module and missing `soundfile` dependency | `p0/test-python-runtime.log` |
| Security | PASS: full audit 667 dependencies, zero findings; interface boundaries 544 files pass | `p0/security-with-proxy.log` |
| Audio | PASS: parent independently ran `npm run audio:gate`; golden-1s.wav I=-11.8 LUFS, TPK=-8.0 dBTP, Peak=-8.0 dBFS, one file | parent orchestration record |
| RT gate | PASS: 20/20 limits, zero overruns, p99.9=0.369 ms | `p0/rt-gate.log` |
| Live RLS | SKIPPED by existing gate: project URL/service role absent; exit 0 is not a live validation | `p0/test-rls.log` |
| Dead files | FAIL: unchanged unused `src/components/SpatialSourceIcon.tsx` | `p0/check-deadfiles.log` |
| Deep static | PASS: 1753 files, 36 findings, zero critical; three AI stages intentionally offline/skipped | `p0/deep-static-direct-node22.log` |
| Summary | Executed, reports live RLS skip | `p0/verify-summary.log` |

Security required Node 22 `NODE_OPTIONS=--use-env-proxy` to use the inherited session proxy. Initial HTTP 0 attempt is retained in `p0/security.log`; the successful run required no source or credential changes. The first deep-static invocation inherited nested npm package configuration; a direct Node 22 PATH invocation succeeded. No report treats these corrected invocation failures as final blockers.

## Remaining findings and explicit pending decisions

1. **Productive Python migration blocker:** `handlers_runpod.py` was deleted with no native equivalent. Imports remain at `services/audiomonastry-ai-runtime/handlers.py:590`, `handlers_voice.py:295,904`, `handlers_stems.py:553,678`, `handlers_fleet2026.py:85`, `moa_orchestrator.py:814`, `handlers_ears.py:1010,1026`. Historical immutable `285ef5c` contains 481 lines of provider-neutral audio/model helpers, including chat, Qwen audio, XTTS, ACE-Step, Demucs and diarization; it contains no FLUX/Wan/control-plane implementation. Parent has asked the user whether to port this implementation into a neutral native module or consciously disable its consumers. No dependent port/removal was performed while the decision is pending. A separate missing `soundfile` environment dependency also appears in the runtime gate; no real model/GPU execution was attempted.
2. **Retired LoRA training decision:** `tests/test_visual_lora_pipeline.py` and `tests/test_lora_segments.py` invoke deleted `scripts/runpod-lora-train.py`. Parent has asked whether to remove this old visual training with retired generation or explicitly port a separate Vast trainer. Existing AI Toolkit tests pass. No test deletion or training resurrection pending the answer.
3. **Documentation reconciliation:** docReferences reports four deleted documentation references: `docs/audit-infra-runpod.md` in `tests/aiLegacyEndpointExample.test.ts`; `docs/RUNPOD_FLEET_SSOT.md` in README and `scripts/collect-vram-report.py`; `docs/RUNPOD_PODS_RUNBOOK.md` in `server/stemSeparation.ts`; `docs/runpod-8-instances-complete-plan.md` in README, runtime `hf_endpoint.example.json`, and `moa_orchestrator.py`. No ignore entry was added. Exact output: `p0/checkpoint-focused-actual.log`. Subsequent orchestration documentation reconciliation remains responsible for actual replacement links.
4. **Unchanged baseline failures:** Spatial negative-zero expectation (`tests/spatialSquareMotion.test.ts:74`), Spatial lint unused argument and A100 survey classification reproduce at base `591dbd3`; exact commands/output/dates in `p0/baseline-checks.log`. Hardware budgets, spatial behavior and DSP code remain untouched. Dead-file finding likewise concerns untouched source. Fleet historical-fixture failures are checkout-history limitations, not a validated production contract failure.
5. **Control-plane review boundary:** fleet tests mock the currently implemented Vast list `/api/v1/instances` and delete `/api/v0/instances/:id/` contracts. No live API conformity claim or cloud mutation was made. Legacy `test:python:pods` alias outside the verification chain still names deleted RunPod suites; it is not reported as executed/passing.

## Runtime and collaboration constraints

These changes affect asynchronous AI orchestration and fixtures. They add no AudioWorklet/DSP callback work, per-block allocation, buffer clearing or processing-thread I/O. Session/B2B behavior was not changed. All external infrastructure stayed unchanged. No supplied secret was written into code, logs, commits or tools. Tests and logs explicitly distinguish passing, failing, skipped and unavailable checks. No push, merge, deployment or production instance action was performed.
