"""sampleMONK – Backend-Core Gateway (FastAPI).

Lokaler, selbstgehosteter API-Gateway, der Anfragen an die Fach-Services
weiterreicht (stem-ai, voice-ai, dsp-processor, sequencer-engine,
master-player). Robustheit:
  * Ein gemeinsam genutzter httpx.AsyncClient (kein Neuaufbau pro Request)
  * Timeout + sauberes 502 bei nicht erreichbaren Services
  * Status-/Body-Durchreichung statt pauschalem 200
  * CORS nur für konfigurierte Origins
"""
import os
from typing import Any

import httpx
from celery.result import AsyncResult
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from celery_app import celery_app, render_project_task

app = FastAPI(title="sampleMONK Backend-Core", version="2.0.0")

ALLOWED_ORIGINS = [o.strip() for o in os.environ.get("CORS_ALLOWED_ORIGINS", "").split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["GET", "POST"],
    allow_headers=["Authorization", "Content-Type"],
)

# Base-URLs der Fach-Services (docker-compose Netzwerk).
SERVICES = {
    "stem": os.environ.get("STEM_AI_URL", "http://stem-ai:8000"),
    "voice": os.environ.get("VOICE_AI_URL", "http://voice-ai:8000"),
    "dsp": os.environ.get("DSP_URL", "http://dsp-processor:8000"),
    "seq": os.environ.get("SEQ_URL", "http://sequencer-engine:8000"),
    "master": os.environ.get("MASTER_PLAYER_URL", "http://master-player:8000"),
}

PROXY_TIMEOUT = float(os.environ.get("GATEWAY_PROXY_TIMEOUT_SEC", "120"))
_client: httpx.AsyncClient | None = None


def get_client() -> httpx.AsyncClient:
    """Liefert den globalen httpx-Client (lazy, mit Timeout)."""
    global _client
    if _client is None or _client.is_closed:
        _client = httpx.AsyncClient(timeout=PROXY_TIMEOUT)
    return _client


@app.on_event("shutdown")
async def _shutdown() -> None:
    if _client is not None and not _client.is_closed:
        await _client.aclose()


@app.get("/api/render-status/{task_id}")
async def get_render_status(task_id: str) -> dict[str, Any]:
    res = AsyncResult(task_id, app=celery_app)
    try:
        result = res.result
    except Exception:  # pragma: no cover - Ergebnis evtl. nicht (mehr) verfügbar
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
        response = await get_client().post(f"{SERVICES[service_name]}{path}", json=body)
    except httpx.HTTPError as exc:
        return JSONResponse(
            {"status": "error", "message": f"Service {service_name} nicht erreichbar: {exc}"},
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
    project_data = await request.json()
    task = render_project_task.delay(project_data)
    return {"task_id": task.id, "status": "Render started"}


@app.get("/health")
async def health():
    return {"status": "ok", "services": list(SERVICES.keys())}


@app.get("/")
async def root():
    return {"message": "Sample Monk Core Backend (Gateway) Operational"}
