#!/usr/bin/env python3
"""Deprecated R2 streamer. Use the maintained, secret-safe mirror instead.

The former experimental version contained hard-coded Cloudflare S3 credentials,
buffered full HF snapshots and had an incomplete TAR/sidecar implementation.
Kept only as a CLI compatibility wrapper. No credentials belong in source.
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path


def main(argv=None) -> int:
    root = Path(__file__).resolve().parents[1]
    args = list(sys.argv[1:] if argv is None else argv)
    # Original program was an experimental brain mirror; this shim remains
    # pinned to the current canonical brain pod definition.
    if "--only" in args or any(arg.startswith("--only=") for arg in args):
        raise SystemExit("The legacy shim targets only the brain role")
    return subprocess.call(
        [sys.executable, str(root / "scripts/weights-mirror.py"), "--only", "brain", *args],
        cwd=str(root),
    )


if __name__ == "__main__":
    raise SystemExit(main())
