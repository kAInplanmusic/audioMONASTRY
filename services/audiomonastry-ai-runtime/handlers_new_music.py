"""RunPod A40 2026-11: MiniMax Music3 song and Music Flamingo 2601 analysis.

Only exact pinned ModelDefinition revisions are loaded. Imports are lazy, so
other audio roles remain independent of optional heavy model stacks.
"""
from __future__ import annotations

import base64
import io
import math
import os
import tempfile
import threading
from typing import Any, Dict

from model_manager import ModelDefinition, ModelUnavailableError

_SONG_LOCK = threading.RLock()
_FLAMINGO_LOCK = threading.RLock()
_SONG_CACHE: Dict[str, Any] = {}
_FLAMINGO_CACHE: Dict[str, Any] = {}


def bounded_duration(value: Any, ceiling: float = 300.0) -> float:
    try:
        seconds = float(value)
    except (ValueError, TypeError) as exc:
        raise ModelUnavailableError("durationSeconds must be numeric") from exc
    if not math.isfinite(seconds) or not 5 <= seconds <= ceiling:
        raise ModelUnavailableError(f"durationSeconds must be between 5 and {ceiling:g}")
    return seconds


def _pinned(definition: ModelDefinition, expected_repo: str) -> None:
    import re
    if definition.repository != expected_repo or not re.fullmatch(r"[0-9a-f]{40}", definition.revision):
        raise ModelUnavailableError(f"{definition.id}: repository/revision pin mismatch")


def load_minimax_music3(definition: ModelDefinition) -> Any:
    """Single A40 Diffusers path; NOT SGLang-Omni (two GPU pipeline)."""
    _pinned(definition, "MiniMaxAI/MiniMax-Music3")
    key = definition.repository + "@" + definition.revision
    with _SONG_LOCK:
        if key in _SONG_CACHE:
            return _SONG_CACHE[key]
        try:
            import torch
            from diffusers import ModularPipeline
        except (ImportError, AttributeError) as exc:
            raise ModelUnavailableError("MiniMax Music3 requires the pinned Diffusers ModularPipeline build") from exc
        if not torch.cuda.is_available():
            raise ModelUnavailableError("MiniMax Music3 requires a CUDA GPU")
        try:
            pipe = ModularPipeline.from_pretrained(definition.repository, revision=definition.revision)
            pipe.load_components(dtype=torch.bfloat16)
            pipe.to("cuda")
        except Exception as exc:
            raise ModelUnavailableError(f"MiniMax Music3 single-GPU load failed: {type(exc).__name__}: {str(exc)[:180]}") from exc
        _SONG_CACHE[key] = pipe
        return pipe


def generate_minimax_song(model_id: str, definition: ModelDefinition, payload: Dict[str, Any]) -> Dict[str, Any]:
    if model_id != "minimax-music3":
        raise ModelUnavailableError("unexpected song model for MiniMax handler")
    prompt = str(payload.get("prompt", "")).strip()[:5000]
    lyrics = str(payload.get("lyrics", "")).strip()[:20000]
    if not prompt:
        raise ModelUnavailableError("prompt required")
    if not lyrics:
        raise ModelUnavailableError("lyrics required for full-song MiniMax Music3 generation")
    seconds = bounded_duration(payload.get("durationSeconds", payload.get("maxDuration", 120)))
    raw_seed = payload.get("seed", 7)
    if not isinstance(raw_seed, int) or isinstance(raw_seed, bool) or not 0 <= raw_seed < 2**32:
        raise ModelUnavailableError("seed must be integer 0..2^32-1")
    try:
        import torch
        import soundfile as sf
    except ImportError as exc:
        raise ModelUnavailableError("torch + soundfile required") from exc
    pipe = load_minimax_music3(definition)
    with _SONG_LOCK, torch.inference_mode():
        try:
            audio = pipe(
                prompt=prompt, lyrics=lyrics, audio_duration=seconds,
                generator=torch.Generator("cuda").manual_seed(raw_seed),
                output="audios",
            )[0]
            sr = int(pipe.sampling_rate)
            if sr <= 0 or sr > 192000:
                raise ValueError("invalid output sample rate")
            buf = io.BytesIO()
            sf.write(buf, audio.T.float().cpu().numpy(), sr, format="WAV", subtype="PCM_16")
        except Exception as exc:
            raise ModelUnavailableError(f"MiniMax Music3 inference failed: {type(exc).__name__}: {str(exc)[:180]}") from exc
    return {"audioBase64": base64.b64encode(buf.getvalue()).decode("ascii"), "sampleRate": sr, "model": model_id}


