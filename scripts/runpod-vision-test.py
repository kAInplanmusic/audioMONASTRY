#!/usr/bin/env python3
"""
audioMONASTRY · RunPod Vision-Test (Text -> Bild)
=================================================
Prueft die Rolle `vision` (RunPod-Hub-Worker, SDXL-Turbo) live: Prompt rein,
PNG raus. Der erste Aufruf zahlt den Kaltstart (Image + Gewichte) -> Retry.

Ergebnis: logs/vision-<timestamp>.png + logs/vision-<timestamp>.json
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

DEFAULT_PROMPT = (
    "hyperrealistic cinematic astral scene, a lone figure silhouetted against a "
    "neon nebula over dark water, volumetric light, film grain, 35mm"
)


def env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def load_env() -> None:
    p = Path("/home/patrick/audioMONASTRY/.env")
    if not p.exists():
        return
    for line in p.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip())


def call(url: str, key: str, body: dict, timeout: int):
    req = urllib.request.Request(
        url, data=json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json",
                 "User-Agent": "audiomonastry-agent"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode() or "null")


def find_image(node):
    """Sucht rekursiv nach base64-PNG/JPEG oder einer Bild-URL."""
    if isinstance(node, str):
        if node.startswith("data:image"):
            return node
        if re.search(r"^https?://.*\.(png|jpe?g|webp)", node):
            return node
    if isinstance(node, dict):
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


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--endpoint", default=env("RUNPOD_VISION_ENDPOINT", "5eiw6t03hjln9x"))
    ap.add_argument("--prompt", default=DEFAULT_PROMPT)
    ap.add_argument("--steps", type=int, default=4)
    ap.add_argument("--attempts", type=int, default=40)
    ap.add_argument("--request-timeout", type=int, default=900)
    args = ap.parse_args()

    load_env()
    key = env("RP_AGENT_KEY") or env("RP_API_KEY") or env("RUNPOD_API_KEY")
    if not key:
        print("FEHLER: RP_AGENT_KEY fehlt", file=sys.stderr)
        return 2

    url = f"https://api.runpod.ai/v2/{args.endpoint}/runsync"
    body = {"input": {"prompt": args.prompt, "num_inference_steps": args.steps,
                      "width": 1024, "height": 1024, "num_images": 1}}
    os.makedirs("logs", exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    report = {"ts": datetime.now(timezone.utc).isoformat(), "endpointId": args.endpoint,
              "prompt": args.prompt, "steps": args.steps, "attempts": []}

    for attempt in range(1, args.attempts + 1):
        started = time.time()
        try:
            d = call(url, key, body, args.request_timeout)
            wall = int((time.time() - started) * 1000)
            img = find_image(d.get("output"))
            print(f"[vision] #{attempt} status={d.get('status')} delay={d.get('delayTime')}ms "
                  f"exec={d.get('executionTime')}ms wall={wall}ms bild={'ja' if img else 'nein'}",
                  flush=True)
            report["attempts"].append({"attempt": attempt, "status": d.get("status"),
                                       "delayTimeMs": d.get("delayTime"),
                                       "executionTimeMs": d.get("executionTime"),
                                       "wallMs": wall, "image": bool(img)})
            if img:
                if img.startswith("data:"):
                    raw = base64.b64decode(img.split(",", 1)[1])
                else:
                    with urllib.request.urlopen(img, timeout=120) as r:
                        raw = r.read()
                png = f"logs/vision-{stamp}.png"
                Path(png).write_bytes(raw)
                report["imagePath"] = png
                report["imageBytes"] = len(raw)
                print(f"[vision] Bild gespeichert: {png} ({len(raw)} bytes)")
                break
        except urllib.error.HTTPError as exc:
            print(f"[vision] #{attempt} HTTP {exc.code}: {exc.read().decode()[:200]}", flush=True)
            report["attempts"].append({"attempt": attempt, "http": exc.code})
        except Exception as exc:  # noqa: BLE001
            print(f"[vision] #{attempt} {type(exc).__name__}: {str(exc)[:160]}", flush=True)
            report["attempts"].append({"attempt": attempt, "error": f"{type(exc).__name__}: {str(exc)[:160]}"})
        time.sleep(15)

    with open(f"logs/vision-{stamp}.json", "w", encoding="utf-8") as fh:
        json.dump(report, fh, indent=2, ensure_ascii=False)
    ok = bool(report.get("imagePath"))
    print(f"[vision] fertig: bild={ok}")
    return 0 if ok else 4


if __name__ == "__main__":
    raise SystemExit(main())
