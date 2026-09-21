#!/usr/bin/env python3
"""Einmalige Verifikation des neu deployten Vision-Endpoints (FLUX).

Ruft den Endpoint mit einem MINIMALEN Budget auf (512x512, 4 Steps) und meldet
nur Metadaten (Status, Bildlänge, Seed) — niemals das Base64-Bild selbst.
"""
from __future__ import annotations

import json
import os
import pathlib
import sys
import time
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
ENV = ROOT / ".env"

# Gemeinsame Helfer aus scripts/lib/ (Pfad relativ zur eigenen Datei, damit das
# Skript direkt UND per importlib aus tests/ laeuft).
_LIB = pathlib.Path(__file__).resolve().parents[0] / "lib"
if str(_LIB) not in sys.path:
    sys.path.insert(0, str(_LIB))
from envfile import env_from_file  # noqa: E402


def env(name: str, default: str = "") -> str:
    """Einzelner Schluessel aus `.env` (Leser in scripts/lib/envfile.py)."""
    return env_from_file(ENV, name, default)


key = env("RP_API_KEY") or env("RP_AGENT_KEY") or os.environ.get("RP_API_KEY", "")
endpoint = env("RP_ENDPOINT_ID_VISION")
if not key or not endpoint:
    print("FEHLER: RP_API_KEY oder RP_ENDPOINT_ID_VISION fehlt", file=sys.stderr)
    sys.exit(2)

base = f"https://api.runpod.ai/v2/{endpoint}"
body = {
    "input": {
        "prompt": "dark abstract studio light, minimal, cinematic",
        "num_inference_steps": 4,
        "width": 512,
        "height": 512,
    }
}
headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json", "User-Agent": "audiomonastry-agent"}


def call(url: str, payload: dict | None = None) -> dict:
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, headers=headers, method="POST" if payload is not None else "GET")
    with urllib.request.urlopen(req, timeout=120) as resp:
        return json.loads(resp.read().decode() or "null")


started = time.time()
job = call(f"{base}/runsync", body)
job_id = str(job.get("id", ""))
status = str(job.get("status", ""))
print(f"[vision-test] endpoint={endpoint} job={job_id} initial={status}")

deadline = time.time() + 600
while status not in ("COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT") and time.time() < deadline:
    time.sleep(5)
    job = call(f"{base}/status/{job_id}")
    status = str(job.get("status", ""))
    print(f"[vision-test] status={status} elapsed={int(time.time() - started)}s")

out = job.get("output") or {}


def find_image(node) -> str | None:
    if isinstance(node, str):
        return node if node.startswith("data:image") else (node if node.startswith("http") and ".png" in node else None)
    if isinstance(node, dict):
        for k in ("image_url", "image", "url", "images", "output"):
            if k in node:
                found = find_image(node[k])
                if found:
                    return found
        for v in node.values():
            found = find_image(v)
            if found:
                return found
    if isinstance(node, list):
        for v in node:
            found = find_image(v)
            if found:
                return found
    return None


img = find_image(out)
print(
    json.dumps(
        {
            "finalStatus": status,
            "executionMs": job.get("executionTime"),
            "delayMs": job.get("delayTime"),
            "imageFound": bool(img),
            "imageChars": len(img) if img else 0,
            "isDataUri": bool(img and img.startswith("data:image")),
            "seed": (out.get("seed") if isinstance(out, dict) else None),
            "error": (out.get("status") if isinstance(out, dict) else None),
        }
    )
)
sys.exit(0 if (status == "COMPLETED" and img) else 1)
