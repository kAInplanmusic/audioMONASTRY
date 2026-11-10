# RunPod R2 / CUDA / CI / Live Pod Audit — 2026-11-10

## Scope and evidence source
Current eight-role SSOT only. Source: `deploy/runpod/pod-fleet.json` and `services/audiomonastry-ai-runtime/model_manifest.json`. GitHub CI: https://github.com/kAInplanmusic/audioMONASTRY/actions.

### Verified / executed

- GitHub repository inspected; eight roles and 22 unique active model identifiers cross-reference.
- Dockerfile inspected: main image base is `pytorch/pytorch:2.8.0-cuda12.6-cudnn9-runtime`. This is a declaration, **NOT verification** on all configured GPU generations or loader combinations.
- CI for merge commit `ba6fd07c`: Deep Audit 300 **passed**, SonarCloud **failed**, primary CI and Build/Verify **in progress** at observation time. This cannot be declared green.
- Previous main CI (`b263b129`): 66 failed tests / 3,724 passed; an unhandled `envKey('AI_FLEET_MODE').toLowerCase()` TypeError was found in `src/core/ai/LlmRouter.ts`. Null-safe guard applied on this branch (three occurrences), **new CI not yet green**.
- Legacy `.github/workflows/runpod-deploy.yml` still references retired Serverless roles. **Do not dispatch** it for the active Pod fleet; `scripts/runpod-deploy.py` has been fail-closed at the CLI entrypoint.

### Not independently verified (hard release blockers)

- **R2 inventory:** No authenticated R2 account read possible in this session, so no authoritative 22/22 assertion. `scripts/runpod-pods.py weights` is configured to inspect eight roles, including `vis`, but its remote output has not been obtained here.
- **Hugging Face BVE:** `mel-roformer-bve` has shortened revision `c73a679`. Published checkpoint digest SHA-256: `e003bbb97ebef78c59cd6b46c5fc3d0f2303cd49f6fb98eb8b8f0f8075899ae3`. Upstream full commit has not been retrieved; `scripts/resolve-bve-revision.py --apply` must resolve and verify both.
- **Loader/CUDA:** Neither container builds on all target GPU types nor real GPU inference was executed here. Model frameworks, custom code, CUDA ABI, PyTorch, flash-attention and available memory need role-specific smoke results.
- **RunPod:** No authenticated RunPod control plane available in this session; no Pods created, modified, or deleted. No paid tests claimed.
- **Audio:** No generated output was available for objective or listening verification.

### Safe role-by-role live verification

`scripts/runpod-live-verify.py` runs one role at a time and stores JSONL evidence in `deploy/logs/runpod-live-*.jsonl`.

Each invocation:
1. Reads active provider inventory and **refuses** if a Pod with that target role already exists.
2. Requires a real, task-appropriate `--fixture` JSON with `{"input": {"task": ..., "model": ..., "input": ...}}`; absent fixture = fail-closed.
3. Calls canonical `scripts/runpod-pods.py up --yes --only ROLE --wait N`, which checks SSOT, R2 and costs.
4. Confirms readiness and sends `POST /runsync`.
5. In `finally`, deletes **only** new Pod IDs created for the target role, not pre-existing Pods.
6. Queries provider inventory again and records whether termination was observed.

Example after all gates are met:

```bash
set -a; . ./.env.deploy; set +a
python3 scripts/resolve-bve-revision.py --apply
python3 scripts/runpod-ssot-preflight.py
python3 scripts/runpod-pods.py weights
python3 scripts/runpod-live-verify.py --role ears --fixture /secure/fixtures/ears.json --yes-billable
```

**Safety limits:** `finally` cleanup cannot guarantee deletion on SIGKILL, process termination, runner loss, provider outage or some RunPod API failures. Use an external scheduler watchdog and account-level spending limit when live testing. A successful DELETE response is not sufficient; verify the instance disappears from the live inventory. A `cleanup_unconfirmed` record requires immediate manual follow-up.

### Release criterion

Do not merge as GPU-validated or claim R2/CI/loader completion without captured and independently inspected live evidence. Production releases remain blocked until:
- R2 weight checks return green for all 22 active model IDs (with physical per-file/checkpoint checksums);
- all active revisions are fully immutable and dependency lock/build digests verified;
- all eight roles load and successfully complete valid real inference on target GPUs with memory and output logs;
- GitHub mandatory CI passes on the release commit;
- every newly created test Pod is confirmed terminated and cost ledger reconciled.


## Recheck after explicit execution request — CI forensic findings

Source: GitHub Actions run 42831719361 (SonarCloud), 42831719913 (Audio Flow), 42830962600 (main mandatory CI). Actual outcome is **NOT APPROVED**.

