"""
audioMONASTRY · SampleMONK AI Runtime (Hugging Face Custom Container)
=====================================================================
FastAPI-Runtime für den dedizierten HF-Inference-Endpoint.

Grundsätze:
- Läuft auf GPU (A100), degradiert aber kontrolliert, wenn CUDA/torch fehlen.
- Kein Modell wird beim Start blind geladen: Model Manager entscheidet anhand
  des Manifests (CORE/FREQUENT/ON_DEMAND/RARE) und des verfügbaren VRAM.
- Health (Prozess) und Readiness (Runtime einsatzbereit) sind getrennt.
- Alle Logs strukturiert als JSON (eine Zeile pro Event).
"""
from __future__ import annotations

import json
import os
import signal
import sys
import threading
import time
import traceback
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, PlainTextResponse

from model_manager import ModelManager, ModelUnavailableError
from registry import load_manifest

RUNTIME_VERSION = "1.0.0"
STARTED_AT = time.time()

# ---------------------------------------------------------------------------
# Strukturiertes JSON-Logging (keine Secrets)
# ---------------------------------------------------------------------------
def log_event(level: str, msg: str, **fields: Any) -> None:
    record: Dict[str, Any] = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "level": level,
        "service": "samplemonk-ai-runtime",
        "msg": msg,
        **fields,
    }
    print(json.dumps(record, ensure_ascii=False), flush=True)


class State:
    """Mutatabler Runtime-Zustand (Health/Readiness/Status)."""

    def __init__(self) -> None:
        self.manager = ModelManager()
        self.startup_errors: List[str] = []
        self.last_errors: List[Dict[str, Any]] = []
        self.ready = False
        self.models_ready = False
        self.shutting_down = False

    def record_error(self, kind: str, task: str, model: str, message: str) -> None:
        """Hält die letzten Inferenz-Fehler für /status bereit (Observability)."""
        self.last_errors.append(
            {
                "ts": datetime.now(timezone.utc).isoformat(),
                "kind": kind,
                "task": task,
                "model": model,
                "message": message[:500],
            }
        )
        if len(self.last_errors) > 5:
            self.last_errors = self.last_errors[-5:]

    def status_payload(self) -> Dict[str, Any]:
        models = self.manager.get_status()
        return {
            "endpoint": "running" if not self.shutting_down else "shutting_down",
            "gpu": self.manager.gpu_state(),
            "runtime": "ready" if self.ready else "starting",
            "models_ready": self.models_ready,
            "models": {
                "core": models.get("core", "available"),
                "frequent": models.get("frequent", "available"),
                "onDemand": models.get("onDemand", "available"),
                "rare": models.get("rare", "available"),
            },
            "last_errors": self.last_errors,
        }


STATE = State()


def _check_core_dependencies() -> None:
    """Startup-Selbsttest: fehlende Python-Dependencies SOFORT im Log sichtbar machen.

    Der HF-Dashboard-Log zeigt nur `msg` – deshalb wird der fehlende Modulname
    direkt in die Meldung geschrieben (nicht nur ins `error`-Feld).
    """
    for mod, pip in (("torch", "torch"), ("transformers", "transformers"), ("soundfile", "soundfile"), ("scipy", "scipy")):
        try:
            __import__(mod)
        except Exception as exc:  # noqa: BLE001
            log_event("FATAL", f"dependency missing for {mod} (pip install {pip}): {exc}")


def _preload_models_background() -> None:
    """Lädt CORE/FREQUENT-Modelle im Hintergrund, damit /health sofort antwortet.

    HF markiert den Endpoint als laufend, sobald /health 200 liefert. Während
    der (teils minutenlange) Gewichte-Download läuft, liefert /ready 503 –
    so kann kein Startup-Timeout durch blockierendes Laden entstehen.
    """
    try:
        STATE.manager.preload()
        STATE.models_ready = True
        log_event("INFO", "models ready")
    except Exception as exc:  # noqa: BLE001 – Fehler sauber im Status führen
        STATE.startup_errors.append(str(exc))
        log_event("ERROR", "model preload failed", error=str(exc))


@asynccontextmanager
async def lifespan(_app: FastAPI):
    try:
        manifest = load_manifest()
        STATE.manager.configure(manifest)
    except Exception as exc:  # Startup-Fehler eindeutig melden
        STATE.startup_errors.append(str(exc))
        log_event("FATAL", "startup failed", error=str(exc))
        raise
    STATE.ready = True  # API ist sofort erreichbar
    log_event("INFO", "runtime api ready", version=RUNTIME_VERSION)
    _check_core_dependencies()
    threading.Thread(target=_preload_models_background, daemon=True).start()
    yield
    # Graceful Shutdown: keine harte Unterbrechung aktiver Inferenz.
    STATE.shutting_down = True
    log_event("INFO", "shutdown requested")
    STATE.manager.shutdown()
    log_event("INFO", "shutdown complete")


