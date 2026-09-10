#!/usr/bin/env python3
"""
audioMONASTRY · RunPod Smoke-Test (ARCH-AI-001-Prüfpunkt)
==========================================================
Feuert einen kleinen classify-Job (ast-audioset) gegen den RunPod
Serverless-Endpoint und persistiert das Ergebnis SOFORT nach Abschluss
(RunPod bereinigt Job-Datensätze nach kurzer Zeit – deshalb sofort speichern).

Verwendung:
  RP_API_KEY=… RUNPOD_ENDPOINT_ID=… python3 scripts/runpod-smoke.py
  Pro Flotten-Rolle (prüft Rollen-Manifest + Preload):
    RP_API_KEY=… RUNPOD_SMOKE_ROLE=ears python3 scripts/runpod-smoke.py
  optional: RUNPOD_SMOKE_TASK=classify RUNPOD_SMOKE_MODEL=ast-audioset
            RUNPOD_SMOKE_ROLE=brain|ears|voiceGen  (Default-Task dann: warmup)
            RUNPOD_SMOKE_WAV=/pfad/zu/test.wav   (Default: generierter 1s/440Hz-Sinus)
            RUNPOD_POLL_SECONDS=30

Ausgabe:
  logs/runpod-smoke-<timestamp>.json   (finaler Job-Status inkl. Ergebnis)
"""
from __future__ import annotations

import base64
import io
import json
import math
import os
import struct
import sys
import time
import urllib.request
import wave
from datetime import datetime, timezone


def env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def make_test_wav(seconds: float = 1.0, freq: float = 440.0, sr: int = 16000) -> bytes:
    frames = bytearray()
    for i in range(int(seconds * sr)):
        v = int(0.3 * 32767 * math.sin(2 * math.pi * freq * i / sr))
        frames += struct.pack("<h", v)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(bytes(frames))
    return buf.getvalue()


def api_json(url: str, api_key: str, method: str = "GET", body: dict | None = None, timeout: int = 60):
    data = None
    headers = {"Authorization": f"Bearer {api_key}"}
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


ROLE_ENDPOINT_ENV = {
    "brain": "RUNPOD_ENDPOINT_ID_BRAIN",
    "ears": "RUNPOD_ENDPOINT_ID_EARS",
    "voiceGen": "RUNPOD_ENDPOINT_ID_VOICE",
}


def main() -> int:
    api_key = env("RP_API_KEY") or env("RUNPOD_API_KEY")
    role = env("RUNPOD_SMOKE_ROLE")
    if role and role not in ROLE_ENDPOINT_ENV:
        print(f"FEHLER: unbekannte RUNPOD_SMOKE_ROLE {role!r}", file=sys.stderr)
        return 2
    endpoint_id = (env(ROLE_ENDPOINT_ENV[role]) if role else "") or env("RUNPOD_ENDPOINT_ID")
    # Ohne expliziten Task ist der Rollen-Smoke ein Warmup-Probe (prüft Worker,
    # Rollen-Manifest und Preload-Modelle), der Legacy-Smoke ein classify-Job.
    task = env("RUNPOD_SMOKE_TASK") or ("warmup" if role else "classify")
    model = env("RUNPOD_SMOKE_MODEL") or ("ast-audioset" if task == "classify" else "")
    wav_path = env("RUNPOD_SMOKE_WAV")
    poll_seconds = max(10, int(env("RUNPOD_POLL_SECONDS", "30")))

    if not api_key:
        print("FEHLER: RP_API_KEY fehlt", file=sys.stderr)
        return 2
    if not endpoint_id:
        print("FEHLER: RUNPOD_ENDPOINT_ID (oder RUNPOD_ENDPOINT_ID_<ROLLE>) fehlt", file=sys.stderr)
        return 2

    if task == "warmup":
        print(f"[smoke] Rollen-Warmup-Probe (role={role or 'legacy'})")
        job = {"input": {"task": "warmup", "model": "", "input": {"role": role}}}
    else:
        if wav_path and os.path.exists(wav_path):
            with open(wav_path, "rb") as fh:
                wav_bytes = fh.read()
            print(f"[smoke] Nutze WAV: {wav_path} ({len(wav_bytes)} bytes)")
        else:
            wav_bytes = make_test_wav()
            print(f"[smoke] Generierte Test-WAV ({len(wav_bytes)} bytes, 1s/440Hz/16kHz)")
        job = {
            "input": {
                "task": task,
                "model": model,
                "input": {"audioBase64": base64.b64encode(wav_bytes).decode()},
            }
        }

    base = f"https://api.runpod.ai/v2/{endpoint_id}"
    print(f"[smoke] Sende runsync (task={task}, model={model}) …")
    started = time.time()
    try:
        result = api_json(f"{base}/runsync", api_key, method="POST", body=job, timeout=900)
    except Exception as exc:
        print(f"FEHLER: runsync fehlgeschlagen: {exc}", file=sys.stderr)
        return 3

    job_id = result.get("id", "")
    print(f"[smoke] Job-ID: {job_id} | initial: {result.get('status')}")

    # Pollen, bis ein Endzustand erreicht ist (max. 30 min).
    deadline = time.time() + 1800
    final = result
    while time.time() < deadline:
        status = final.get("status")
        if status in ("COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"):
            break
        time.sleep(poll_seconds)
        try:
            final = api_json(f"{base}/status/{job_id}", api_key, timeout=30)
        except Exception as exc:
            print(f"[smoke] Status-Poll-Fehler: {exc} (warte weiter)", file=sys.stderr)
            continue
        print(f"[smoke] status={final.get('status')} "
              f"delayMs={final.get('delayTime')} execMs={final.get('executionTime')} "
              f"elapsed={int(time.time() - started)}s")

    # Ergebnis SOFORT persistieren (RunPod bereinigt Job-Datensätze schnell).
    os.makedirs("logs", exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    out_path = f"logs/runpod-smoke-{stamp}.json"
    payload = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "endpointId": endpoint_id,
        "jobId": job_id,
        "task": task,
        "model": model,
        "elapsedSeconds": int(time.time() - started),
        "final": final,
    }
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=2, ensure_ascii=False)
    print(f"[smoke] Ergebnis gespeichert: {out_path}")

    status = final.get("status")
    if status == "COMPLETED":
        output = final.get("output")
        print("[smoke] COMPLETED ✓")
        print(json.dumps(output, indent=2, ensure_ascii=False)[:1500])
        return 0
    print(f"[smoke] Endzustand: {status}", file=sys.stderr)
    return 4


if __name__ == "__main__":
    raise SystemExit(main())
