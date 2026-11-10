"""A04 ACE-Step XL Turbo with REQUIRED ACE-Step 5Hz LM 4B.

Official AceStepHandler + LLMHandler in same GPU pod. Fails closed if 4B
music planner cannot initialize; NEVER silently degrades to DiT-only.
"""
from __future__ import annotations

import base64
import os
import shutil
import tempfile
import threading
from typing import Any, Dict

from model_manager import ModelDefinition, ModelUnavailableError

_LM = {}
_LOCK = threading.RLock()


def _load_lm4b(dit_model_id: str, definition: ModelDefinition):
    from handlers_voice import (
        _manifest_definition, _check_revision, snapshot, _has_weights,
        _materialize, acestep_checkpoints, cap_lm_gpu_memory, _require
    )
    model_id = "acestep-5hz-lm-4b"
    lmdef = _manifest_definition(model_id)
    repo, rev = _check_revision(model_id, lmdef)
    if repo != "ACE-Step/acestep-5Hz-lm-4B" or lmdef.quantization != "bf16":
        raise ModelUnavailableError("A04 LM must be the pinned original 4B BF16 weights")
    project_root, ckpt = acestep_checkpoints(dit_model_id, definition)
    folder_name = "acestep-5Hz-lm-4B"
    key = repo + "@" + rev
    with _LOCK:
        if key in _LM:
            return _LM[key]
        snap = snapshot(model_id, repo, rev)
        if not _has_weights(snap):
            raise ModelUnavailableError("ACE-Step 4B LM weights missing")
        target = os.path.join(ckpt, folder_name)
        if not _has_weights(target):
            shutil.rmtree(target, ignore_errors=True)
            _materialize(snap, target)
        handler_module = _require("acestep.llm_inference", "acestep.llm_inference")
        llm = handler_module.LLMHandler()
        cap_lm_gpu_memory(llm)
        backend = str(os.environ.get("ACESTEP_LM_BACKEND", "vllm")).strip().lower()
        if backend not in ("vllm", "pt"):
            raise ModelUnavailableError("unsupported ACE-Step LM backend")
        try:
            status, ok = llm.initialize(
                checkpoint_dir=ckpt, lm_model_path=folder_name,
                backend=backend, device="cuda", offload_to_cpu=False, dtype=None
            )
        except Exception as exc:
            raise ModelUnavailableError("4B LM initialization failed: " + type(exc).__name__ + ": " + str(exc)) from exc
        if not ok or not getattr(llm, "llm_initialized", False):
            raise ModelUnavailableError("4B LM not initialized: " + str(status)[:300])
        _LM[key] = llm
        return llm


def generate_turbo(model_id: str, definition: ModelDefinition, payload: Dict[str, Any]) -> Dict[str, Any]:
    if model_id != "acestep-v15-xl-turbo":
        raise ModelUnavailableError("wrong ACE-Step music model: expected XL Turbo")
    from handlers_voice import acestep_dit, install_step_abort, _require, _read_result, current_cancel_token
    from pod_jobs import JobCancelled
    from handlers_runpod import _text_from
    prompt = _text_from(payload)
    if not prompt or len(prompt) > 3000:
        raise ModelUnavailableError("XL Turbo requires short music caption")
    lyrics = str(payload.get("lyrics") or "")
    if len(lyrics) > 8000:
        raise ModelUnavailableError("XL Turbo lyrics too long")
    duration = float(payload.get("durationSeconds") or 30)
    if not 10 <= duration <= 600:
        raise ModelUnavailableError("XL Turbo duration outside 10..600 seconds")
    try:
        steps = int(payload.get("inferenceSteps", 8))
        if steps != 8:
            raise ModelUnavailableError("XL Turbo locked at 8 inference steps")
        seed = int(payload.get("seed", -1))
    except (ValueError, TypeError) as exc:
        raise ModelUnavailableError("invalid XL Turbo seed/steps") from exc
    inference = _require("acestep.inference", "acestep")
    dit = acestep_dit(model_id, definition)
    lm = _load_lm4b(model_id, definition)
    params = inference.GenerationParams(
        task_type="text2music", caption=prompt, lyrics=lyrics,
        duration=duration, instrumental=bool(payload.get("instrumental", not bool(lyrics))),
        inference_steps=8, thinking=True,
        use_cot_metas=True, use_cot_caption=True, use_cot_language=bool(lyrics),
        seed=seed,
    )
    cfg = inference.GenerationConfig(batch_size=1, use_random_seed=seed < 0,
                                     seeds=[seed] if seed >= 0 else None, audio_format="wav")
    token = current_cancel_token()
    if token is not None:
        token.raise_if_cancelled("Turbo before generation")
    workdir = tempfile.mkdtemp(prefix="acestep-turbo-")
    remove, info = install_step_abort(dit, token)
    try:
        result = inference.generate_music(dit, lm, params, cfg, save_dir=workdir)
        if token is not None and token.cancelled:
            raise JobCancelled("XL Turbo cancelled")
        if not getattr(result, "success", False):
            raise ModelUnavailableError("XL Turbo+4B LM failed: " + str(getattr(result, "error", "unknown")))
        audios = getattr(result, "audios", None) or []
        if not audios or not isinstance(audios[0], dict) or not audios[0].get("path"):
            raise ModelUnavailableError("XL Turbo generated no WAV file")
        source_path = os.path.realpath(str(audios[0]["path"]))
        if not source_path.startswith(os.path.realpath(workdir) + os.sep):
            raise ModelUnavailableError("Turbo output outside bounded workdir")
        data, fmt = _read_result(audios[0])
        return {"modelId": model_id, "revision": definition.revision,
                "lmModelId": "acestep-5hz-lm-4b", "inferenceSteps": 8,
                "durationRequestedSeconds": duration, "sampleRate": int(audios[0].get("sample_rate") or 48000),
                "audioBase64": data, "format": fmt, "steps": info["steps"]}
    except JobCancelled:
        raise
    except ModelUnavailableError:
        raise
    except Exception as exc:
        raise ModelUnavailableError("ACE-Step XL Turbo failed: " + type(exc).__name__ + ": " + str(exc)) from exc
    finally:
        remove()
        shutil.rmtree(workdir, ignore_errors=True)
