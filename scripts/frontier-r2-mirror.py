#!/usr/bin/env python3
"""Mirror pinned frontier CANDIDATES into a separate Cloudflare R2 staging prefix.

No production manifest or runtime is changed. Nothing downloads or uploads
without --yes. Downloads full Hugging Face snapshots, including dependencies
contained in the repository, preserving the HF cache layout for offline use.

Requirements:
  pip install huggingface_hub
  export CFS3_ACCESS_KEY=... CFS3_SECRET_KEY=... CFS3_BUCKET=...
  export CFR2_ACCOUNT_ID=...  # or CFS3_ENDPOINT
  export HF_TOKEN=...         # only needed for gated repos

Examples:
  python3 scripts/frontier-r2-mirror.py                      # dry-run only
  python3 scripts/frontier-r2-mirror.py --yes --only qwen3.5-9b --workdir /data/weight-stage
  python3 scripts/frontier-r2-mirror.py --yes --all --skip-gated --skip-research --workdir /data/weight-stage

Never put credentials into CLI arguments, source code, logs, or Git.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sys
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from s3lite import S3Target  # noqa: E402

CATALOG = ROOT / "deploy/gpu/frontier-candidates.json"
REVISION_RE = re.compile(r"^[0-9a-f]{40}$")
ID_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$")


def read_catalog(path: Path = CATALOG) -> dict:
    data = json.loads(path.read_text(encoding="utf-8"))
    if data.get("schemaVersion") != 1:
        raise ValueError("unsupported frontier catalog version")
    models = data.get("models")
    if not isinstance(models, list) or not models:
        raise ValueError("frontier catalog has no models")
    seen = set()
    for item in models:
        mid = item.get("id")
        if not isinstance(mid, str) or not ID_RE.fullmatch(mid) or mid in seen:
            raise ValueError(f"invalid or duplicate model ID: {mid!r}")
        seen.add(mid)
        repo = item.get("repository")
        rev = item.get("revision")
        if not isinstance(repo, str) or not re.fullmatch(r"[A-Za-z0-9._-]+/[A-Za-z0-9._-]+", repo):
            raise ValueError(f"{mid}: invalid repository")
        if not isinstance(rev, str) or not REVISION_RE.fullmatch(rev):
            raise ValueError(f"{mid}: immutable 40-character HF revision required")
        if item.get("stage") != "candidate":
            raise ValueError(f"{mid}: only nonproduction candidates are mirrorable")
        if item.get("mirrorPolicy") not in ("on-demand", "research-explicit"):
            raise ValueError(f"{mid}: unsupported mirror policy")
    return data


def object_key(prefix: str, model: dict) -> str:
    return f"{prefix}/{model['id']}/{model['revision']}.tar"


def digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        while True:
            chunk = f.read(8 * 1024 * 1024)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def archive_snapshot(model: dict, directory: Path, token: str | None) -> tuple[Path, str]:
    try:
        from huggingface_hub import snapshot_download
    except ImportError as exc:
        raise RuntimeError("install huggingface_hub before --yes") from exc
    mid = model["id"]
    revision = model["revision"]
    work = Path(tempfile.mkdtemp(prefix=f"hf-{mid}-", dir=directory))
    hub = work / "hub"
    hub.mkdir()
    try:
        snapshot = Path(snapshot_download(
            repo_id=model["repository"],
            revision=revision,
            cache_dir=str(hub),
            token=token,
        ))
        # Verify the HF cache snapshot matches precisely the pinned revision.
        if snapshot.name != revision:
            raise RuntimeError(f"{mid}: resolved revision differs from pin")
        if not snapshot.exists():
            raise RuntimeError(f"{mid}: missing snapshot")
        output = directory / f"{mid}-{revision}.tar"
        try:
            with tarfile.open(output, "w") as tar:
                tar.add(hub, arcname="hub", recursive=True)
        except Exception:
            output.unlink(missing_ok=True)
            raise
        return output, digest(output)
    finally:
        shutil.rmtree(work, ignore_errors=True)


def verified_existing(target: S3Target, key: str) -> bool:
    meta = target.head(key)
    sidecar = target.get_bytes(key[:-4] + ".sha256")
    if not meta and not sidecar:
        return False
    if not meta or not sidecar:
        raise RuntimeError(f"{key}: partial R2 mirror exists; investigate before overwriting")
    sha = sidecar.decode("ascii").split()[0]
    if not re.fullmatch(r"[0-9a-f]{64}", sha):
        raise RuntimeError(f"{key}: malformed checksum sidecar")
    metadata_sha = meta.get("x-amz-meta-sha256")
    if metadata_sha and metadata_sha != sha:
        raise RuntimeError(f"{key}: object metadata/sidecar SHA mismatch")
    return True


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--yes", action="store_true", help="allow download and R2 uploads")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--only", default="", help="comma-separated candidate model IDs")
    group.add_argument("--all", action="store_true", help="all eligible candidates")
    parser.add_argument("--skip-gated", action="store_true", help="skip models needing HF approval")
    parser.add_argument("--skip-research", action="store_true", help="skip very large research-only models")
    parser.add_argument("--workdir", type=Path, help="large staging disk (required for --yes)")
    parser.add_argument("--prefix", default="weights-candidates", help="isolated R2 prefix; cannot equal production weights")
    args = parser.parse_args(argv)

    if not re.fullmatch(r"[A-Za-z0-9._/-]+", args.prefix) or args.prefix.strip("/") == "weights":
        parser.error("invalid/production R2 prefix")
    if args.prefix.startswith("/") or ".." in args.prefix.split("/"):
        parser.error("unsafe prefix")
    catalog = read_catalog()
    models = {m["id"]: m for m in catalog["models"]}
    if args.only:
        names = list(dict.fromkeys(x.strip() for x in args.only.split(",") if x.strip()))
        missing = sorted(set(names) - set(models))
        if missing:
            parser.error("unknown candidate IDs: " + ", ".join(missing))
    else:
        names = list(models)
    if args.skip_gated:
        names = [x for x in names if not models[x].get("gated")]
    if args.skip_research:
        names = [x for x in names if models[x].get("mirrorPolicy") != "research-explicit"]
    for mid in names:
        m = models[mid]
        print(f"{mid}: {m['repository']}@{m['revision']} -> {object_key(args.prefix, m)}", flush=True)
    if not args.yes:
        print(f"DRY RUN: {len(names)} candidates; no network, R2 or GPU mutations.")
        return 0
    if not args.only and not args.all:
        parser.error("explicitly select --only or --all with --yes")
    if args.workdir is None:
        parser.error("--workdir is required for --yes (model snapshots need substantial free disk)")
    args.workdir.mkdir(parents=True, exist_ok=True)
    token = os.environ.get("HF_TOKEN", "").strip() or None
    if any(models[mid].get("gated") for mid in names) and not token:
        parser.error("HF_TOKEN is required for gated models; use --skip-gated until access is granted")
    target = S3Target.from_r2_env()
    failures = 0
    for mid in names:
        model = models[mid]
        key = object_key(args.prefix, model)
        try:
            if verified_existing(target, key):
                print(f"SKIP {mid}: R2 archive + checksum present", flush=True)
                continue
            # Streaming to temporary storage is intentionally not attempted:
            # enough disk to hold both the downloaded model and TAR is required.
            free_gb = shutil.disk_usage(args.workdir).free / (1024**3)
            if free_gb < 25:
                raise RuntimeError(f"insufficient staging disk: {free_gb:.1f} GiB free (min 25 GiB)")
            archive, sha = archive_snapshot(model, args.workdir, token)
            try:
                target.put_file(key, str(archive), "application/x-tar",
                                meta={"sha256": sha, "candidate": "true"})
                target.put_bytes(key[:-4] + ".sha256",
                                 f"{sha}  {archive.name}\n".encode(), "text/plain")
                if not verified_existing(target, key):
                    raise RuntimeError(f"{mid}: verification after upload failed")
                print(f"UPLOADED {mid}: {archive.stat().st_size} bytes sha256={sha}", flush=True)
            finally:
                archive.unlink(missing_ok=True)
        except Exception as exc:
            failures += 1
            print(f"FAILED {mid}: {type(exc).__name__}: {exc}", file=sys.stderr, flush=True)
    return 0 if failures == 0 else 4


if __name__ == "__main__":
    raise SystemExit(main())
