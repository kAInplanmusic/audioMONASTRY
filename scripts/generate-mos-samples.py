#!/usr/bin/env python3
"""Erzeugt die Hörproben für das MOS-Gate (AI-P1-003 / AI-P1-003 P2-Harness).

Ruft den voice-Endpoint (`task=tts`) mit mehreren Texten auf und legt die WAVs
unter `logs/mos-<datum>/` ab. Es werden nur Metadaten ausgegeben (kein Base64).

Aufruf:
    python3 scripts/generate-mos-samples.py                 # Standard: 3x mms-tts-deu
    MOS_MODEL=mms-tts-deu python3 scripts/generate-mos-samples.py

Die Env-Namen sind bewusst namespaced (MOS_*): generische Namen wie MODEL oder
LANGUAGE sind in Agent-/CI-Umgebungen bereits belegt und lenken den Aufruf sonst
stillschweigend auf ein fremdes Modell um. Genau das ist am 2026-09-13 passiert:
ein ambient gesetztes MODEL=deepseek-v4-pro wurde an den voice-Endpoint
geschickt, dort gibt es das Modell nicht -> 3x MODEL_UNAVAILABLE, 0 Dateien.
"""
from __future__ import annotations

import base64
import json
import os
import pathlib
import sys
import time
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
ENV = ROOT / ".env"

TEXTS = [
    "Willkommen im Studio. Der Mixer steht auf vier Kanälen, alles sauber eingepegelt.",
    "Jetzt kommt der Drop. Bass voll aufgedreht, und die Menge geht mit.",
    "Ein ruhiger Ambient-Loop, weiche Flächen, kein Dröhnen, klar im Höhenbild.",
]


def env(name: str, default: str = "") -> str:
    for line in ENV.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line.startswith(f"{name}="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    return default


key = env("RP_API_KEY") or env("RP_AGENT_KEY") or os.environ.get("RP_API_KEY", "")
endpoint = env("RP_ENDPOINT_ID_VOICE")
model = os.environ.get("MOS_MODEL", "mms-tts-deu").strip() or "mms-tts-deu"
language = os.environ.get("MOS_LANGUAGE", "German").strip() or "German"
if not key or not endpoint:
    print("FEHLER: RP_API_KEY oder RP_ENDPOINT_ID_VOICE fehlt in .env", file=sys.stderr)
    sys.exit(2)

base = f"https://api.runpod.ai/v2/{endpoint}"
headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json", "User-Agent": "audiomonastry-agent"}
outdir = ROOT / "logs" / f"mos-{time.strftime('%Y%m%d')}"
outdir.mkdir(parents=True, exist_ok=True)


def post(path: str, payload: dict) -> dict:
    req = urllib.request.Request(
        f"{base}{path}", data=json.dumps(payload).encode(), headers=headers, method="POST"
    )
    with urllib.request.urlopen(req, timeout=300) as resp:
        return json.loads(resp.read().decode() or "null")


def get(path: str) -> dict:
    req = urllib.request.Request(f"{base}{path}", headers=headers)
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode() or "null")


written = []
for index, text in enumerate(TEXTS, start=1):
    job = post("/runsync", {"input": {"task": "tts", "model": model, "input": {"text": text, "language": language}}})
    job_id = str(job.get("id", ""))
    status = str(job.get("status", ""))
    deadline = time.time() + 300
    while status not in ("COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT") and time.time() < deadline:
        time.sleep(4)
        job = get(f"/status/{job_id}")
        status = str(job.get("status", ""))

    output = job.get("output") or {}
    result = output.get("result") if isinstance(output, dict) else None
    audio_b64 = ""
    if isinstance(result, dict):
        audio_b64 = str(result.get("audioBase64") or result.get("audio") or "")
    elif isinstance(result, str):
        audio_b64 = result

    if not audio_b64:
        print(json.dumps({"index": index, "status": status, "outputStatus": output.get("status") if isinstance(output, dict) else None,
                          "code": output.get("code") if isinstance(output, dict) else None, "audio": False}))
        continue

    path = outdir / f"{model}-{index:02d}.wav"
    path.write_bytes(base64.b64decode(audio_b64))
    written.append(str(path.relative_to(ROOT)))
    print(json.dumps({"index": index, "status": status, "file": str(path.relative_to(ROOT)), "bytes": path.stat().st_size,
                      "sampleRate": (result or {}).get("sampleRate") if isinstance(result, dict) else None}))

print(json.dumps({"model": model, "language": language, "written": written}))

# Ehrliches Gate: ohne geschriebene Datei ist der Lauf fehlgeschlagen – auch wenn
# jeder Job formal "COMPLETED" war (z. B. output.status=error MODEL_UNAVAILABLE).
# Vorher endete genau so ein Lauf mit Exit 0 und sah wie ein Erfolg aus.
if len(written) < len(TEXTS):
    print(
        f"FEHLER: nur {len(written)}/{len(TEXTS)} Hoerproben geschrieben "
        f"(Modell={model}, Sprache={language}) - outputStatus/code oben pruefen.",
        file=sys.stderr,
    )
    sys.exit(3)
