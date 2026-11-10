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
