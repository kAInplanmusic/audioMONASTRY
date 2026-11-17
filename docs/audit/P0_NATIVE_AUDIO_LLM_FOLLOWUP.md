# Phase 0 follow-up: native audio/LLM handler port

> Integrationshinweis: Die unten genannten p0-Konsolenartefakte liegen jetzt unverändert im Evidence-Registry; die Zuordnung und Bytehashes erklärt [p0/README.md](p0/README.md). Dieser Bericht bewahrt den damaligen Prüfstand, einschließlich inzwischen erneut geprüfter Fehler.

2026-11-13 UTC · follows checkpoint `8a2f1f9` · local branch `fix/p0-vast-migration-typecheck`.

The user authorized reconnecting the existing audio/LLM implementation to the native Vast runtime. This resolves the missing productive Python helper decision in the earlier checkpoint. Old visual generation and visual LoRA training are excluded. No build, deployment, provider request, GPU inference or database write was performed.

## Implementation and parity

`services/audiomonastry-ai-runtime/handlers_native.py:1` ports the 481-line historical implementation from immutable `285ef5c:services/audiomonastry-ai-runtime/handlers_runpod.py` into a canonical provider-neutral module. Only its module documentation changes. The entire remaining AST, including all 18 function signatures/bodies, constants, imports and internal documentation, is identical to that historical source (`p0/native-helper-ast-parity-final.log`). An initial parity attempt changed an internal historical role label; that edit was reverted, and the successful comparison confirms exact parity.

Preserved contracts cover lazy dependency errors; bounded cache; validated/size-limited audio decoding; WAV preparation; speaker input resolution; causal model loading respecting catalog `trustRemoteCode`; chat output/token/timing metadata; Qwen text/audio; XTTS; ACE-Step generation and context delegation; context mixing; model-specific stem dispatch without silent fallback; and diarization. This reconnects existing functions and models; it introduces no provider REST transport, model catalog entry or visual generator. Historical model-library/GPU verification limitations remain.

Imports now use the canonical module at `handlers.py:590`, `handlers_voice.py:295,904`, `handlers_stems.py:553,678`, `handlers_ears.py:1010,1026`, `handlers_fleet2026.py:85`, and `moa_orchestrator.py:814`. Existing runtime and production tests import/mock that same canonical name; their assertions remain intact. There is no legacy shim file. The ComfyUI adapter's existing diagnostic reference names the current context delegate.

`Dockerfile.vast:6` overlays the helper and every changed consumer together on the immutable BASE_IMAGE. Generic `Dockerfile:55` and `Dockerfile.manifest:65` reference the existing native source filename. Build bases, dependencies, pins and models remain unchanged. The new `tests/test_native_handler_packaging.py` independently checks that the actual Vast overlay contains the helper and all import consumers, that source files exist and that productive files do not import the deleted module.

## Actual checks

All commands, UTC ISO times, exit codes and original output are preserved as JSON-formatted `.log` records under `p0/`. Tests use `/workspace/work/round2-python/bin/python`, the supplied local venv with soundfile 0.12.1. Credential environment values were scrubbed before invoking tests. Production test output describes mocked teardown fixtures; it does not indicate real infrastructure mutation.

| Check | Result | Evidence |
| --- | --- | --- |
| Full executable-module AST parity against immutable historical source | PASS, all 18 functions unchanged | `p0/native-helper-ast-parity-final.log` |
| Native Vast packaging regression | PASS, 1 test | `p0/native-packaging-test.log` |
| Runtime discovery | 431 tests, 425 pass, 6 errors; zero missing-handler or soundfile import errors | `p0/native-python-runtime-final.log` |
| Production discovery | PASS, 35 tests | `p0/native-python-production.log` |
| Fleet historical negative control after historical commit retrieval | PASS, original previously absent `a9b1487` now available | `p0/history-fixture-recheck.log` (parent execution) |

Runtime discovery previously executed 335 tests with 49 import errors. Restoring the module permits the previously inaccessible tests to run. The final six errors all arise from static assertions reading deleted `Dockerfile.runpod`; they are listed below rather than relabeled as successful Vast checks. There was no unrelated full TS/gate repetition; the earlier checkpoint's typecheck and gate evidence remains applicable to unchanged TS/runtime boundaries.

## Remaining static image contract gap

The six existing cases are unchanged except where the same test file's Python module imports were renamed:

- `test_dockerfile_torch.DockerfileTorchTest.test_beide_images_gleiche_torch_basis`.
- `test_dockerfile_torch.DockerfileTorchTest.test_beide_images_mindestens_torch_2_8` (deleted image subtest).
- `test_ears_handlers.ManifestDispatchTest.test_images_kopieren_handlers_ears`.
- `test_stem_handler.DispatchUndRoutingTest.test_dockerfiles_kopieren_die_neuen_module`.
- `test_voice_handlers.ImageTest.test_build_pins_gleich_handler_pins`.
- `test_voice_handlers.ImageTest.test_dockerfiles_kopieren_handlers_voice_und_pod_jobs`.

These require the removed RunPod Dockerfile's direct Torch base, optional ACE-Step/MOSS/Ears build arguments and commit declarations. Current `Dockerfile.vast` wraps a supplied immutable `BASE_IMAGE`; it declares none of those build parameters itself. Merely substituting `.vast` would misrepresent the contract. Source overlay is now verified separately; inherited dependency/pin equivalence remains unverified. No container was built or inspected, and no dependency design was invented.

Decision options for later work: validate each actual immutable role image's inherited dependency/commit metadata and migrate the tests to those demonstrated contracts; or explicitly retire the obsolete dual-image equality/build-argument contract with a documented replacement verification requirement. Either path needs a concrete current image contract, not guessed version strings. Existing `Dockerfile.manifest` also retains historical `runpod_worker.py` packaging references outside this source-module port; generic image COPY repair alone is not a claim that every historical image recipe builds.

Visual LoRA remains pending: the user has not separately authorized restoring a training implementation or removing its tests. Earlier A100/spatial baseline failures and documentation findings retain their earlier evidence. The fleet negative-control shallow-history limitation is resolved by the parent's exact targeted rerun, without changing test assertions.

## Architecture impact

All code remains in asynchronous/offline model inference paths. No DSP callback, audio-buffer lifecycle, collaboration lock or four-user session state was changed. Supplied secrets were not used, stored or printed. No push, merge or infrastructure operation occurred.
