#!/usr/bin/env python3
"""Testet den OpenAI-kompatiblen Pfad des vLLM-Brain-Workers und misst den Kaltstart.

Aufruf: python3 scripts/runpod-brain-openai-test.py
Erwartung: 502/503 solange der Worker hochkommt und die Gewichte zieht -> Retry.
"""
from __future__ import annotations

import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENV = ROOT / ".env"
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36"
ENDPOINT = "ppxo7wrn599p0q"
MAX_WAIT_S = int(sys.argv[1]) if len(sys.argv) > 1 else 900


def env(name: str, default: str = "") -> str:
    for line in ENV.read_text(encoding="utf-8").splitlines():
        if line.strip().startswith(f"{name}="):
            return line.strip().split("=", 1)[1].strip()
    return default


KEY = env("RP_AGENT_KEY") or env("RP_API_KEY") or env("RUNPOD_API_KEY")
BASE = f"https://api.runpod.ai/v2/{ENDPOINT}/openai/v1"
PROMPT = "Antworte in genau einem kurzen deutschen Satz: Was ist ein Drop in einer DAW?"


def post(url, body, timeout=180):
    data = json.dumps(body).encode()
    h = {"Authorization": f"Bearer {KEY}", "User-Agent": UA, "Content-Type": "application/json"}
    try:
        with urllib.request.urlopen(urllib.request.Request(url, data=data, headers=h, method="POST"), timeout=timeout) as r:
            return r.status, json.loads(r.read().decode() or "null")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:200]
    except Exception as e:  # noqa: BLE001
        return -1, f"{type(e).__name__}: {e}"[:200]


def balance_spend():
    body = json.dumps({"query": "query { myself { clientBalance currentSpendPerHr } }"}).encode()
    h = {"Authorization": f"Bearer {KEY}", "User-Agent": UA, "Content-Type": "application/json"}
    try:
        with urllib.request.urlopen(urllib.request.Request("https://api.runpod.io/graphql", data=body, headers=h, method="POST"), timeout=45) as r:
            m = ((json.load(r).get("data") or {}).get("myself") or {})
            return m.get("clientBalance"), m.get("currentSpendPerHr")
    except Exception:  # noqa: BLE001
        return None, None


print(f"[openai-test] Endpoint {ENDPOINT}")
print(f"[openai-test] Basis {BASE}")
print(f"[openai-test] Prompt: {PROMPT}")

t0 = time.time()
attempt = 0
result = None
while time.time() - t0 < MAX_WAIT_S:
    attempt += 1
    st, res = post(f"{BASE}/chat/completions", {
        "model": "qwen3-14b-awq",
        "messages": [{"role": "user", "content": PROMPT}],
        "max_tokens": 64,
        "temperature": 0.3,
    }, timeout=240)
    elapsed = int(time.time() - t0)
    bal, sp = balance_spend()
    if st == 200 and isinstance(res, dict):
        text = ""
        try:
            text = res["choices"][0]["message"]["content"]
        except Exception:  # noqa: BLE001
            text = json.dumps(res)[:200]
        print(f"[openai-test] t+{elapsed:4d}s VERSUCH {attempt}: HTTP 200 in {elapsed}s (KALTSTART BIS ERSTE ANTWORT)")
        print(f"[openai-test] spend=${sp}/h bal=${bal}")
        print(f"[openai-test] TEXT: {text!r}")
        result = {"coldStartSeconds": elapsed, "attempts": attempt, "text": text, "raw": res}
        break
    print(f"[openai-test] t+{elapsed:4d}s VERSUCH {attempt}: HTTP {st} {str(res)[:110]}")
    time.sleep(20)

if not result:
    print("[openai-test] KEIN ERFOLG innerhalb des Zeitfensters", file=sys.stderr)
    sys.exit(2)

Path("/tmp/brain_openai_test.json").write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8")
print("[openai-test] Rohdaten: /tmp/brain_openai_test.json")
