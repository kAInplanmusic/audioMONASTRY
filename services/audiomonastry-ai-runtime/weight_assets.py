"""Pinned auxiliary weights, verified before use; no implicit latest downloads."""
from __future__ import annotations

import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parent
_VERIFIED = set()


def read_lock():
    return json.loads((ROOT / "weight_assets.lock.json").read_text())["models"]


def asset_root():
    return Path(os.environ.get("AI_WEIGHT_ASSET_ROOT", "/data/weights"))


def verify_file(path, spec):
    path = Path(path)
    if not path.is_file() or path.stat().st_size != spec["size"]:
        return False
    stat = path.stat()
    identity = (str(path.resolve()), stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns, spec["sha256"])
    if identity in _VERIFIED:
        return True
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    valid = digest.hexdigest() == spec["sha256"]
    if valid:
        _VERIFIED.add(identity)
    return valid


def asset_path(model_id, spec, entry=None):
    entry = entry or read_lock()[model_id]
    if entry.get("package"):
        dist = importlib.metadata.distribution(entry["package"])
        if dist.version != entry["packageVersion"]:
            raise RuntimeError(f"{model_id}: package version mismatch: {dist.version}")
        return Path(dist.locate_file(spec["path"]))
    return asset_root() / model_id / spec["path"]


def ensure_assets(model_id, *, download=True):
    """Atomic downloads; partial or corrupted weights never reach a loader."""
    entry = read_lock()[model_id]
    paths = {}
    for spec in entry["files"]:
        path = asset_path(model_id, spec, entry)
        if not verify_file(path, spec):
            if entry.get("package") or not download:
                raise RuntimeError(f"{model_id}: missing/corrupt pinned asset {spec['path']}")
            path.parent.mkdir(parents=True, exist_ok=True)
            request = urllib.request.Request(spec["url"], headers={"User-Agent": "audioMONASTRY-weight-provisioner"})
            temp = None
            try:
                with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as out:
                    temp = Path(out.name)
                    with urllib.request.urlopen(request, timeout=120) as response:
                        while True:
                            block = response.read(1024 * 1024)
                            if not block:
                                break
                            out.write(block)
                            if out.tell() > spec["size"]:
                                raise RuntimeError(f"{model_id}: oversized asset {spec['path']}")
                if not verify_file(temp, spec):
                    raise RuntimeError(f"{model_id}: SHA-256/size mismatch: {spec['path']}")
                os.replace(temp, path)
            finally:
                if temp is not None:
                    temp.unlink(missing_ok=True)
        paths[spec["path"]] = str(path)
    return paths


def prepare_role_assets(model_ids):
    """Called before readiness; components do not become extra fleet models."""
    manifest = json.loads((ROOT / "model_manifest.json").read_text())
    models = {m["id"]: m for m in manifest["models"]}
    sources = {**models, **manifest.get("weightComponents", {})}
    lock = read_lock()
    prepared = []
    for model_id in model_ids:
        if model_id not in models:
            raise RuntimeError(f"unknown role model: {model_id}")
        ids = [model_id, *models[model_id].get("weightComponents", [])]
        for asset_id in ids:
            if asset_id in lock and asset_id not in prepared:
                entry = lock[asset_id]
                source = sources.get(asset_id, {})
                if any(entry[k] != source.get(k) for k in ("repository", "revision")):
                    raise RuntimeError(f"{asset_id}: manifest and asset lock identity differ")
                ensure_assets(asset_id)
                prepared.append(asset_id)
    return prepared