1. SonarCloud coverage failed and disclosed stale TypeScript fleet registry assumptions:
   - `tests/manifestRoles.test.ts`: `audio-gen` exists in TS role list but not current model manifest.
   - Primary GPU mismatch: legacy `NVIDIA A40` vs SSOT `NVIDIA RTX 6000 Ada`.
   - Brain idle timeout TS 15 seconds vs manifest 120 seconds.
   - Legacy brain models `qwen3-30b-a3b-awq` and `qwen3-4b` vs SSOT `qwen38-27b-fp8`.
   - `tests/fleetWake.test.ts` and `tests/promptMatrix.test.ts` expect eight API roles but receive nine. Must distinguish API role namespace from deployed fleet roles and correct runtime consumers, not merely weaken tests.
2. Audio Flow run 42831719913 failed at `Start app in background`; investigate server start logs and actual job environment before changing workflow.
3. Previous mandatory CI on main 42830962600 failed at Vitest. New branch CI not all green at observation time.
4. No user-owned RunPod or Cloudflare R2 credential was exposed by available connected apps or tools. **Do not fetch secrets from logs or commit secrets into repository**. Authenticated live provider calls and live GPU verification were **not executed**.
5. No provider Pods were created or deleted; cost incurred from this session: zero known billable GPU launches.

**Release classification: RED.** Do not change this to green without provider-side results and passing mandatory CI for exact release SHA.

## SSOT naming cleanup pass (2026-11-10, PR #26)

**Implemented and pushed (not merged / not necessarily green CI):**
- Clear distinction between eight physical Pods `brain/ears/voice/music/studio/audio-brain/song/vis` and historical Serverless API aliases `voiceGen/imageHq/videoReal/videoAbstract/orchestrator`.
- Active TypeScript `AI_RESIDENT_FLEET` now reflects all eight Pod model lists; GPU pools heterogeneous 32/48/96 GB; `vis` = audio restoration.
- Retired `audio-gen` removed from API role list, provider tables, and Pod routing.
- Live configuration defaults use 8 EUR/h instead of obsolete 10/6 EUR/h.
- Active LLM model default corrected to `qwen38-27b-fp8` and OpenAI-compatible repository `Qwen/Qwen3.8-27B-FP8`. `qwen3-4b` executor is a separate `audio-brain` Pod.
- Music defaults changed from absent `acestep-v15-xl-sft` to resident `acestep-v15-xl-turbo` in API command registry, voice route, music context, and MoA catalog.
- CPU-only `dsp-analysis/basic-pitch` are members of ears but not GPU preloads.
- Legacy `.github/workflows/runpod-deploy.yml` manually fails closed without secrets, networking or billable GPU creation.
- README, architecture, fleet runbooks, environment matrix and deployment sample updated. Historical dated findings retained but visibly marked non-authoritative; the false `8×A40` runpod guide replaced.
- CI regression expectations aligned with active models and budget, while legacy Serverless adapters remain explicitly named as compatibility interfaces.

**CI remains NOT certified as of last query:** earlier run 42836019026 had 8 failed Vitest files / 425 passed. Later changes address known model/name/price drift but current latest commit tests were still queued/running; other known tests involve fleet autostop, missing reference docs and Audio Flow startup. Do not claim the repository is green without a completed run for the exact final commit.

**Credential hygiene:** user-provided credential bundle was NOT committed, forwarded to GitHub, or printed in this report. The bundle includes R2 S3 authentication but does not name a verified RunPod control-plane `RP_API_KEY`, nor a valid project `AI_POD_TOKEN`, nor an explicit `CFS3_BUCKET` setting. Rotating all exposed active secrets and storing replacements in proper secret management is required. No account credentials were modified or rotated by this change.

## CI repair continuation — 2026-11-10 16:09 CET (PR #26)

**New verified evidence:** Exact PR head `6e9c6ae5` failed the full Verify CI (`42838855633`) and Audio Flow (`42838855672`); AI jobs and Deep Audit 300 passed. These are **not** GPU acceptance tests.

**Fix commit `f95fb7a6`:** Corrected `acestep-v15-xl-turbo` in the ComfyUI adapter, updated the voice-route allowlist/override regression to reject retired `musicgen-medium` without weakening model validation, updated LLM compatibility tests, and made the auto-stop mock HTTP parser accept hyphens in `audio-brain` Pod IDs.

**Fix commit `9a3b1b83`:** The auto-stop tests previously built `RP_POD_ID_AUDIO-BRAIN` rather than `RP_POD_ID_AUDIO_BRAIN`. Corrected both generation and cleanup plus seven-Pod count assertions. The GitHub Audio Flow job ran `NODE_ENV=test npm run dev` while the server has an explicit `NODE_ENV !== 'test'` autostart guard; set `NODE_ENV=development` only for the CI app-launch command. Fixed obsolete external documentation link treatment in `tests/docReferences.test.ts` without claiming the historical file is present; aligned remaining ACE/MoA test terminology.

**Status at writing:** Current tests `42842051557` (Verify), `42842051532` (Audio Flow), `42842051581` (AI) were running; no green result for exact `9a3b1b83` was observed. Do not merge or deploy on pending results. Existing GPU verification, checkpoint pins, R2 inventories, secret rotation, production key installation and four-user audio QA remain open.
