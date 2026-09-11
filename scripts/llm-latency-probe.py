#!/usr/bin/env python3
"""Misst die Latenz der bereits vorhandenen Provider gegen einen realistischen
Ausfuehrer-Prompt (kurzer Tool-Call) – Grundlage fuer die Zwei-Stufen-Entscheidung.

Gibt keine Keys aus; schreibt Rohwerte nach reports/llm-latency.json.
"""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENV = ROOT / ".env"

PROMPT = (
    "Antworte NUR mit JSON, ohne Erklaerung: "
    '{"pluginId":"mixer","command":"gain","channel":"channel1","db":-6}'
)


def env(name: str) -> str:
    for line in ENV.read_text(encoding="utf-8").splitlines():
        if line.strip().startswith(f"{name}="):
            return line.strip().split("=", 1)[1].strip()
    return ""


TARGETS = [
    ("cerebras", "https://api.cerebras.ai/v1/chat/completions", "CB_API_KEY", env("CEREBRAS_MODEL") or "llama-3.3-70b"),
    ("deepseek-flash", "https://api.deepseek.com/chat/completions", "DEEPSEEK_API_KEY", "deepseek-v4-flash"),
    ("openrouter", "https://openrouter.ai/api/v1/chat/completions", "OR_API_KEY", env("OPENROUTER_MODEL") or "meta-llama/llama-3.3-70b-instruct"),
]

results = []
for name, url, keyname, model in TARGETS:
    key = env(keyname)
    if not key:
        results.append({"provider": name, "skipped": f"{keyname} fehlt"})
        print(f"  {name:16s} uebersprungen ({keyname} fehlt)")
        continue
    body = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": PROMPT}],
        "max_tokens": 64,
        "temperature": 0.2,
    }).encode()
    h = {"Authorization": f"Bearer {key}", "Content-Type": "application/json", "User-Agent": "audioMONASTRY-latency-probe"}
    t0 = time.time()
    try:
        with urllib.request.urlopen(urllib.request.Request(url, data=body, headers=h, method="POST"), timeout=90) as r:
            data = json.loads(r.read().decode() or "null")
        ms = int((time.time() - t0) * 1000)
        text = ""
        usage = {}
        try:
            text = data["choices"][0]["message"]["content"]
            usage = data.get("usage") or {}
        except Exception:  # noqa: BLE001
            text = json.dumps(data)[:150]
        out_tokens = usage.get("completion_tokens")
        tps = round(out_tokens / (ms / 1000), 1) if out_tokens and ms else None
        results.append({"provider": name, "model": model, "latencyMs": ms, "completionTokens": out_tokens, "tokensPerSecond": tps, "textHead": text[:110]})
        print(f"  {name:16s} {ms:6d} ms  {out_tokens if out_tokens else '?':>4} tokens  {tps if tps else '?':>7} tok/s  {text[:60]!r}")
    except urllib.error.HTTPError as e:
        results.append({"provider": name, "httpError": e.code, "body": e.read().decode()[:160]})
        print(f"  {name:16s} HTTP {e.code} {e.read()[:100]}")
    except Exception as e:  # noqa: BLE001
        results.append({"provider": name, "error": str(e)[:160]})
        print(f"  {name:16s} {type(e).__name__}: {str(e)[:80]}")

Path(ROOT / "reports").mkdir(exist_ok=True)
(ROOT / "reports" / "llm-latency.json").write_text(json.dumps({"prompt": PROMPT, "results": results}, indent=2, ensure_ascii=False), encoding="utf-8")
print("\nRohdaten: reports/llm-latency.json")
