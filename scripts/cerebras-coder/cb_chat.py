#!/usr/bin/env python3
"""Cerebras Coding-Helper (Standard-Subagent für Plan/Patch/Review).

OpenAI-kompatibler Aufruf der Cerebras-API. Liest CB_API_KEY aus der
Umgebung oder aus /home/patrick/audioMONASTRY/.env (überschreibt keine
bereits gesetzten Env-Variablen).

Verfügbare Modelle (Stand 2026-09): gpt-oss-120b, qwen-3.8-27b, gemma-4-31b.
Default: gpt-oss-120b (stärkstes Modell für Code-/Architekturfragen).

Usage:
  python3 scripts/cerebras-coder/cb_chat.py --model gpt-oss-120b \
      --sys "Du bist ein Audio-DSP-Experte." --prompt "Refactore ..."
  cat prompt.txt | python3 scripts/cerebras-coder/cb_chat.py \
      --model qwen-3.8-27b --sys "Du bist ein TypeScript-Spezialist."
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

DEFAULT_ENV_FILE = Path(__file__).resolve().parents[2] / ".env"
BASE_URL = "https://api.cerebras.ai/v1/chat/completions"
DEFAULT_MODEL = "gpt-oss-120b"


def load_api_key() -> str:
    candidates = [Path(os.environ["CB_ENV_FILE"])] if os.environ.get("CB_ENV_FILE") else []
    candidates.append(DEFAULT_ENV_FILE)
    for candidate in candidates:
        if not candidate.is_file():
            continue
        try:
            for raw in candidate.read_text(encoding="utf-8").splitlines():
                line = raw.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                key, value = key.strip(), value.strip()
                if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
                    value = value[1:-1]
                if key and key not in os.environ:
                    os.environ[key] = value
        except OSError:
            continue
    key = os.environ.get("CB_API_KEY", "").strip()
    if not key:
        raise SystemExit("CB_API_KEY nicht gefunden (Umgebung oder .env).")
    return key


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--sys", default="Du bist ein erfahrener Software-Ingenieur.")
    ap.add_argument("--prompt", default=None)
    ap.add_argument("--max-tokens", type=int, default=8192)
    ap.add_argument("--temperature", type=float, default=0.2)
    ap.add_argument("--json", action="store_true", help="JSON-Objekt als Antwort erzwingen")
    ap.add_argument("--reasoning", action="store_true", help="Reasoning-Trace mit ausgeben")
    args = ap.parse_args()

    prompt = args.prompt if args.prompt is not None else sys.stdin.read()
    if not prompt.strip():
        raise SystemExit("Leerer Prompt.")

    body = {
        "model": args.model,
        "messages": [
            {"role": "system", "content": args.sys},
            {"role": "user", "content": prompt},
        ],
        "max_tokens": args.max_tokens,
        "temperature": args.temperature,
    }
    if args.json:
        body["response_format"] = {"type": "json_object"}

    proc = subprocess.run(
        [
            "curl", "-sS", BASE_URL,
            "-H", f"Authorization: Bearer {load_api_key()}",
            "-H", "Content-Type: application/json",
            "-d", json.dumps(body),
        ],
        capture_output=True,
        text=True,
        timeout=900,
    )
    if proc.returncode != 0:
        sys.stderr.write(proc.stderr)
        raise SystemExit(proc.returncode)
    try:
        data = json.loads(proc.stdout)
    except json.JSONDecodeError:
        sys.stderr.write(proc.stdout[:4000])
        raise SystemExit(2)
    if "choices" not in data:
        sys.stderr.write(json.dumps(data, indent=2)[:4000])
        raise SystemExit(3)

    msg = data["choices"][0]["message"]
    if args.reasoning and msg.get("reasoning"):
        print("--- REASONING ---")
        print(msg["reasoning"])
        print("--- CONTENT ---")
    print(msg.get("content") or "")


if __name__ == "__main__":
    main()
