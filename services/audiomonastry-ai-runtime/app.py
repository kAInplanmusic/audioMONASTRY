"""
audioMONASTRY · AudioMONASTRY AI Runtime (Hugging Face Custom Container)
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

import asyncio
import hmac
import json
import os
import re
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
from pod_jobs import JobStore, run_job
from registry import load_manifest
from vram_probe import VramProbe, clamp_float, clamp_int

RUNTIME_VERSION = "1.0.0"
STARTED_AT = time.time()

_SAFE_TASK_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
_SAFE_MODEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$")
MCP_API_TOKEN = os.environ.get("AI_MCP_API_TOKEN", "").strip()
#: Pod-Modus: gemeinsames Geheimnis zwischen Orchestrator und Pod. Gesetzt → jede
#: Route außer /health verlangt `Authorization: Bearer <Token>` (die Pod-Proxy-URL
#: ist öffentlich erreichbar).
POD_TOKEN = os.environ.get("AI_POD_TOKEN", "").strip()
#: FLEET-P1-011: harte Grenzen für das VRAM-Lastfenster über HTTP (Sekunden).
VRAM_MAX_DURATION_S = 120.0
VRAM_MAX_WAIT_S = 60.0
#: Resident-Modus: alles wird beim Start geladen, danach nie nachgeladen/verdrängt.
RESIDENT_ONLY = os.environ.get("AI_RESIDENT_ONLY", "0").strip() == "1"
#: Pod-Start (pod_start.py setzt 1): Warmup der Handler mit Kompilierschritt
#: (MOSS-SoundEffect torch.compile, FLEET-P1-008) BEVOR /ready 200 meldet.
STARTUP_WARMUP = os.environ.get("AI_STARTUP_WARMUP", "0").strip() == "1"
# AD-H4: Erlaubte Modell-IDs werden im Lifespan aus dem Manifest befüllt.
KNOWN_MODEL_IDS: set[str] = set()

# ---------------------------------------------------------------------------
# Strukturiertes JSON-Logging (keine Secrets)
# ---------------------------------------------------------------------------
def log_event(level: str, msg: str, **fields: Any) -> None:
    record: Dict[str, Any] = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "level": level,
        "service": "audiomonastry-ai-runtime",
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
        # Flotten-Rolle dieses Containers ('legacy' = alle Modelle des Manifests).
        self.role = os.environ.get("AI_ROLE", "").strip() or "legacy"

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
            "role": self.role,
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

#: FLEET-P1-011: Mess-Sonde dieses Pods. Der Kaltstart-Snapshot entsteht hier –
#: beim Import, also BEVOR `preload()` die Gewichte in den VRAM legt; `warmup`
#: setzt `_preload_models_background()` nach dem Laden. Abrufbar über
#: GET/POST /vram/report (POD_TOKEN-geschützt über die Middleware).
VRAM_PROBE = VramProbe(role=STATE.role)
VRAM_PROBE.capture("cold")


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
        # FLEET-P1-011: residente Gewichte liegen im VRAM – Phase "warmup".
        VRAM_PROBE.capture("warmup")
        if RESIDENT_ONLY:
            # Resident: "bereit" heißt ALLE Rollen-Modelle liegen im VRAM. Fehlt eins,
            # bleibt /ready 503 mit Grund – kein Teilbetrieb, kein Nachladen später.
            missing = [m["id"] for m in STATE.manager.get_model_info()
                       if m.get("preload") and not STATE.manager.is_loaded(m["id"])]
            if missing:
                STATE.startup_errors.append(f"resident models not loaded: {', '.join(missing)}")
                log_event("ERROR", "resident preload incomplete", missing=missing)
                return
        if STARTUP_WARMUP:
            from handlers_voice import run_startup_warmups

            warmup_errors = run_startup_warmups(STATE.manager, log=log_event)
            if warmup_errors:
                # Kein Teilbetrieb: ein Modell ohne Warmup wuerde die erste Anfrage
                # minutenlang blockieren (torch.compile) - /ready bleibt 503 mit Grund.
                STATE.startup_errors.extend(warmup_errors)
                return
        STATE.models_ready = True
        if STARTUP_WARMUP:
            # FLEET-P1-011: torch.compile im Warmup allokiert zusätzlich – Phase neu messen.
            VRAM_PROBE.capture("warmup")
        log_event("INFO", "models ready", resident=RESIDENT_ONLY)
    except Exception as exc:  # noqa: BLE001 – Fehler sauber im Status führen
        STATE.startup_errors.append(f"{type(exc).__name__}: {exc}")
        log_event("ERROR", "model preload failed", error=type(exc).__name__)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    try:
        # Flotten-Rolle: AI_ROLE leer = Legacy-Single-Endpoint (alle Modelle).
        role = os.environ.get("AI_ROLE", "").strip()
        manifest = load_manifest(role or None)
        STATE.manager.configure(manifest)
        STATE.role = role or "legacy"
        VRAM_PROBE.role = STATE.role
        # AD-H4: Whitelist der bekannten Modell-IDs aus dem Manifest.
        KNOWN_MODEL_IDS.update(str(m.get("id", "")).strip() for m in manifest.get("models", []) if isinstance(m, dict))
        KNOWN_MODEL_IDS.discard("")
        log_event(
            "INFO",
            "manifest loaded",
            role=STATE.role,
            models=len(manifest.get("models", [])),
            skippedPlanned=manifest.get("skippedPlanned", []),
        )
    except Exception as exc:  # Startup-Fehler eindeutig melden
        STATE.startup_errors.append(f"{type(exc).__name__}: {exc}")
        log_event("FATAL", "startup failed", error=type(exc).__name__)
        raise
    STATE.ready = True  # API ist sofort erreichbar
    log_event("INFO", "runtime api ready", version=RUNTIME_VERSION)
    _check_core_dependencies()
    threading.Thread(target=_preload_models_background, daemon=True).start()
    yield
    # Graceful Shutdown: keine harte Unterbrechung aktiver Inferenz.
    STATE.shutting_down = True
    log_event("INFO", "shutdown requested")
    POD_JOBS.shutdown()
    STATE.manager.shutdown()
    log_event("INFO", "shutdown complete")


app = FastAPI(title="AudioMONASTRY AI Runtime", version=RUNTIME_VERSION, lifespan=lifespan)


@app.middleware("http")
async def pod_token_guard(request: Request, call_next):
    """Pod-Modus: ohne gültiges Token nur /health (Liveness für den Proxy/Monitor)."""
    if POD_TOKEN and request.url.path != "/health":
        auth = request.headers.get("authorization", "")
        supplied = auth[7:].strip() if auth.lower().startswith("bearer ") else ""
        if not supplied or not hmac.compare_digest(supplied, POD_TOKEN):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
    return await call_next(request)


def _pod_runner(job_input: Any) -> Dict[str, Any]:
    return run_job(STATE.manager, job_input, resident_only=RESIDENT_ONLY,
                   known_models=KNOWN_MODEL_IDS or None, log=log_event)


POD_JOBS = JobStore(_pod_runner, workers=int(os.environ.get("AI_POD_JOB_WORKERS", "1") or "1"))


async def _job_input(request: Request) -> Any:
    try:
        body = await request.json()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail="invalid JSON body") from exc
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="body must be an object")
    return body.get("input")


async def _optional_json_object(request: Request) -> Dict[str, Any]:
    """JSON-Objekt aus dem Body; leerer Body = {}. Ungültig = 400, nie 500."""
    raw = await request.body()
    if not raw:
        return {}
    try:
        body = await request.json()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail="invalid JSON body") from exc
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="body must be an object")
    return body


@app.post("/runsync")
async def pod_runsync(request: Request) -> JSONResponse:
    """Serverless-kompatibel: Ergebnis im selben Roundtrip."""
    job_input = await _job_input(request)
    from starlette.concurrency import run_in_threadpool

    return JSONResponse(await run_in_threadpool(POD_JOBS.run_sync, job_input))


@app.post("/run")
async def pod_run(request: Request) -> JSONResponse:
    """Serverless-kompatibel: Job anlegen, Ergebnis über /status/{id}."""
    return JSONResponse(POD_JOBS.submit(await _job_input(request)))


@app.get("/status/{job_id}")
def pod_status(job_id: str) -> JSONResponse:
    job = POD_JOBS.get(job_id)
    if job is None:
        return JSONResponse({"error": "job not found"}, status_code=404)
    return JSONResponse(job)


@app.post("/cancel/{job_id}")
def pod_cancel(job_id: str) -> JSONResponse:
    """FLEET-P1-009: bricht einen Job ab (TTS-Vorrang vor LEGO). 404 = unbekannte ID."""
    result = POD_JOBS.cancel(job_id)
    if result is None:
        return JSONResponse({"error": "job not found"}, status_code=404)
    log_event("INFO", "job cancel requested", jobId=job_id, status=result.get("status"))
    return JSONResponse(result)


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
        state = "failed" if STATE.startup_errors else "loading_models"
        return JSONResponse({"status": state, "errors": STATE.startup_errors, "models": STATE.manager.get_status()}, status_code=503)
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
        "# HELP audiomonastry_ai_runtime_uptime_seconds Runtime-Uptime",
        "# TYPE audiomonastry_ai_runtime_uptime_seconds gauge",
        f"audiomonastry_ai_runtime_uptime_seconds {time.time() - STARTED_AT:.1f}",
    ]
    for name, value in STATE.manager.get_metrics().items():
        lines.append(f"audiomonastry_ai_runtime_{name} {value}")
    return PlainTextResponse("\n".join(lines) + "\n", media_type="text/plain")


@app.get("/vram/report")
def vram_report() -> JSONResponse:
    """FLEET-P1-011: VRAM-Report dieses Pods (Phasen + letzte Lastmessung).

    Der Kaltstart-/Warmup-Snapshot entsteht beim Start des Pods, das Lastfenster
    startet der Sammler. Token-Schutz: die POD_TOKEN-Middleware oben gilt für
    jede Route außer /health (ohne gesetztes Token ist der Pfad offen – wie alle
    anderen Routen im Nicht-Pod-Betrieb).
    """
    return JSONResponse(VRAM_PROBE.report())


@app.post("/vram/report")
async def vram_report_post(request: Request) -> JSONResponse:
    """FLEET-P1-011: Lastfenster starten/abwarten oder eine Phase aufnehmen.

    action=start    → Sampler-Thread im Hintergrund, 202; die 4 Nutzer erzeugt
                      der Aufrufer (scripts/collect-vram-report.py) parallel
    action=wait     → wartet bis Fensterende und liefert den vollen Report
    action=stop     → Fenster vorzeitig beenden
    action=snapshot → nur messen (Default), optional `label`
    """
    from starlette.concurrency import run_in_threadpool

    body = await _optional_json_object(request)
    action = str(body.get("action") or "snapshot").strip().lower()
    if action == "start":
        duration = clamp_float(body.get("durationSeconds"), 1.0, VRAM_MAX_DURATION_S, 20.0)
        interval = clamp_float(body.get("intervalSeconds"), 0.1, 10.0, 0.5)
        users = clamp_int(body.get("users"), 1, 8, 4)
        if not VRAM_PROBE.start_load(duration, interval, users):
            return JSONResponse({"status": "already_sampling", **VRAM_PROBE.load_state()}, status_code=409)
        log_event("INFO", "vram sampling started", durationS=duration, intervalS=interval, users=users)
        return JSONResponse({"status": "sampling", **VRAM_PROBE.load_state()}, status_code=202)
    if action == "wait":
        wait_s = clamp_float(body.get("waitSeconds"), 0.0, VRAM_MAX_WAIT_S, 30.0)
        finished = await run_in_threadpool(VRAM_PROBE.wait_for_load, wait_s)
        return JSONResponse({"finished": finished, **VRAM_PROBE.report()}, status_code=200 if finished else 202)
    if action == "stop":
        VRAM_PROBE.stop_load()
        return JSONResponse({"status": "stopping", **VRAM_PROBE.load_state()})
    if action != "snapshot":
        raise HTTPException(status_code=400, detail="unknown action")
    label = re.sub(r"[^A-Za-z0-9_-]", "", str(body.get("label") or "manual"))[:32] or "manual"
    VRAM_PROBE.capture(label)
    return JSONResponse(VRAM_PROBE.report())


@app.post("/infer")
async def infer(request: Request) -> JSONResponse:
    """POST /infer {task, model, input} → Inference-Handler.

    Liefert 503 MODEL_UNAVAILABLE, wenn das Modell (noch) nicht geladen ist –
    der Client behandelt das als Retry-Trigger, nicht als Fehler im Produkt.
    """
    if STATE.shutting_down:
        raise HTTPException(status_code=503, detail="shutting_down")
    try:
        body = await request.json()
    except Exception as exc:  # noqa: BLE001 – ungültiges JSON sauber ablehnen
        raise HTTPException(status_code=422, detail="invalid JSON body") from exc
    if not isinstance(body, dict):
        raise HTTPException(status_code=422, detail="request body must be an object")
    task = str(body.get("task", "")).strip()
    model = str(body.get("model", "")).strip()
    payload = body.get("input", {})
    if not _SAFE_TASK_RE.fullmatch(task):
        raise HTTPException(status_code=422, detail="invalid task")
    if not _SAFE_MODEL_RE.fullmatch(model):
        raise HTTPException(status_code=422, detail="invalid model")
    # AD-H4: Modell nur erlauben, wenn es im Manifest/Whitelist existiert.
    if KNOWN_MODEL_IDS and model not in KNOWN_MODEL_IDS:
        raise HTTPException(status_code=422, detail="unknown model")
    if not isinstance(payload, dict):
        raise HTTPException(status_code=422, detail="input must be an object")

    started = time.time()
    try:
        # ON_DEMAND/RARE-Modelle (z. B. Bark, MusicGen-Medium, Qwen3-TTS) erst
        # beim ersten Request laden. Default aktiv; Abschaltbar für Tests.
        auto_load = (not RESIDENT_ONLY) and (os.environ.get("AI_AUTO_LOAD_ON_DEMAND", "1").strip() not in ("0", "false", "False"))
        if auto_load and not STATE.manager.is_loaded(model):
            log_event("INFO", "model auto-load on demand", model=model)
            STATE.manager.load(model)
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
        # AD-H5/FA-P1-9: keine Raw-Exceptions/Pfade in Logs; Client generisch.
        log_event("ERROR", "inference failed", task=task, model=model, error=type(exc).__name__, durationMs=duration_ms)
        STATE.record_error("INFERENCE_FAILED", task, model, f"{type(exc).__name__}: {exc}")
        raise HTTPException(status_code=500, detail={"code": "INFERENCE_FAILED", "model": model, "message": "inference failed"})


@app.post("/mcp/tools/{tool_name}")
async def mcp_tool(tool_name: str, request: Request) -> JSONResponse:
    """MCP-Tool-Aufruf mit Permission-Check (READ/WRITE/EXECUTION/DESTRUCTIVE).

    AD-K2: Ohne AI_MCP_API_TOKEN ist der MCP-Pfad deaktiviert (503). Mit Token
    wird jeder Aufruf per Bearer-/x-api-key authentifiziert (konstante Zeit).
    """
    if not MCP_API_TOKEN:
        return JSONResponse({"ok": False, "error": "mcp disabled (AI_MCP_API_TOKEN not set)"}, status_code=503)
    auth = request.headers.get("authorization", "")
    supplied = auth[7:].strip() if auth.lower().startswith("bearer ") else request.headers.get("x-api-key", "").strip()
    if not supplied or not hmac.compare_digest(supplied, MCP_API_TOKEN):
        return JSONResponse({"ok": False, "error": "unauthorized"}, status_code=401)

    from mcp_runtime import McpRuntime

    try:
        body = await request.json()
    except Exception as exc:  # noqa: BLE001 – ungültiges JSON sauber ablehnen
        log_event("WARN", "invalid mcp json body", error=type(exc).__name__)
        return JSONResponse({"ok": False, "error": "invalid JSON body"}, status_code=400)
    result = McpRuntime(STATE.manager).invoke(tool_name, body)
    return JSONResponse(result)


@app.get("/mcp/tools")
def mcp_tools() -> JSONResponse:
    from mcp_runtime import McpRuntime

    return JSONResponse({"tools": McpRuntime(STATE.manager).list_tools()})
