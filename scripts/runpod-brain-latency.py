#!/usr/bin/env python3
"""
audioMONASTRY · RunPod Brain-Tier-Latenztest
============================================
Prüft die Entscheidung „zwei Stufen, eine Familie" LIVE am Brain-Endpoint:

  1. `warmup` lädt BEIDE Preload-Modelle (qwen3-4b = Ausführer, qwen3-14b = Brain).
     Das Ergebnis enthält `warmupMs` je Modell – ein Placebo hätte dort ~0 ms.
  2. Je Stufe ein echter `llm`-Job mit identischem Prompt; gemessen werden
     delayTime (Client→Worker), executionTime (Worker) und die im Handler
     ermittelten Tokens/s (ohne Modell-Load).

Voraussetzungen:
  RP_API_KEY / RUNPOD_API_KEY, RUNPOD_ENDPOINT_ID_BRAIN (oder --endpoint).

Ergebnis: logs/runpod-brain-latency-<timestamp>.json (sofort persistiert).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

PROMPT = (
    "Antworte NUR mit JSON, ohne Erklaerung: "
    '{"pluginId":"mixer","command":"gain","channel":"channel1","db":-6}'
)
TIERS = (("qwen3-4b", "simple (Ausfuehrer)"), ("qwen3-14b", "moderate/complex (Brain)"))


def env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def api(url: str, api_key: str, method: str = "GET", body: dict | None = None, timeout: int = 60):
    data = None
    headers = {"Authorization": f"Bearer {api_key}"}
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode() or "null")


def poll(base: str, api_key: str, job_id: str, label: str, deadline_s: int) -> dict:
    started = time.time()
    deadline = started + deadline_s
    final: dict = {"id": job_id, "status": "IN_QUEUE"}
    while time.time() < deadline:
        try:
            final = api(f"{base}/status/{job_id}", api_key, timeout=30)
        except Exception as exc:  # noqa: BLE001
            print(f"  [{label}] status poll error: {exc}", file=sys.stderr)
            time.sleep(5)
            continue
        if final.get("status") in ("COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"):
            break
        print(
            f"  [{label}] t+{int(time.time() - started):4d}s status={final.get('status')}",
            flush=True,
        )
        time.sleep(10)
    return final


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--endpoint", default=env("RUNPOD_ENDPOINT_ID_BRAIN"))
    ap.add_argument("--max-tokens", type=int, default=64)
    ap.add_argument("--skip-warmup", action="store_true")
    ap.add_argument("--warmup-timeout", type=int, default=1500)
    ap.add_argument("--job-timeout", type=int, default=600)
    args = ap.parse_args()

    api_key = env("RP_API_KEY") or env("RUNPOD_API_KEY")
    if not api_key:
        print("FEHLER: RP_API_KEY fehlt", file=sys.stderr)
        return 2
    if not args.endpoint:
        print("FEHLER: RUNPOD_ENDPOINT_ID_BRAIN fehlt", file=sys.stderr)
        return 2

    base = f"https://api.runpod.ai/v2/{args.endpoint}"
    report: dict = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "endpointId": args.endpoint,
        "maxTokens": args.max_tokens,
        "prompt": PROMPT,
        "warmup": None,
        "tiers": {},
    }

    print(f"[tier] Endpoint {args.endpoint} | health:")
    try:
        health = api(f"{base}/health", api_key, timeout=30)
        print("  " + json.dumps(health.get("workers", health), ensure_ascii=False))
    except Exception as exc:  # noqa: BLE001
        print(f"  health nicht lesbar: {exc}", file=sys.stderr)

    if not args.skip_warmup:
        print("[tier] Warmup-Job (laedt beide Preload-Modelle – kann kalt einige Minuten dauern) …")
        t0 = time.time()
        run = api(f"{base}/run", api_key, method="POST", body={"input": {"task": "warmup", "model": "", "input": {}}}, timeout=60)
        job_id = run.get("id")
        final = poll(base, api_key, job_id, "warmup", args.warmup_timeout)
        out = final.get("output") or {}
        report["warmup"] = {"jobId": job_id, "status": final.get("status"), "elapsedSeconds": int(time.time() - t0), "output": out}
        print(f"  -> {final.get('status')} nach {int(time.time() - t0)}s: {json.dumps(out.get('result', out), ensure_ascii=False)[:600]}")

    for model, label in TIERS:
        entry: dict = {"label": label, "runs": []}
        for attempt in (1, 2):
            body = {"input": {"task": "llm", "model": model, "input": {
                "prompt": PROMPT, "maxTokens": args.max_tokens, "temperature": 0}}}
            t0 = time.time()
            run = api(f"{base}/run", api_key, method="POST", body=body, timeout=60)
            job_id = run.get("id")
            final = poll(base, api_key, job_id, f"{model}#{attempt}", args.job_timeout)
            wall = int(time.time() - t0)
            result = ((final.get("output") or {}).get("result") or {})
            entry["runs"].append({
                "attempt": attempt,
                "status": final.get("status"),
                "wallSeconds": wall,
                "delayTimeMs": final.get("delayTime"),
                "executionTimeMs": final.get("executionTime"),
                "generatedTokens": result.get("generatedTokens"),
                "tokensPerSecond": result.get("tokensPerSecond"),
                "textHead": str(result.get("text", ""))[:160],
            })
            print(
                f"  [{model} #{attempt}] {final.get('status')} wall={wall}s "
                f"delay={final.get('delayTime')}ms exec={final.get('executionTime')}ms "
                f"tok/s={result.get('tokensPerSecond')} → {str(result.get('text',''))[:80]!r}"
            )
        report["tiers"][model] = entry

    os.makedirs("logs", exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    path = f"logs/runpod-brain-latency-{stamp}.json"
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(report, fh, indent=2, ensure_ascii=False)
    print(f"[tier] Ergebnis gespeichert: {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
