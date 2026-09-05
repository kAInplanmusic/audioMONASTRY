"""sampleMONK – Backend-Core Gateway (FastAPI).

Lokaler, selbstgehosteter API-Gateway, der Anfragen an die Fach-Services
weiterreicht (stem-ai, voice-ai, dsp-processor, sequencer-engine,
master-player). Robustheit:
  * Ein gemeinsam genutzter httpx.AsyncClient (kein Neuaufbau pro Request)
  * Timeout + sauberes 502 bei nicht erreichbaren Services
  * Status-/Body-Durchreichung statt pauschalem 200
  * CORS nur für konfigurierte Origins
"""
import asyncio
import logging
import os
import re
from typing import Any
from urllib.parse import urlunparse, urlparse

import httpx
from celery.result import AsyncResult
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from celery_app import celery_app, render_project_task

logger = logging.getLogger("samplemonk.gateway")

app = FastAPI(title="sampleMONK Backend-Core", version="2.0.0")

ALLOWED_ORIGINS = [o.strip() for o in os.environ.get("CORS_ALLOWED_ORIGINS", "").split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["GET", "POST"],
    allow_headers=["Authorization", "Content-Type"],
)

# Base-URLs der Fach-Services (docker-compose Netzwerk).
_SAFE_HOST_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?(?::\d{1,5})?$")


def _validate_service_url(name: str, url: str) -> str:
    """Validiert eine Service-Base-URL (DA-2026-09-04-052).

    Erlaubt sind ausschließlich absolute http(s)-URLs ohne Userinfo und
    ohne Pfad-/Query-/Fragment-Anteile. Dadurch kann eine manipulierte
    Umgebungsvariable keine Injection in die Proxy-Ziel-URLs bewirken.
    """
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise RuntimeError(
            f"Ungültige Service-URL für {name!r} (nur absolute http/https-URLs erlaubt): {url!r}"
        )
    if parsed.username or parsed.password:
        raise RuntimeError(f"Userinfo in Service-URL nicht erlaubt ({name!r}): {url!r}")
    if parsed.path not in ("", "/") or parsed.params or parsed.query or parsed.fragment:
        raise RuntimeError(
            f"Service-URL darf keinen Pfad/Query/Fragment enthalten ({name!r}): {url!r}"
        )
    hostport = parsed.netloc
    if not _SAFE_HOST_RE.match(hostport):
        raise RuntimeError(f"Ungültiger Host in Service-URL ({name!r}): {url!r}")
    # Normalisierte URL ohne Pfad-Anteile zurückgeben.
    return urlunparse((parsed.scheme, parsed.netloc, "", "", "", ""))


def _service_url(name: str, env_var: str, default: str) -> str:
    raw = os.environ.get(env_var, "").strip()
    return _validate_service_url(name, raw or default)


SERVICES = {
    "stem": _service_url("stem", "STEM_AI_URL", "http://stem-ai:8000"),
    "voice": _service_url("voice", "VOICE_AI_URL", "http://voice-ai:8000"),
    "dsp": _service_url("dsp", "DSP_URL", "http://dsp-processor:8000"),
    "seq": _service_url("seq", "SEQ_URL", "http://sequencer-engine:8000"),
    "master": _service_url("master", "MASTER_PLAYER_URL", "http://master-player:8000"),
}

PROXY_TIMEOUT = float(os.environ.get("GATEWAY_PROXY_TIMEOUT_SEC", "120"))
GATEWAY_API_TOKEN = os.environ.get("GATEWAY_API_TOKEN", "").strip()
_client: httpx.AsyncClient | None = None
_client_lock: asyncio.Lock | None = None


def _get_client_lock() -> asyncio.Lock:
    global _client_lock
    if _client_lock is None:
        _client_lock = asyncio.Lock()
    return _client_lock


