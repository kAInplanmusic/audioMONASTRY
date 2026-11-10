#!/usr/bin/env python3
"""Verify/provision locked auxiliary weights, optionally mirror and audit R2.

No GPU or Pod is started. Secrets may be loaded from a private --env-file.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "services/audiomonastry-ai-runtime"))
from weight_assets import read_lock, ensure_assets, asset_path, verify_file
from s3lite import S3Target


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", type=Path)
    parser.add_argument("--only", action="append", help="model/component id; repeatable")
    action = parser.add_mutually_exclusive_group()
    action.add_argument("--download", action="store_true")
    action.add_argument("--mirror", action="store_true")
    action.add_argument("--check-r2", action="store_true")
    parser.add_argument("--full", action="store_true", help="stream and hash R2 objects, rather than HEAD metadata")
    args = parser.parse_args()
    if args.env_file:
        for line in args.env_file.read_text().splitlines():
            if line.strip() and not line.lstrip().startswith("#") and "=" in line:
                key, value = line.split("=", 1)
                os.environ[key.strip()] = value.strip().strip('"').strip("'")
    lock = read_lock()
    ids = args.only or list(lock)
    if set(ids) - set(lock):
        parser.error("unknown model/component id")
    target = S3Target.from_r2_env() if args.mirror or args.check_r2 else None
    results = []
    for model_id in ids:
        entry = lock[model_id]
        try:
            if args.download or args.mirror:
                ensure_assets(model_id)
            for spec in entry["files"]:
                if not args.check_r2:
                    path = asset_path(model_id, spec, entry)
                    if not verify_file(path, spec):
                        raise RuntimeError(f"missing/corrupt local asset: {spec['path']}")
                # Bundled Basic Pitch weights belong to the hash-pinned wheel.
                # They are verified locally, not uploaded as duplicate R2 blobs.
                if entry.get("package"):
                    if args.check_r2:
                        ensure_assets(model_id, download=False)
                    continue
                key = f"weights/{model_id}/{entry['revision']}/{spec['path']}"
                if args.mirror:
                    target.put_file(key, str(path), meta={"sha256": spec["sha256"]})
                if target:
                    head = target.head(key)
                    if not head or int(head.get("content-length", -1)) != spec["size"]:
                        raise RuntimeError(f"R2 missing/wrong size: {spec['path']}")
                    if args.full:
                        digest = hashlib.sha256()
                        size = 0
                        with urllib.request.urlopen(target.presign("GET", key), timeout=120) as response:
                            for block in iter(lambda: response.read(1024 * 1024), b""):
                                size += len(block)
                                if size > spec["size"]:
                                    raise RuntimeError("R2 oversized asset")
                                digest.update(block)
                        if size != spec["size"] or digest.hexdigest() != spec["sha256"]:
                            raise RuntimeError(f"R2 hash mismatch: {spec['path']}")
                    elif head.get("x-amz-meta-sha256") != spec["sha256"]:
                        raise RuntimeError(f"R2 hash metadata absent/mismatched: {spec['path']}; use --full")
            if args.mirror and not entry.get("package"):
                key = f"weights/{model_id}/{entry['revision']}/_assets.json"
                target.put_bytes(key, json.dumps(entry).encode(), content_type="application/json")
            results.append({"id": model_id, "ok": True})
        except Exception as exc:
            # Do not print signed URLs, request headers or credentials.
            results.append({"id": model_id, "ok": False, "errorType": type(exc).__name__})
    print(json.dumps({"mode": "r2-full" if args.check_r2 and args.full else "r2-metadata" if args.check_r2 else "mirror" if args.mirror else "local", "results": results}, indent=2))
    return 0 if all(r["ok"] for r in results) else 1


if __name__ == "__main__":
    sys.exit(main())
