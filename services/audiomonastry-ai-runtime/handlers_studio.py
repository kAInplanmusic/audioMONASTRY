"""A05/A08 real non-cloning audio restoration and processing inference adapters.

SonicMaster is called through its upstream infer_single.py CLI; UniverSR uses
the original Python class. DeReverb uses the pinned MSST model checkpoint.
No silent bypass, demo audio or fake WAV output is ever returned.
"""
from __future__ import annotations

import base64
import io
import os
import pathlib
import subprocess
import sys
import tempfile
import threading
from typing import Any, Dict

from model_manager import ModelDefinition, ModelUnavailableError

_LOCK = threading.Lock()
_SR_MODELS = {}


def _source_audio(payload: Dict[str, Any], max_bytes: int = 100 * 1024 * 1024):
    import soundfile as sf
    from handlers_ears import audio_bytes
    raw = audio_bytes(payload)
    if len(raw) > max_bytes:
        raise ModelUnavailableError("audio input exceeds file size cap")
    try:
        samples, sr = sf.read(io.BytesIO(raw), dtype="float32", always_2d=True)
        if sr <= 0 or samples.size == 0:
            raise ValueError("empty audio")
        return samples, int(sr)
    except Exception as exc:
        raise ModelUnavailableError("audio decode failed: " + str(exc)) from exc


def _wav_result(model_id: str, sr: int, samples: Any, payload: Dict[str, Any]) -> Dict[str, Any]:
    import soundfile as sf
    import numpy as np
    y = np.asarray(samples, dtype=np.float32)
    if y.ndim == 1:
        y = y[:, None]
    if not y.size or not np.all(np.isfinite(y)):
        raise ModelUnavailableError("model returned empty or non-finite audio")
    buf = io.BytesIO()
    sf.write(buf, y, sr, format="WAV", subtype="PCM_24")
    wav = buf.getvalue()
    output_url = payload.get("outputUrl")
    if output_url:
        from urllib.parse import urlsplit
        host = urlsplit(str(output_url)).hostname
        allowed = set(x.strip().lower() for x in
                      os.environ.get("AI_PRESIGNED_STORAGE_HOSTS", "").split(",") if x.strip())
        u = urlsplit(str(output_url))
        if not allowed or u.scheme != "https" or host not in allowed or u.username or u.password:
            raise ModelUnavailableError("outputUrl is not an authorized signed object-storage host")
        from handlers_stems import put_object
        put_object(str(output_url), wav)
        obj = {"audioUploaded": True, "wavBytes": len(wav)}
    elif len(wav) <= 24 * 1024 * 1024:
        obj = {"audioBase64": base64.b64encode(wav).decode("ascii"), "wavBytes": len(wav)}
    else:
        raise ModelUnavailableError("large restoration output requires signed outputUrl")
    return {"modelId": model_id, "sampleRate": sr, "channels": int(y.shape[1]), **obj}


def sonicmaster_process(model_id: str, definition: ModelDefinition, payload: Dict[str, Any]) -> Dict[str, Any]:
    if model_id != "sonicmaster":
        raise ModelUnavailableError("incorrect SonicMaster model")
    samples, sr = _source_audio(payload)
    prompt = payload.get("prompt") or "Enhance the input audio"
    if not isinstance(prompt, str) or not 1 <= len(prompt) <= 1200:
        raise ModelUnavailableError("invalid SonicMaster prompt")
    script_root = pathlib.Path(os.environ.get("SONICMASTER_ROOT", "/opt/sonicmaster")).resolve()
    script = script_root / "infer_single.py"
    if not script.is_file():
        raise ModelUnavailableError("SonicMaster pinned code checkout missing")
    try:
        from huggingface_hub import hf_hub_download
        import soundfile as sf
        checkpoint = hf_hub_download(definition.repository, filename="model.safetensors",
                                     revision=definition.revision)
        with tempfile.TemporaryDirectory(prefix="audiomonastry-sm-") as tmp:
            input_wav = pathlib.Path(tmp) / "input.wav"
            output_wav = pathlib.Path(tmp) / "output.wav"
            sf.write(str(input_wav), samples, sr)
            args = [sys.executable, str(script), "--ckpt", str(checkpoint),
                    "--input", str(input_wav), "--prompt", prompt,
                    "--output", str(output_wav)]
            proc = subprocess.run(args, cwd=str(script_root), capture_output=True,
                                  timeout=min(900, max(60, int(definition.timeout or 600))), check=False)
            if proc.returncode != 0 or not output_wav.is_file() or output_wav.stat().st_size < 44:
                raise ModelUnavailableError("SonicMaster inference failed or produced no WAV")
            y, result_sr = sf.read(str(output_wav), dtype="float32", always_2d=True)
            return {"source": "SonicMaster",
                    **_wav_result(model_id, int(result_sr), y, payload)}
    except ModelUnavailableError:
        raise
    except Exception as exc:
        raise ModelUnavailableError("SonicMaster adapter failed: " + type(exc).__name__ + ": " + str(exc)) from exc


def universr_upsample(model_id: str, definition: ModelDefinition, payload: Dict[str, Any]) -> Dict[str, Any]:
    if model_id != "universr":
        raise ModelUnavailableError("incorrect UniverSR model")
    samples, sr = _source_audio(payload)
    if sr not in (8000, 12000, 16000, 24000):
        raise ModelUnavailableError("UniverSR supports input_sr 8/12/16/24 kHz")
    try:
        import soundfile as sf
        from universr import UniverSR
        with _LOCK:
            key = definition.repository + "@" + definition.revision
            if key not in _SR_MODELS:
                _SR_MODELS[key] = UniverSR.from_pretrained(definition.repository, device="cuda")
            model = _SR_MODELS[key]
        with tempfile.TemporaryDirectory(prefix="audiomonastry-universr-") as tmp:
            source = os.path.join(tmp, "input.wav")
            sf.write(source, samples, sr)
            enhanced = model.enhance(source, input_sr=sr)
        y = enhanced.detach().float().cpu().numpy()
        if y.ndim == 2:
            y = y.T
        return {"source": "UniverSR", **_wav_result(model_id, 48000, y, payload)}
    except ModelUnavailableError:
        raise
    except Exception as exc:
        raise ModelUnavailableError("UniverSR inference failed: " + type(exc).__name__ + ": " + str(exc)) from exc


def dereverb_process(model_id: str, definition: ModelDefinition, payload: Dict[str, Any]) -> Dict[str, Any]:
    if model_id != "mel-roformer-dereverb":
        raise ModelUnavailableError("incorrect DeReverb model")
    from handlers_stems import get_separator, decode_audio, prepare_mix
    from handlers_ears import audio_bytes
    separator = get_separator(model_id, definition)
    samples, sr = decode_audio(audio_bytes(payload))
    mixed = prepare_mix(samples, sr, separator.sample_rate)
    stems = separator.separate(mixed)
    if "noreverb" not in stems:
        raise ModelUnavailableError("DeReverb did not produce noreverb stem")
    y = stems["noreverb"].T
    return {"source": "MelBandRoformerDeReverb",
            **_wav_result(model_id, separator.sample_rate, y, payload)}
