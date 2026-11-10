"""SonicMaster master/restoration adapter.

Uses upstream AMAAI-Lab/SonicMaster/infer_single.py, *not* a made-up HF
model API. Upstream code must be preinstalled and reviewed in the image.
The model checkpoint is fetched at the immutable manifest commit. No runtime
git clone, shell, untrusted URL or implicit fallback is allowed.
"""
from __future__ import annotations
import base64
import io
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from typing import Any, Dict

from model_manager import ModelDefinition, ModelUnavailableError

MODEL_ID="sonicmaster"
REPO="amaai-lab/SonicMaster"
SCRIPT="infer_single.py"
MAX_INPUT_BYTES=25*1024*1024
MAX_OUTPUT_BYTES=32*1024*1024

def sonicmaster_master(model_id: str, definition: ModelDefinition, payload: Dict[str, Any]) -> Dict[str, Any]:
    if model_id!=MODEL_ID or definition.repository!=REPO:
        raise ModelUnavailableError("SonicMaster model identity does not match SSOT")
    if not isinstance(payload,dict):
        raise ModelUnavailableError("audio.master requires an input object")
    root=Path(os.environ.get("SONICMASTER_ROOT","/opt/sonicmaster")).resolve()
    script=(root/SCRIPT).resolve()
    if not script.is_file() or script.parent!=root:
        raise ModelUnavailableError("SonicMaster upstream infer_single.py not installed at SONICMASTER_ROOT")
    if not (root/"configs"/"tangoflux_config.yaml").is_file():
        raise ModelUnavailableError("SonicMaster upstream configuration missing")
    try:
        import torch
        import soundfile as sf
        import numpy as np
        from huggingface_hub import hf_hub_download
        from handlers import _audio_bytes
    except ImportError as exc:
        raise ModelUnavailableError(f"SonicMaster dependency missing: {type(exc).__name__}") from exc
    if not torch.cuda.is_available():
        raise ModelUnavailableError("SonicMaster needs real CUDA; simulated/CPU inference rejected")
    text=str(payload.get("prompt") or "Apply balanced music mastering; preserve dynamics and stereo image.").strip()
    if not 1 <= len(text) <= 800:
        raise ModelUnavailableError("SonicMaster prompt must contain 1..800 characters")
    raw=_audio_bytes(payload)
    if len(raw)>MAX_INPUT_BYTES:
        raise ModelUnavailableError("SonicMaster input exceeds 25 MiB")
    try:
        samples, rate=sf.read(io.BytesIO(raw), dtype="float32", always_2d=True)
    except Exception as exc:
        raise ModelUnavailableError(f"SonicMaster WAV input invalid: {type(exc).__name__}") from exc
    if rate not in (16000,22050,24000,32000,44100,48000,88200,96000):
        raise ModelUnavailableError("SonicMaster input sample rate is unsupported")
    if samples.size==0 or samples.shape[1]>2 or samples.shape[0]/rate>120:
        raise ModelUnavailableError("SonicMaster supports up to 120 seconds stereo/mono per invocation")
    if not np.isfinite(samples).all():
        raise ModelUnavailableError("SonicMaster input contains non-finite samples")
    revision=str(definition.revision)
    if len(revision)!=40 or any(ch not in "0123456789abcdef" for ch in revision):
        raise ModelUnavailableError("SonicMaster requires immutable manifest revision")
    # HF client verifies its cache/download protocol; a separate SHA256 inventory
    # gate must still verify exact content in R2 before production approval.
    try:
        ckpt=hf_hub_download(repo_id=REPO,filename="model.safetensors",revision=revision,local_files_only=True)
    except Exception as exc:
        raise ModelUnavailableError(f"SonicMaster pinned checkpoint absent from offline cache: {type(exc).__name__}") from exc
    with tempfile.TemporaryDirectory(prefix="am-sonic-") as folder:
        source=Path(folder)/"input.wav"
        output=Path(folder)/"output.wav"
        sf.write(str(source),samples,rate,format="WAV",subtype="PCM_24")
        cmd=[sys.executable,str(script),"--ckpt",str(ckpt),"--input",str(source),
             "--prompt",text,"--output",str(output),"--config",str(root/"configs"/"tangoflux_config.yaml"),
             "--fs","44100","--num_inference_steps","10"]
        try:
            process=subprocess.run(cmd,cwd=str(root),capture_output=True,timeout=600,check=False)
        except subprocess.TimeoutExpired as exc:
            raise ModelUnavailableError("SonicMaster inference timed out") from exc
        if process.returncode:
            # Upstream stdout/stderr may contain paths or secrets; do not forward it.
            raise ModelUnavailableError(f"SonicMaster upstream subprocess failed (exit {process.returncode})")
        if not output.is_file() or not 44 <= output.stat().st_size <= MAX_OUTPUT_BYTES:
            raise ModelUnavailableError("SonicMaster failed to produce a valid-size WAV")
        try:
            done,sr=sf.read(str(output),always_2d=True,dtype="float32")
        except Exception as exc:
            raise ModelUnavailableError(f"SonicMaster output WAV is unreadable: {type(exc).__name__}") from exc
        if done.size==0 or done.shape[1]>2 or not np.isfinite(done).all():
            raise ModelUnavailableError("SonicMaster output invalid or contains NaNs")
        blob=output.read_bytes()
        return {"audioBase64":base64.b64encode(blob).decode("ascii"),
                "format":"wav","sampleRate":int(sr),"durationSeconds":round(done.shape[0]/sr,3),
                "model":model_id,"qualityVerified":False}