async def get_client() -> httpx.AsyncClient:
    """Liefert den globalen httpx-Client (lazy, thread-/task-sicher mit Lock)."""
    global _client
    if _client is not None and not _client.is_closed:
        return _client
    async with _get_client_lock():
        if _client is None or _client.is_closed:
            _client = httpx.AsyncClient(timeout=PROXY_TIMEOUT)
        return _client


@app.middleware("http")
async def _auth_middleware(request: Request, call_next):
    """Optionale Gateway-Authentifizierung: aktiv nur wenn GATEWAY_API_TOKEN gesetzt ist."""
    if GATEWAY_API_TOKEN and request.url.path != "/health":
        auth = request.headers.get("authorization", "")
        supplied = ""
        if auth.lower().startswith("bearer "):
            supplied = auth[7:].strip()
        else:
            supplied = request.headers.get("x-api-key", "").strip()
        if supplied != GATEWAY_API_TOKEN:
            return JSONResponse(
                {"status": "error", "message": "unauthorized"},
                status_code=401,
            )
    return await call_next(request)


@app.on_event("shutdown")
async def _shutdown() -> None:
    if _client is not None and not _client.is_closed:
        await _client.aclose()


@app.get("/api/render-status/{task_id}")
async def get_render_status(task_id: str) -> dict[str, Any]:
    res = AsyncResult(task_id, app=celery_app)
    try:
        # Celery-Result-Abruf kann Redis/Backend blockieren → Threadpool.
        result = await asyncio.to_thread(lambda: res.result)
    except Exception:  # pragma: no cover - Ergebnis evtl. nicht (mehr) verfügbar
        logger.exception("render status abruf fehlgeschlagen task_id=%s", task_id)
        result = None
    return {"task_id": task_id, "status": res.status, "result": result}


async def proxy_request(service_name: str, path: str, request: Request):
    """Reicht eine JSON-Anfrage an einen Fach-Service weiter (Status-Durchreichung)."""
    if service_name not in SERVICES:
        raise HTTPException(status_code=404, detail=f"Unbekannter Service: {service_name}")
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Ungültiger JSON-Body")
    try:
        response = await (await get_client()).post(f"{SERVICES[service_name]}{path}", json=body)
    except httpx.HTTPError as exc:
        logger.warning("service %s nicht erreichbar: %s", service_name, exc)
        return JSONResponse(
            {"status": "error", "message": f"Service {service_name} nicht erreichbar"},
            status_code=502,
        )
    try:
        return JSONResponse(response.json(), status_code=response.status_code)
    except ValueError:
        return JSONResponse(
            {"status": "error", "message": f"Service {service_name} lieferte kein JSON."},
            status_code=502,
        )


@app.post(
    "/api/separate-stems",
    responses={404: {"description": "Unbekannter Service"}, 400: {"description": "Ungültiger JSON-Body"}},
)
async def separate_stems(request: Request):
    return await proxy_request("stem", "/api/separate-stems", request)


@app.post(
    "/api/generate-voice",
    responses={404: {"description": "Unbekannter Service"}, 400: {"description": "Ungültiger JSON-Body"}},
)
async def generate_voice(request: Request):
    return await proxy_request("voice", "/api/generate-voice", request)


@app.post(
    "/api/apply-fx",
    responses={404: {"description": "Unbekannter Service"}, 400: {"description": "Ungültiger JSON-Body"}},
)
async def apply_fx(request: Request):
    return await proxy_request("dsp", "/api/apply-fx", request)


@app.post("/api/render")
async def render_project(request: Request):
    try:
        project_data = await request.json()
    except Exception as exc:  # noqa: BLE001 – ungültiges JSON sauber ablehnen
        raise HTTPException(status_code=400, detail="Ungültiger JSON-Body") from exc
    if not isinstance(project_data, dict):
        raise HTTPException(status_code=400, detail="project data must be an object")
    task = render_project_task.delay(project_data)
    return {"task_id": task.id, "status": "Render started"}


@app.get("/health")
async def health():
    return {"status": "ok", "services": list(SERVICES.keys())}


@app.get("/")
async def root():
    return {"message": "Sample Monk Core Backend (Gateway) Operational"}
