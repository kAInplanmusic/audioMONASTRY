#!/usr/bin/env python3
"""Read-only inventory of R2 model artifacts for the canonical eight-Pod fleet.

Checks both TAR+SHA256 sidecars and per-file Edge manifests. Does not claim
that HEAD presence verifies bytes or model loading. Does not emit credentials,
presigned URLs, authorization headers, or private paths.
"""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("runpod_pods", ROOT / "scripts/runpod-pods.py")
if SPEC is None or SPEC.loader is None:
    raise SystemExit("RunPod fleet module unavailable")
pod = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(pod)
import s3lite  # noqa: E402

SHA256 = re.compile(r"^[a-f0-9]{64}$")


def inventory(store=None) -> dict:
    fleet, models = pod.load_fleet(), pod.load_models()
    store = store or s3lite.S3Target.from_r2_env()
    prefix = fleet["weights"]["prefix"]
    roles = [*fleet["pods"]]
    if fleet.get("visPod", {}).get("enabled"):
        roles.append(fleet["visPod"])
    assigned = {}
    for role in roles:
        for mid in role["models"]:
            assigned.setdefault(mid, []).append(role["role"])
    records = {}
    for mid, role_names in assigned.items():
        model = models.get(mid)
        if model is None:
            records[mid] = {"roles": role_names, "status": "UNKNOWN_MODEL"}
            continue
        revision = str(model.get("revision") or "")
        if revision == "cpu-only":
            records[mid] = {"roles": role_names, "status": "CPU_ONLY_NO_WEIGHTS"}
            continue
        if not pod.REVISION_RE.fullmatch(revision):
            records[mid] = {"roles": role_names, "status": "INVALID_REVISION"}
            continue
        key = pod.weight_key(prefix, mid, revision)
        blob = store.head(key)
        if blob is not None:
            try:
                length = int(blob.get("content-length", "0"))
                raw = store.get_bytes(key[:-4] + ".sha256")
                digest = raw.decode("ascii").split()[0] if raw and len(raw) < 1024 else ""
            except (ValueError, TypeError, UnicodeDecodeError, IndexError):
                length, digest = 0, ""
            records[mid] = {
                "roles": role_names, "status": "METADATA_OK" if length > 0 and SHA256.fullmatch(digest) else "BAD_TAR_SIDECAR",
                "mode": "tar", "fileCount": 1, "byteHashVerified": False,
            }
            continue
        # Edge mirror: inspect each referenced object, not _manifest.json alone.
        try:
            entries = pod.manifest_entries(store, prefix, mid, revision, 60, str(model.get("repository", "")))
        except (ValueError, TypeError, KeyError):
            entries = None
        if not entries:
            records[mid] = {"roles": role_names, "status": "MISSING", "mode": "none"}
            continue
        ok = True
        for entry in entries:
            path = str(entry.get("path", ""))
            digest = str(entry.get("sha256", ""))
            if (not path or path.startswith("/") or ".." in path.split("/")
                    or not SHA256.fullmatch(digest) or int(entry.get("size") or 0) < 1
                    or store.head(f"{prefix}/{mid}/{revision}/{path}") is None):
                ok = False
                break
        records[mid] = {
            "roles": role_names, "status": "METADATA_OK" if ok else "BAD_EDGE_MANIFEST",
            "mode": "edge-per-file", "fileCount": len(entries), "byteHashVerified": False,
        }
    failed = sorted(mid for mid, record in records.items() if record["status"] not in ("METADATA_OK", "CPU_ONLY_NO_WEIGHTS"))
    return {
        "ok": not failed and len(records) == len(models) == 22,
        "verificationLevel": "R2_METADATA_ONLY_NOT_BYTE_VERIFICATION",
        "uniqueModels": len(records), "expectedModels": len(models),
        "gpuVerified": False, "byteHashVerified": False,
        "unverifiedOrMissing": failed, "models": records,
    }


def main() -> int:
    try:
        report = inventory()
        print(json.dumps(report, indent=2, ensure_ascii=False))
        return 0 if report["ok"] else 4
    except Exception as exc:
        print(json.dumps({"ok": False, "status": "R2_ACCESS_OR_QUERY_FAILED",
                          "errorType": type(exc).__name__}), file=sys.stderr)
        return 4


if __name__ == "__main__":
    raise SystemExit(main())
