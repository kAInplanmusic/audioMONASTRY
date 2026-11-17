# audioMONASTRY · Frontier AI Upgrade (2026-11-17)

## Current status

**CANDIDATE PREPARATION ONLY.** This commit is not evidence that weights were uploaded to R2, that any candidate can infer on a GPU, or that production was deployed.

The project owner requested best available self-hosted audio/music/video models for eight roles, even when they require larger GPUs. The existing 22 production model identities remain unchanged until complete runtime and quality verification. Immutable HF model revision IDs for nine additional candidates appear in deploy/gpu/frontier-candidates.json.

All candidates are uploaded, when authorized, into a distinct prefix: weights-candidates/. Production continues to read weights/ and its own model_manifest.json.

## Binding product decisions

1. NO microphone speech control or STT. TTS generation from text remains enabled. Do not reenable Whisper/Qwen ASR/pyannote as user input.
2. Ears: deterministic DSP at low latency plus asynchronous high-fidelity music interpretation, exposed through a confidence-aware, sample-timestamped Music Feature Bus.
3. Studio: export vocals, drums, bass, guitar, piano and other, with pure unaltered stems plus optional separate enhanced versions. Quality tested against audible bleed, artefacts, phase and reconstruction, including acoustic Bluegrass instrumentation.
4. Brain plans and selects specialists; Audio-Brain executes validated, permission-checked, undoable app commands. A small CPU preflight decides whether a GPU is needed.
5. Voice handles Qwen-TTS and MOSS sound effects, not STT. ACE-Step shared assets are logically managed by Music.
6. Vis is two paths: real-time feature-bus-driven WebGL/WebGPU and offline neural image/video generation. Rendered frames must not block audio processing.
7. Noncommercial use is intended; gated access, publisher licenses and downstream terms must still be checked.
8. Keep the 8 EUR/h budget guardrail. Load expensive high-quality models sequentially where needed.

## Model candidates with immutable references

| Role | New ID | Reason | Gate |
|---|---|---|---|
| ears | moss-music-8b-thinking | music reasoning vs Instruct | compare accuracy/latency |
| ears | mert-v2-fullsong | feature encoder | sample rate + license |
| ears | sheetsage2 | transcription to chords/melody | requires MERT backbone |
| ears | muscriptor-large | polyphonic multi-instrument MIDI | gated HF access |
| audio-brain | qwen3.5-9b | executor challenger | API schema + latency |
| music | magenta-realtime-2 | interactive live music research | NVIDIA real-time proof |
| vis | ltx-2.5 | image/audio to video champion | gated HF license + runtime |
| vis | wan2.2-i2v-a14b | image-to-video challenger | VRAM + visual QA |
| vis | cosmos3-super-i2v-4step | large research-grade I2V | separate very-large GPU |

External extra implementation candidates not yet revision-locked:
- Beat This! Live: https://github.com/CPJKU/beat_this_live (online beat tracking, published checkpoints)
- Matchering 2: https://github.com/sergree/matchering (mastering DSP, no model weights)
- Additional 6-stem/vocal separation specialists: do not guess licenses, files or revisions.

## Gated repository links

- https://huggingface.co/MuScriptor/muscriptor-large
- https://huggingface.co/Lightricks/LTX-2.5

Accept terms in Hugging Face account and create a repository-scoped read-only HF_TOKEN for automatic download. An approval request may have to be accepted by publisher.

## R2 configuration — never commit secrets

Configure these protected environment variables:
- CFS3_ACCESS_KEY: R2 S3-compatible Access Key ID.
- CFS3_SECRET_KEY: corresponding R2 Secret Access Key.
- CFS3_BUCKET: verified bucket name, documented as audiomonastrysamples.
- CFR2_ACCOUNT_ID: Cloudflare account ID (or CFS3_ENDPOINT).
- HF_TOKEN: restricted Hugging Face read token for gated repositories.

Cloudflare account API tokens are NOT interchangeable with R2 S3 keys. Do not place secrets into chat logs, Git code, issue descriptions, files or workflow outputs. Rotate any token previously exposed in conversation.

The optional GitHub workflow requires protected Actions secrets of those exact names and a dedicated self-hosted runner labeled r2-weights with ample staging disk. The workflow does NOT automatically configure secrets or provision hardware.

## Safe transfer

1. Examine manifest for all nine repos and immutable upstream revisions.
2. Dry run without network or credentials: python3 scripts/frontier-r2-mirror.py
3. Mirror one candidate: python3 scripts/frontier-r2-mirror.py --yes --only qwen3.5-9b --workdir /data/r2-weight-stage
4. Mirror the eligible set after size/approval check: python3 scripts/frontier-r2-mirror.py --yes --all --skip-research --workdir /data/r2-weight-stage
5. Download/rehash R2 objects for independent integrity audit after each upload. Script verifies TAR and .sha256 sidecar and metadata but no independent remote rehash.
6. Test GPU container imports, resolved model dependencies, realistic inference, quality and memory peaks before production promotion.

Do not assume that HF weights alone make a model executable. Models may need different runtime code, checkpoint structure, adapters, VAE, tokenizer or renderer service.

## Required release gates

- [ ] All expected checkpoint files + dependencies resolved and hashed.
- [ ] Gated access/license verified where applicable.
- [ ] R2 object upload and remote integrity verified.
- [ ] Model runtime/handler actually implemented; immutable container built.
- [ ] Role-specific GPU inference and peak VRAM measured at realistic length and concurrency.
- [ ] No STT or microphone user-input path enabled.
- [ ] Six stem baseline and enhancer A/B tests on real acoustic/mixed material passed.
- [ ] Executor commands validated for permission, effect, undo and correct failure.
- [ ] Music Feature Bus consumers and live renderer verified without blocking AudioWorklets.
- [ ] Golden Master, rollback, cost cap and fleet safety tests passed.
- [ ] Only after gates: promote candidates into active model_manifest.json and pod-fleet.json.

No GPU provisioning, R2 production overwrites, automatic promotion or live deployment are authorized by this document.
