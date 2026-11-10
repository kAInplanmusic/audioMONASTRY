"""Fail-closed GPU model proof gate for resident RunPod Pods.

A model being in ModelManager._loaded is NOT a proof: without a loader, this
can be a VRAM accounting reservation. Production /ready MUST wait for actual
successful per-model inference, rather than trusting accounting or /health.

Proof fixtures are installed on the Pod by the operator, not taken from requests.
Do not log raw payloads or model output (PII/audio/keys could be present).
"""
from __future__ import annotations

import base64
import json
import os
from pathlib import Path
from typing import Any, Dict, List, Tuple

REQUIRED_DEPENDENCIES = {"acestep-v15-shared", "acestep-5hz-lm-4b"}
MAX_FIXTURE_BYTES = 8 * 1024 * 1024
ALLOWED_RESULT_KINDS = {"text", "audio", "midi", "structured"}
SKIP_RESULT_FIELDS = {"model", "task", "status", "qualityVerified", "success", "durationMs"}


class ProbeFailure(RuntimeError):
    pass


def load_fixtures(filename: str) -> Dict[str, Any]:
    path = Path(filename)
    if not path.is_file() or path.stat().st_size > MAX_FIXTURE_BYTES:
        raise ProbeFailure("model verification fixture is missing or exceeds 8 MiB")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise ProbeFailure("model verification fixture is not valid JSON") from exc
    if not isinstance(value, dict) or not isinstance(value.get("models"), dict):
        raise ProbeFailure("fixture must contain a models object")
    return value["models"]


def _non_empty_result(result: Any, proof: Dict[str, Any]) -> None:
    if not isinstance(result, dict):
        raise ProbeFailure("model returned no structured result object")
    keys = proof.get("requiredResultKeys")
    kind = proof.get("kind")
    if kind not in ALLOWED_RESULT_KINDS:
        raise ProbeFailure("fixture requires kind: text/audio/midi/structured")
    if (not isinstance(keys, list) or not keys or
            any(not isinstance(k, str) or k in SKIP_RESULT_FIELDS for k in keys)):
        raise ProbeFailure("requiredResultKeys must contain real output fields")
    for key in keys:
        val = result.get(key)
        if val is None or val == "" or val == [] or val == {}:
            raise ProbeFailure(f"required output field {key} was empty")
    if kind == "audio":
        raw = result.get("audioBase64")
        if not isinstance(raw, str) or len(raw) < 100:
            raise ProbeFailure("audio output must have nonempty audioBase64")
        try:
            blob = base64.b64decode(raw, validate=True)
        except (ValueError, base64.binascii.Error) as exc:
            raise ProbeFailure("audio output was not valid base64") from exc
        if len(blob) < 44 or not (blob.startswith(b"RIFF") or blob.startswith(b"fLaC")):
            raise ProbeFailure("audio output lacks WAV/FLAC signature")
    elif kind == "midi":
        raw = result.get("midiBase64")
        if not isinstance(raw, str):
            raise ProbeFailure("MIDI output must contain midiBase64")
        try:
            blob = base64.b64decode(raw, validate=True)
        except (ValueError, base64.binascii.Error) as exc:
            raise ProbeFailure("MIDI output was not valid base64") from exc
        if not blob.startswith(b"MThd"):
            raise ProbeFailure("MIDI output lacks SMF header")
    elif kind == "text":
        if not any(isinstance(result.get(k), str) and result[k].strip() for k in keys):
            raise ProbeFailure("text result did not contain nonempty text")


def verify_resident_models(manager: Any, *, fixture_path: str, log=None) -> Dict[str, Any]:
    """Prove every direct resident model by actual inference, in a Pod only.

    Dependencies are explicitly reported as assets, not falsely counted as
    standalone inferences. Their integration must be confirmed by pipeline QA.
    """
    if manager.gpu_state().get("device") != "cuda" or not manager.gpu_state().get("available"):
        raise ProbeFailure("real CUDA is required for resident RunPod readiness")
    fixtures = load_fixtures(fixture_path)
    model_infos = manager.get_model_info()
    if not model_infos:
        raise ProbeFailure("no models configured for this Pod")
    direct_ids = {m["id"] for m in model_infos if m["id"] not in REQUIRED_DEPENDENCIES}
    missing = direct_ids.difference(fixtures)
    extra = set(fixtures).difference(direct_ids)
    if missing or extra:
        raise ProbeFailure("fixture model set does not exactly match current direct Pod models: "
                           + f"missing={sorted(missing)} unexpected={sorted(extra)}")
    passed: List[str] = []
    for info in model_infos:
        model_id = info["id"]
        if model_id in REQUIRED_DEPENDENCIES:
            continue
        proof = fixtures[model_id]
        if not isinstance(proof, dict) or not isinstance(proof.get("input"), dict):
            raise ProbeFailure(f"{model_id}: fixture must provide input object")
        manifest_task = info["task"]
        task = proof.get("task")
        if task != manifest_task:
            raise ProbeFailure(f"{model_id}: fixture task mismatches manifest")
        if not manager.is_loaded(model_id):
            # CPU-only utilities can be initialized without GPU reservation.
            if info.get("estimatedVRAM", 0) == 0:
                manager.load(model_id)
            else:
                raise ProbeFailure(f"{model_id}: GPU model is not marked preloaded")
        try:
            result = manager.infer(task, model_id, proof["input"])
            _non_empty_result(result, proof)
        except Exception as exc:
            raise ProbeFailure(f"{model_id}: real inference probe failed ({type(exc).__name__})") from exc
        passed.append(model_id)
        if log is not None:
            log("INFO", "model probe passed", model=model_id)
    return {"verified": passed,
            "dependencyAssetsNotStandalone": sorted(
                m["id"] for m in model_infos if m["id"] in REQUIRED_DEPENDENCIES),
            "gpuVerified": True, "modelsTotal": len(model_infos)}
