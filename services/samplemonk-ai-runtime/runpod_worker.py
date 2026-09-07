"""
sampleMONK AI Runtime – RunPod Serverless Worker
=================================================
Wrapper für RunPod Serverless. Der Worker übernimmt Jobs von der RunPod-Queue
und führt sie über den vorhandenen ModelManager/handlers aus.

Job-Input:
{
  "task": "tts",
  "model": "xtts-v2",
  "input": { ... modellspezifisch ... }
}

Output (kleine Ergebnisse):
{
  "status": "success",
  "task": "tts",
  "model": "xtts-v2",
  "result": { ... }
}

Für große Audio-Dateien gilt später:
- Input enthält R2-URLs statt Base64
- Output enthält R2-URLs zu generierten Dateien
- Dieses File bleibt die zentrale Worker-Schnittstelle

Lizenz/Hinweis: Keine Secrets loggen, keine Raw-Exceptions ausgeben.
"""

from __future__ import annotations

import json
import os
import re
import sys
import threading
import time
from datetime import datetime, timezone
from typing import Any, Dict

try:  # runpod ist nur im Serverless-Image nötig; lokal optional
    import runpod  # type: ignore
except Exception:  # pragma: no cover
    runpod = None

from model_manager import ModelManager, ModelUnavailableError
from registry import load_manifest

_SAFE_TASK_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
_SAFE_MODEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$")

manager = ModelManager()
_ready = False
_startup_errors: list[str] = []
_preload_done = False


def log_event(level: str, msg: str, **fields: Any) -> None:
    record: Dict[str, Any] = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "level": level,
        "service": "samplemonk-ai-runtime-runpod-worker",
        "msg": msg,
        **fields,
    }
    print(json.dumps(record, ensure_ascii=False), flush=True)


def _init_manager() -> None:
    """Lädt Manifest und konfiguriert den ModelManager einmalig."""
    global _ready
    try:
        manifest = load_manifest()
        manager.configure(manifest)
        _ready = True
        log_event("INFO", "model manager configured", models=len(manager.get_model_info()))
    except Exception as exc:  # noqa: BLE001
        _startup_errors.append(f"{type(exc).__name__}: {exc}")
        log_event("FATAL", "model manager init failed", error=type(exc).__name__)


def _preload_background() -> None:
    """CORE/FREQUENT im Hintergrund laden – blockiert den Worker-Start nicht."""
    global _preload_done
    try:
        log_event("INFO", "preload started")
        manager.preload()
        _preload_done = True
        log_event("INFO", "preload finished", models_loaded=len(manager.get_status()))
    except Exception as exc:  # noqa: BLE001
        log_event("WARN", "preload failed", error=type(exc).__name__)


def handler(job: Dict[str, Any]) -> Dict[str, Any]:
    """RunPod Serverless Handler: führt einen AI-Job aus."""
    if not isinstance(job, dict):
        return {"status": "error", "code": "INVALID_JOB", "message": "job must be an object"}

    raw_input = job.get("input", {})
    if not isinstance(raw_input, dict):
        return {"status": "error", "code": "INVALID_INPUT", "message": "input must be an object"}

    task = str(raw_input.get("task", "")).strip()
    model = str(raw_input.get("model", "")).strip()
    payload = raw_input.get("input", {})
    if not isinstance(payload, dict):
        return {"status": "error", "code": "INVALID_PAYLOAD", "message": "input.input must be an object"}

    if not _SAFE_TASK_RE.fullmatch(task):
        return {"status": "error", "code": "INVALID_TASK", "message": "invalid task"}
    if not _SAFE_MODEL_RE.fullmatch(model):
        return {"status": "error", "code": "INVALID_MODEL", "message": "invalid model"}

    started = time.time()
    try:
        if not manager.is_loaded(model):
            log_event("INFO", "auto-load model", model=model)
            manager.load(model)
        result = manager.infer(task, model, payload)
        duration_ms = int((time.time() - started) * 1000)
        log_event("INFO", "inference completed", task=task, model=model, durationMs=duration_ms)
        return {
            "status": "success",
            "task": task,
            "model": model,
            "result": result,
            "durationMs": duration_ms,
        }
    except ModelUnavailableError as exc:
        log_event("WARN", f"model unavailable: {exc}", task=task, model=model, error=str(exc))
        return {"status": "error", "code": "MODEL_UNAVAILABLE", "model": model, "message": "model unavailable"}
    except Exception as exc:  # noqa: BLE001 – generischer Fehler, keine Details nach außen
        log_event("ERROR", "inference failed", task=task, model=model, error=type(exc).__name__)
        return {"status": "error", "code": "INFERENCE_FAILED", "model": model, "message": "inference failed"}


def main() -> None:
    if runpod is None:
        print("ERROR: runpod SDK nicht installiert – Serverless-Worker kann nicht starten.", file=sys.stderr)
        raise SystemExit(1)

    _init_manager()
    if not _ready:
        print("ERROR: ModelManager konnte nicht initialisiert werden.", file=sys.stderr)
        raise SystemExit(2)

    if os.environ.get("AI_RUNPOD_PRELOAD", "1").strip() not in ("0", "false", "False"):
        threading.Thread(target=_preload_background, daemon=True).start()

    log_event("INFO", "starting runpod serverless worker")
    runpod.serverless.start({"handler": handler})


if __name__ == "__main__":
    main()
