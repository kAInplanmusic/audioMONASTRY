#!/usr/bin/env python3
"""
audioMONASTRY · RunPod vLLM-Brain-Test (OpenAI-Pfad)
====================================================
Misst den vLLM-Worker (runpod-workers/worker-vllm) im Vergleichi zur
transformers-Variante: gleicher Tool-Call-Prompt, gleiche Token-Zahl.

Nutzt `/openai/v1/chat/completions` am Queue-Endpoint (RunPod-API-Key).
Der erste Aufruf zieht Image + Gewichte und initialisiert die Engine → mit
Backoff wiederholen (Kaltstart).

Ergebnis: logs/runpod-vllm-<timestamp>.json
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


def env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def post(url: str, key: str, body: dict, timeout: int):
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        url, data=data,
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json",
                 "User-Agent": "audiomonastry-agent"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, json.loads(r.read().decode() or "null")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--endpoint", default=env("RUNPOD_VLLM_ENDPOINT", "bzpfqamg49bh6x"))
    ap.add_argument("--model", default="Qwen/Qwen3-14B-AWQ")
    ap.add_argument("--prompt", default=PROMPT)
    ap.add_argument("--max-tokens", type=int, default=64)
    ap.add_argument("--attempts", type=int, default=40)
    ap.add_argument("--request-timeout", type=int, default=900)
    ap.add_argument("--explicit-thinking", action="store_true",
                    help="Thinking NICHT abschalten (zum Vergleich)")
    args = ap.parse_args()

    key = env("RP_AGENT_KEY") or env("RP_API_KEY") or env("RUNPOD_API_KEY")
    if not key:
        print("FEHLER: RP_AGENT_KEY fehlt", file=sys.stderr)
        return 2

    url = f"https://api.runpod.ai/v2/{args.endpoint}/openai/v1/chat/completions"
    body = {
        "model": args.model,
        "messages": [{"role": "user", "content": args.prompt}],
        "max_tokens": args.max_tokens,
        "temperature": 0,
    }
    if not args.explicit_thinking:
        # Qwen3: Thinking aus (sonst <think>-Block, der Tokens frisst)
        body["chat_template_kwargs"] = {"enable_thinking": False}

    report = {"ts": datetime.now(timezone.utc).isoformat(), "endpointId": args.endpoint,
              "model": args.model, "maxTokens": args.max_tokens, "prompt": PROMPT, "attempts": []}

    for attempt in range(1, args.attempts + 1):
        started = time.time()
        try:
            st, resp = post(url, key, body, args.request_timeout)
            wall_ms = int((time.time() - started) * 1000)
            usage = (resp or {}).get("usage") or {}
            msg = (((resp or {}).get("choices") or [{}])[0].get("message") or {})
            text = msg.get("content") or ""
            out = {
                "attempt": attempt, "http": st, "wallMs": wall_ms,
                "promptTokens": usage.get("prompt_tokens"),
                "completionTokens": usage.get("completion_tokens"),
                "tokensPerSecond": round((usage.get("completion_tokens") or 0) / max(wall_ms / 1000, 1e-3), 2),
                "textHead": str(text)[:200],
            }
            report["attempts"].append(out)
            print(f"[vllm] #{attempt} http={st} wall={wall_ms}ms "
                  f"tok={usage.get('completion_tokens')} tok/s={out['tokensPerSecond']} "
                  f"-> {str(text)[:90]!r}", flush=True)
            if st == 200 and text:
                break
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode()[:200]
            print(f"[vllm] #{attempt} HTTP {exc.code}: {detail}", flush=True)
            report["attempts"].append({"attempt": attempt, "http": exc.code, "detail": detail})
        except Exception as exc:  # noqa: BLE001 – Kaltstart/Timeout
            print(f"[vllm] #{attempt} {type(exc).__name__}: {str(exc)[:160]}", flush=True)
            report["attempts"].append({"attempt": attempt, "error": f"{type(exc).__name__}: {str(exc)[:160]}"})
        time.sleep(15)

    os.makedirs("logs", exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    path = f"logs/runpod-vllm-{stamp}.json"
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(report, fh, indent=2, ensure_ascii=False)
    ok = any(a.get("http") == 200 and a.get("textHead") for a in report["attempts"])
    print(f"[vllm] Ergebnis gespeichert: {path} | erfolgreich: {ok}")
    return 0 if ok else 4


if __name__ == "__main__":
    raise SystemExit(main())
