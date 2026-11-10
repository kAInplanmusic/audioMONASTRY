"""MOSS-Music 8B Instruct: revision-pinned original HF custom model.

Loads the actual multimodal audio encoder, never a text-only surrogate.
Model-specific CUDA/quality test remains necessary before deployment.
"""
from __future__ import annotations

import threading
from typing import Any, Dict

from model_manager import ModelDefinition, ModelUnavailableError

_CACHE: Dict[str, Any] = {}
_LOCK = threading.Lock()


def load_moss_music(model_id: str, definition: ModelDefinition) -> Any:
    from handlers_ears import pinned_source, require_remote_code
    require_remote_code(model_id, definition)
    repo, rev = pinned_source(model_id, definition)
    if repo != "OpenMOSS-Team/MOSS-Music-8B-Instruct":
        raise ModelUnavailableError("MOSS-Music repository does not match chosen source")
    key = repo + "@" + rev
    with _LOCK:
        if key in _CACHE:
            return _CACHE[key]
        try:
            import torch
            from transformers.dynamic_module_utils import get_class_from_dynamic_module
            Model = get_class_from_dynamic_module("modeling_moss_music.MossMusicModel", repo, revision=rev)
            Processor = get_class_from_dynamic_module("processing_moss_music.MossMusicProcessor", repo, revision=rev)
            if not torch.cuda.is_available():
                raise ModelUnavailableError("MOSS-Music BF16 requires CUDA")
            model = Model.from_pretrained(repo, revision=rev, trust_remote_code=True,
                                          torch_dtype=torch.bfloat16, device_map="cuda:0").eval()
            processor = Processor.from_pretrained(repo, revision=rev, trust_remote_code=True,
                                                   enable_time_marker=True)
            _CACHE[key] = (model, processor)
            return _CACHE[key]
        except ModelUnavailableError:
            raise
        except Exception as exc:
            raise ModelUnavailableError("MOSS-Music load failed: " + type(exc).__name__ + ": " + str(exc)) from exc


def moss_music_understand(model_id: str, definition: ModelDefinition, payload: Dict[str, Any]) -> Dict[str, Any]:
    from handlers_ears import load_audio, resample
    try:
        import torch
    except ImportError as exc:
        raise ModelUnavailableError("torch required for MOSS-Music") from exc
    prompt = str(payload.get("question") or payload.get("prompt") or
                 "Analyze this music: instruments, harmony, song form, rhythm, genre and mood. "
                 "Distinguish measurements from uncertain interpretation.").strip()
    if not 1 <= len(prompt) <= 2000:
        raise ModelUnavailableError("MOSS-Music question must have 1..2000 characters")
    samples, sr, seconds = load_audio(payload, definition, max_seconds=600)
    model, processor = load_moss_music(model_id, definition)
    try:
        audio = resample(samples, sr, int(processor.config.mel_sr))
        inputs = processor(text=prompt, audios=[audio], return_tensors="pt").to(model.device)
        if inputs.get("audio_data") is not None:
            inputs["audio_data"] = inputs["audio_data"].to(model.dtype)
        inputs["audio_input_mask"] = inputs["input_ids"] == processor.audio_token_id
        tokens = max(32, min(2048, int(payload.get("maxTokens", 768))))
        with torch.inference_mode():
            generated = model.generate(**inputs, max_new_tokens=tokens,
                                       do_sample=False, num_beams=1, use_cache=True)
        analysis = processor.decode(generated[0, inputs["input_ids"].shape[-1]:],
                                    skip_special_tokens=True)
        if not analysis or not analysis.strip():
            raise ModelUnavailableError("MOSS-Music returned no analysis")
        return {"modelId": model_id, "revision": definition.revision,
                "seconds": round(seconds, 3), "analysis": str(analysis).strip(),
                "source": "real_moss_music_audio"}
    except ModelUnavailableError:
        raise
    except Exception as exc:
        raise ModelUnavailableError("MOSS-Music inference failed: " + type(exc).__name__ + ": " + str(exc)) from exc
