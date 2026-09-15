#!/usr/bin/env python3
"""Kontrakt-Probe fuer die vorgefertigten ComfyUI-Worker (Instanz 5/6/7 + music).

Zwei der deployten Worker haben keine oeffentlich erreichbare Quelle mehr
(`imageHq` = PrunaAI/runpod-worker-FLUX.1-dev, `videoReal` =
wlsdml1114/generate-video-ksampler). Dieser Probelauf pinned ihren Vertrag mit
EINEM Job je Rolle fest: er sendet eine minimale Nutzlast und gibt die Rohantwort
aus. Damit fuellt sich die Tabelle in
`services/audiomonastry-ai-runtime/workflows/README.md`.

    # Prompt-Worker (Standard-Nutzlast)
    python3 scripts/runpod-comfyui-probe.py --role imageHq --prompt "a red cube"

    # Workflow-Worker: health_check zuerst (kein Workflow-Bau noetig)
    python3 scripts/runpod-comfyui-probe.py --role music --health-check

    # Eigene Nutzlast (z. B. exportierter Workflow)
    python3 scripts/runpod-comfyui-probe.py --role videoAbstract --payload '{"workflow": {...}}'

    # Nur zeigen, was gesendet wuerde (kostet keinen Kaltstart)
    python3 scripts/runpod-comfyui-probe.py --role imageHq --dry-run

Beendet mit 0, sobald der Job einen Endzustand erreicht (COMPLETED/FAILED/CANCELLED/
TIMED_OUT) – auch bei FAILED, denn Fehlermeldungen SIND das Ergebnis (sie zeigen
die erwarteten Felder). Exit 2 = Timeout, 1 = Bedienfehler.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict

API_BASE = os.environ.get("RUNPOD_API_BASE", "https://api.runpod.ai/v2").rstrip("/")
ROLE_ENDPOINT_ENV = {
    "ears": "RP_ENDPOINT_ID_EARS",
    "voiceGen": "RP_ENDPOINT_ID_VOICE",
    "music": "RP_ENDPOINT_ID_MUSIC",
    "imageHq": "RP_ENDPOINT_ID_IMAGE",
    "videoReal": "RP_ENDPOINT_ID_VIDEO_REAL",
    "videoAbstract": "RP_ENDPOINT_ID_VIDEO_ABSTRACT",
}


def api_key() -> str:
    return (os.environ.get("RP_AGENT_KEY") or os.environ.get("RP_API_KEY") or os.environ.get("RUNPOD_API_KEY") or "").strip()


def endpoint_for(role: str) -> str:
    return (os.environ.get(ROLE_ENDPOINT_ENV.get(role, ""), "") or "").strip()


def build_payload(args: argparse.Namespace) -> Dict[str, Any]:
    """Probe-Nutzlast: explizite Payload > health_check > Prompt/Prompt-Basis."""
    if args.payload:
        return json.loads(args.payload)
    if args.health_check:
        return {"health_check": True}
    if args.role in ("music", "videoAbstract"):
        # Workflow-Rollen: ohne Workflow ist der Fehler die Information.
        return {"workflow": {}}
    payload: Dict[str, Any] = {"prompt": args.prompt or "a red cube on a wooden table"}
    if args.negative_prompt:
        payload["negative_prompt"] = args.negative_prompt
    return payload


def submit(endpoint_id: str, payload: Dict[str, Any], key: str) -> str:
    request = urllib.request.Request(
        f"{API_BASE}/{urllib.parse.quote(endpoint_id)}/run",
        data=json.dumps({"input": payload}).encode(),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=60) as response:  # noqa: S310 (feste RunPod-API-Basis)
        return str(json.loads(response.read().decode()).get("id", ""))


def poll(endpoint_id: str, job_id: str, key: str, timeout_s: int) -> Dict[str, Any]:
    url = f"{API_BASE}/{urllib.parse.quote(endpoint_id)}/status/{urllib.parse.quote(job_id)}"
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        request = urllib.request.Request(url, headers={"Authorization": f"Bearer {key}"})
        with urllib.request.urlopen(request, timeout=60) as response:  # noqa: S310
            state = json.loads(response.read().decode())
        if str(state.get("status", "")).upper() not in ("IN_QUEUE", "IN_PROGRESS", ""):
            return state
        time.sleep(3)
    return {"status": "TIMEOUT", "jobId": job_id}


def main() -> int:
    parser = argparse.ArgumentParser(description="Kontrakt-Probe fuer einen ComfyUI-Worker")
    parser.add_argument("--role", required=True, choices=sorted(ROLE_ENDPOINT_ENV))
    parser.add_argument("--prompt", default="")
    parser.add_argument("--negative-prompt", default="")
    parser.add_argument("--payload", default="", help="Roh-JSON als input (ueberschreibt --prompt/--health-check)")
    parser.add_argument("--health-check", action="store_true", help="nur {health_check:true} senden")
    parser.add_argument("--timeout", type=int, default=900)
    parser.add_argument("--dry-run", action="store_true", help="nur zeigen, was gesendet wuerde")
    args = parser.parse_args()

    try:
        payload = build_payload(args)
    except ValueError as exc:
        print(f"[probe] FEHLER: {exc}", file=sys.stderr)
        return 1

    endpoint_id = endpoint_for(args.role)
    print(f"[probe] Rolle {args.role} | Endpoint-Env {ROLE_ENDPOINT_ENV[args.role]}")
    print(f"[probe] Nutzlast: {json.dumps(payload)[:400]}")

    if args.dry_run:
        print("[probe] dry-run – kein Job gesendet")
        return 0
    if not endpoint_id:
        print(f"[probe] FEHLER: {ROLE_ENDPOINT_ENV[args.role]} ist nicht gesetzt", file=sys.stderr)
        return 1
    key = api_key()
    if not key:
        print("[probe] FEHLER: RP_AGENT_KEY/RP_API_KEY/RUNPOD_API_KEY fehlt", file=sys.stderr)
        return 1

    try:
        job_id = submit(endpoint_id, payload, key)
    except urllib.error.HTTPError as exc:
        body = exc.read().decode(errors="replace")[:600]
        print(f"[probe] HTTP {exc.code} beim Einreichen: {body}", file=sys.stderr)
        return 1
    if not job_id:
        print("[probe] FEHLER: keine Job-ID erhalten", file=sys.stderr)
        return 1
    print(f"[probe] Job {job_id} eingereicht – warte bis {args.timeout}s …")

    state = poll(endpoint_id, job_id, key, args.timeout)
    print(f"[probe] Status: {state.get('status')}")
    print("[probe] Rohantwort:")
    print(json.dumps(state.get("output", state), indent=2, ensure_ascii=False)[:4000])
    return 2 if str(state.get("status")) == "TIMEOUT" else 0


if __name__ == "__main__":
    sys.exit(main())