def load_music_flamingo(definition: ModelDefinition) -> Any:
    _pinned(definition, "nvidia/music-flamingo-2601-hf")
    key = definition.repository + "@" + definition.revision
    with _FLAMINGO_LOCK:
        if key in _FLAMINGO_CACHE:
            return _FLAMINGO_CACHE[key]
        try:
            import torch
            from transformers import AutoProcessor, MusicFlamingoForConditionalGeneration
        except (ImportError, AttributeError) as exc:
            raise ModelUnavailableError("MusicFlamingo 2601 requires a Transformers build with MusicFlamingo support") from exc
        if not torch.cuda.is_available():
            raise ModelUnavailableError("MusicFlamingo 2601 requires CUDA")
        try:
            proc = AutoProcessor.from_pretrained(definition.repository, revision=definition.revision)
            model = MusicFlamingoForConditionalGeneration.from_pretrained(
                definition.repository, revision=definition.revision, dtype=torch.bfloat16,
                device_map="auto",
            ).eval()
        except Exception as exc:
            raise ModelUnavailableError(f"MusicFlamingo 2601 load failed: {type(exc).__name__}: {str(exc)[:180]}") from exc
        _FLAMINGO_CACHE[key] = (proc, model)
        return proc, model


def analyze_music_for_existing_visuals(model_id: str, definition: ModelDefinition, payload: Dict[str, Any]) -> Dict[str, Any]:
    """Audio -> text cues ONLY. Cannot generate images/video or fetch URLs."""
    if model_id != "music-flamingo":
        raise ModelUnavailableError("not a MusicFlamingo model")
    # Noncommercial license: explicitly enable research or obtain authorization.
    if os.environ.get("AI_MUSIC_FLAMINGO_RESEARCH_APPROVED", "") != "1":
        raise ModelUnavailableError("NVIDIA noncommercial license gate not approved")
    b64 = payload.get("audioBase64")
    if not isinstance(b64, str) or len(b64) > 64 * 1024 * 1024:
        raise ModelUnavailableError("inline WAV/FLAC/MP3 audioBase64 required; max 48MB raw")
    try:
        content = base64.b64decode(b64, validate=True)
    except (ValueError, base64.binascii.Error) as exc:
        raise ModelUnavailableError("invalid audioBase64") from exc
    if not content or len(content) > 48 * 1024 * 1024:
        raise ModelUnavailableError("audio byte length out of range")
    prompt = str(payload.get("prompt", "Describe the mood, instruments, energy and sections of this music for selecting existing images and videos."))[:2000]
    proc, model = load_music_flamingo(definition)
    try:
        import torch
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=True) as sound:
            sound.write(content)
            sound.flush()
            conv = [{"role": "user", "content": [{"type": "text", "text": prompt}, {"type": "audio", "path": sound.name}]}]
            inputs = proc.apply_chat_template(conv, tokenize=True, add_generation_prompt=True, return_dict=True).to(model.device)
            if "input_features" in inputs:
                inputs["input_features"] = inputs["input_features"].to(model.dtype)
            with _FLAMINGO_LOCK, torch.inference_mode():
                ids = model.generate(**inputs, max_new_tokens=512)
            result = proc.batch_decode(ids[:, inputs.input_ids.shape[1]:], skip_special_tokens=True)[0]
    except Exception as exc:
        raise ModelUnavailableError(f"MusicFlamingo inference failed: {type(exc).__name__}: {str(exc)[:180]}") from exc
    return {"analysisText": result, "existingMediaOnly": True, "generatedVisuals": False, "model": model_id}