app = FastAPI(title="SampleMONK AI Runtime", version=RUNTIME_VERSION, lifespan=lifespan)


@app.get("/health")
def health() -> JSONResponse:
    """Liveness: Prozess lebt (immer 200, solange der Prozess antwortet)."""
    return JSONResponse({"status": "ok", "version": RUNTIME_VERSION})


@app.get("/ready")
def ready() -> JSONResponse:
    """Readiness: Runtime + CORE-Modelle tatsächlich einsatzbereit."""
    if STATE.shutting_down:
        return JSONResponse({"status": "shutting_down"}, status_code=503)
    if not STATE.ready:
        return JSONResponse({"status": "starting", "errors": STATE.startup_errors}, status_code=503)
    if not STATE.models_ready:
        return JSONResponse({"status": "loading_models", "models": STATE.manager.get_status()}, status_code=503)
    return JSONResponse({"status": "ready", "version": RUNTIME_VERSION})


@app.get("/status")
def status() -> JSONResponse:
    return JSONResponse(STATE.status_payload())


@app.get("/models")
def models() -> JSONResponse:
    return JSONResponse({"models": STATE.manager.get_model_info()})


@app.get("/metrics")
def metrics() -> PlainTextResponse:
    lines = [
        "# HELP samplemonk_ai_runtime_uptime_seconds Runtime-Uptime",
        "# TYPE samplemonk_ai_runtime_uptime_seconds gauge",
        f"samplemonk_ai_runtime_uptime_seconds {time.time() - STARTED_AT:.1f}",
    ]
    for name, value in STATE.manager.get_metrics().items():
        lines.append(f"samplemonk_ai_runtime_{name} {value}")
    return PlainTextResponse("\n".join(lines) + "\n", media_type="text/plain")


@app.post("/infer")
async def infer(request: Request) -> JSONResponse:
    """POST /infer {task, model, input} → Inference-Handler.

    Liefert 503 MODEL_UNAVAILABLE, wenn das Modell (noch) nicht geladen ist –
    der Client behandelt das als Retry-Trigger, nicht als Fehler im Produkt.
    """
    if STATE.shutting_down:
        raise HTTPException(status_code=503, detail="shutting_down")
    body = await request.json()
    task = str(body.get("task", "")).strip()
    model = str(body.get("model", "")).strip()
    payload = body.get("input", {})
    if not task or not model:
        raise HTTPException(status_code=422, detail="task and model are required")

    started = time.time()
    try:
        result = STATE.manager.infer(task, model, payload)
        duration_ms = int((time.time() - started) * 1000)
        log_event("INFO", "inference completed", task=task, model=model, durationMs=duration_ms)
        return JSONResponse({"status": "success", "task": task, "model": model, "result": result, "durationMs": duration_ms})
    except ModelUnavailableError as exc:
        duration_ms = int((time.time() - started) * 1000)
        # Grund in die WARN-Message schreiben, damit er im HF-Dashboard sichtbar ist
        # (das Dashboard zeigt nur msg, nicht das error-Feld). Client bleibt generisch.
        log_event("WARN", f"model unavailable: {exc}", task=task, model=model, error=str(exc), durationMs=duration_ms)
        STATE.record_error("MODEL_UNAVAILABLE", task, model, str(exc))
        raise HTTPException(status_code=503, detail={"code": "MODEL_UNAVAILABLE", "model": model, "message": "model unavailable"})
    except Exception as exc:  # noqa: BLE001 – zentrale Fehlerbehandlung
        duration_ms = int((time.time() - started) * 1000)
        # FA-P1-9: Details nur ins Log; Client erhält generische Meldung ohne Pfade/Traceback.
        log_event("ERROR", "inference failed", task=task, model=model, error=str(exc), durationMs=duration_ms)
        STATE.record_error("INFERENCE_FAILED", task, model, f"{type(exc).__name__}: {exc}")
        raise HTTPException(status_code=500, detail={"code": "INFERENCE_FAILED", "model": model, "message": "inference failed"})


@app.post("/mcp/tools/{tool_name}")
async def mcp_tool(tool_name: str, request: Request) -> JSONResponse:
    """MCP-Tool-Aufruf mit Permission-Check (READ/WRITE/EXECUTION/DESTRUCTIVE)."""
    from mcp_runtime import McpRuntime

    body = await request.json()
    result = McpRuntime(STATE.manager).invoke(tool_name, body)
    return JSONResponse(result)


@app.get("/mcp/tools")
def mcp_tools() -> JSONResponse:
    from mcp_runtime import McpRuntime

    return JSONResponse({"tools": McpRuntime(STATE.manager).list_tools()})
