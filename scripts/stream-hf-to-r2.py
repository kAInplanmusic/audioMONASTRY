#!/usr/bin/env python3
"""Legacy HF-to-R2 helper, now a safe adapter to the canonical mirror.

The previous implementation contained hard-coded S3 credentials, built
incorrect TAR checksum sidecars and buffered complete model files in RAM.
Do not restore that implementation or use credentials in tracked files.

This shim targets the original Qwen3.5-4B model via the canonical
role-based mirror, which reads Cloudflare credentials from environment
variables and checks existing R2 weights before uploading.

No transfer occurs unless --yes is supplied.
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path


def main(argv=None) -> int:
    root = Path(__file__).resolve().parents[1]
    args = list(sys.argv[1:] if argv is None else argv)
    # Do not allow the old helper to target an arbitrary role.
    if "--only" in args or any(a.startswith("--only=") for a in args):
        raise SystemExit("The legacy shim always mirrors the audio-brain role")
    cmd = [sys.executable, str(root / "scripts" / "weights-mirror.py"),
           "--only", "audio-brain", *args]
    return subprocess.call(cmd, cwd=str(root))


if __name__ == "__main__":
    raise SystemExit(main())
