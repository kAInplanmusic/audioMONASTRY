"""A07 YuE2-3B BF16 AR/NAR + original FP32 YuE2-Vae, one job at a time.

Uses the official yue2-infer package and emits real WAV bytes or an R2 result URI.
A single candidate is one inference; Best-of-8 requires eight separate runs.
"""
from __future__ import annotations

import base64
import io
import os
import threading
from typing import Any, Dict

from model_manager import ModelDefinition, ModelUnavailableError

_LOCK = threading.Lock()
_PIPE = {}
_RUN = threading.Lock()
_MAX_INLINE_WAV = 25 * 1024 * 1024


def load_yue2(definition: ModelDefinition):
    key = definition.repository + "@" + definition.revision
    with _LOCK:
        if key not in _PIPE:
            try:
                import torch
                from yue2 import YuE2Pipeline
                if not torch.cuda.is_available():
                    raise ModelUnavailableError("YuE2 requires a BF16-capable CUDA GPU")
                _PIPE[key] = YuE2Pipeline.from_pretrained(
                    definition.repository, revision=definition.revision,
                    device="cuda")
            except ModelUnavailableError:
                raise
            except Exception as exc:
                raise ModelUnavailableError("YuE2 model load failed: " + str(exc)) from exc
        return _PIPE[key]


def generate_yue2(model_id: str, definition: ModelDefinition, payload: Dict[str, Any]) -> Dict[str, Any]:
    if model_id != "yue2-3b" or definition.repository != "m-a-p/YuE2-3B":
        raise ModelUnavailableError("YuE2: only selected original checkpoint allowed")
    style, lyrics = payload.get("style"), payload.get("lyrics")
    if not isinstance(style, str) or not 1 <= len(style) <= 3000:
        raise ModelUnavailableError("YuE2 requires style (1..3000 chars)")
    if not isinstance(lyrics, str) or not 1 <= len(lyrics) <= 24000:
        raise ModelUnavailableError("YuE2 requires lyrics (1..24000 chars)")
    cot = str(payload.get("cot", "full"))
    if cot not in ("full", "melody", "off"):
        raise ModelUnavailableError("YuE2 cot must be full/melody/off")
    args = {"style": style, "lyrics": lyrics, "cot": cot}
    if "seed" in payload:
        args["seed"] = int(payload["seed"])
    if "abc" in payload:
        abc = payload["abc"]
        if not isinstance(abc, str) or len(abc) > 50000 or cot == "off":
            raise ModelUnavailableError("YuE2 ABC requires full/melody plan and bounded score")
        args["abc"] = abc
    if "cfg_scale" in payload:
        guidance = float(payload["cfg_scale"])
        if not 0.5 <= guidance <= 3:
            raise ModelUnavailableError("YuE2 cfg_scale out of bounds")
        args["cfg_scale"] = guidance
    if not _RUN.acquire(blocking=False):
        raise ModelUnavailableError("YuE2 already generating: exactly one song job per plugin")
    try:
        pipe = load_yue2(definition)
        song = pipe(**args)
        import soundfile as sf
        import numpy as np
        import tempfile
        with tempfile.TemporaryDirectory(prefix="yue2-") as root:
            target = os.path.join(root, "song.flac")
            song.save(target)
            samples, sr = sf.read(target, dtype="float32", always_2d=True)
            if sr != 48000 or samples.shape[1] != 2 or samples.size == 0:
                raise ModelUnavailableError("YuE2 unexpected audio format; expected 48kHz stereo")
            buf = io.BytesIO()
            sf.write(buf, samples, sr, format="WAV", subtype="PCM_24")
            wav = buf.getvalue()
            if len(wav) > _MAX_INLINE_WAV:
                from handlers_stems import put_object
                uri = payload.get("outputUrl")
                if not isinstance(uri, str) or not uri.startswith("https://"):
                    raise ModelUnavailableError("YuE2 long song requires signed outputUrl; inline WAV max 25MB")
                put_object(uri, wav)
                audio_result = {"audioUploaded": True, "wavBytes": len(wav)}
            else:
                audio_result = {"audioBase64": base64.b64encode(wav).decode("ascii"),
                                "wavBytes": len(wav)}
            return {"modelId": model_id, "revision": definition.revision, "source": "yue2_original",
                    "durationSeconds": round(len(samples) / sr, 3), "sampleRate": sr,
                    "channels": 2, "truncated": bool(getattr(song, "truncated", False)), **audio_result}
    except ModelUnavailableError:
        raise
    except Exception as exc:
        raise ModelUnavailableError("YuE2 inference failed: " + type(exc).__name__ + ": " + str(exc)) from exc
    finally:
        _RUN.release()
