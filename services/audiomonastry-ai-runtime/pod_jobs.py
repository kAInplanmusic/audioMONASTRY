"""Pod-Modus: Jobs im selben Format wie RunPod Serverless, ohne Framework.

Auf einem Pod läuft dieselbe Runtime wie im Serverless-Worker, aber als HTTP-Dienst
(`app.py`). Damit der Orchestrator (`runpodProvider.ts`) nur die Basis-URL tauschen
muss, bieten die Pod-Routen exakt die Serverless-Pfade an:

    POST /runsync        {"input": {"task", "model", "input"}} → {"id", "status", "output"}
    POST /run            dito, sofort {"id", "status": "IN_QUEUE"}
    GET  /status/{id}    {"id", "status", "output"?}

`output` hat dieselbe Form wie `runpod_worker.handler` (status success/error, code,
message). Im Resident-Modus (`AI_RESIDENT_ONLY=1`) wird nie nachgeladen: ein nicht
geladenes Modell ist ein Fehler, kein Anlass zum Tauschen.
"""
from __future__ import annotations

import re
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable, Dict, Optional

SAFE_TASK_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
SAFE_MODEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$")


def _err(code: str, message: str, **extra: Any) -> Dict[str, Any]:
    return {"status": "error", "code": code, "message": message, **extra}


def run_job(
    manager: Any,
    job_input: Any,
    *,
    resident_only: bool,
    known_models: Optional[set] = None,
    log: Callable[..., None] = lambda *a, **k: None,
) -> Dict[str, Any]:
    """Führt einen Job aus und liefert das Serverless-`output`."""
    if not isinstance(job_input, dict):
        return _err("INVALID_INPUT", "input must be an object")
    task = str(job_input.get("task", "")).strip()
    model = str(job_input.get("model", "")).strip()
    payload = job_input.get("input", {})
    if not isinstance(payload, dict):
        return _err("INVALID_PAYLOAD", "input.input must be an object")
    if not SAFE_TASK_RE.fullmatch(task):
        return _err("INVALID_TASK", "invalid task")

    if task == "warmup":
        # Auf dem Pod sind die Modelle seit dem Start resident; warmup meldet nur den Stand.
        status = manager.get_status() if hasattr(manager, "get_status") else {}
        return {"status": "success", "task": "warmup", "model": "", "result": {"models": status}, "durationMs": 0}

    if not SAFE_MODEL_RE.fullmatch(model):
        return _err("INVALID_MODEL", "invalid model")
    if known_models and model not in known_models:
        return _err("INVALID_MODEL", "unknown model")

    started = time.time()
    try:
        if not manager.is_loaded(model):
            if resident_only:
                return _err("MODEL_UNAVAILABLE", "model not resident on this pod", model=model)
            manager.load(model)
        result = manager.infer(task, model, payload)
        duration_ms = int((time.time() - started) * 1000)
        log("INFO", "inference completed", task=task, model=model, durationMs=duration_ms)
        return {"status": "success", "task": task, "model": model, "result": result, "durationMs": duration_ms}
    except Exception as exc:  # noqa: BLE001 – Fehlerart nach außen, Details nur ins Log
        name = type(exc).__name__
        code = "MODEL_UNAVAILABLE" if name == "ModelUnavailableError" else "INFERENCE_FAILED"
        log("ERROR", "inference failed", task=task, model=model, error=name, message=str(exc)[:300])
        return _err(code, "model unavailable" if code == "MODEL_UNAVAILABLE" else "inference failed", model=model)


class JobStore:
    """Asynchrone Jobs für `/run` + `/status`. Hält Ergebnisse `ttl_s` Sekunden."""

    def __init__(self, runner: Callable[[Any], Dict[str, Any]], workers: int = 1, ttl_s: float = 3600.0) -> None:
        self._runner = runner
        self._pool = ThreadPoolExecutor(max_workers=max(1, workers), thread_name_prefix="pod-job")
        self._jobs: Dict[str, Dict[str, Any]] = {}
        self._lock = threading.Lock()
        self._ttl = ttl_s

    def submit(self, job_input: Any) -> Dict[str, Any]:
        job_id = uuid.uuid4().hex
        with self._lock:
            self._prune()
            self._jobs[job_id] = {"id": job_id, "status": "IN_QUEUE", "createdAt": time.time(), "done": threading.Event()}
        self._pool.submit(self._execute, job_id, job_input)
        return {"id": job_id, "status": "IN_QUEUE"}

    def _execute(self, job_id: str, job_input: Any) -> None:
        with self._lock:
            if job_id in self._jobs:
                self._jobs[job_id]["status"] = "IN_PROGRESS"
        try:
            output = self._runner(job_input)
        except Exception as exc:  # noqa: BLE001 – Runner-Fehler wie Serverless als Output melden
            output = {"status": "error", "code": "INFERENCE_FAILED", "message": type(exc).__name__}
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return
            # Wie Serverless: Fehler stehen im Output, der Job selbst ist COMPLETED.
            job.update(status="COMPLETED", output=output, createdAt=time.time())
            job["done"].set()

    def get(self, job_id: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            job = self._jobs.get(job_id)
            return None if job is None else {k: v for k, v in job.items() if k not in ("createdAt", "done")}

    def run_sync(self, job_input: Any, wait_s: float = 80.0) -> Dict[str, Any]:
        """Wartet höchstens `wait_s` (der Pod-Proxy schneidet nach 100 s ab).
        Dauert es länger, kommt `IN_PROGRESS` + ID zurück; der Aufrufer pollt `/status`."""
        sub = self.submit(job_input)
        with self._lock:
            done = self._jobs[sub["id"]]["done"]
        done.wait(timeout=wait_s)
        return self.get(sub["id"]) or sub

    def _prune(self) -> None:
        cutoff = time.time() - self._ttl
        for jid in [j for j, v in self._jobs.items() if v.get("createdAt", 0) < cutoff and v["status"] in ("COMPLETED", "FAILED")]:
            del self._jobs[jid]

    def shutdown(self) -> None:
        self._pool.shutdown(wait=False, cancel_futures=True)
