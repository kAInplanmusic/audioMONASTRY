#!/usr/bin/env python3
"""Resolve a truncated Hugging Face revision without guessing.

Validates HF model metadata + response SHA + exact checkpoint LFS SHA256.
Never downloads or executes the checkpoint. --apply updates manifest only after
both immutable commit and content digest are verified. Default is read-only.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import pathlib
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
PATH = ROOT / "services/audiomonastry-ai-runtime/model_manifest.json"
MODEL_ID = "mel-roformer-bve"
REPO = "Gonzaluigi/Mel-Band-Roformer-BVE-Gonzaluigi"
PREFIX = "c73a679"
FILE = "mel_band_roformer_bve_gonza.ckpt"
EXPECTED = "e003bbb97ebef78c59cd6b46c5fc3d0f2303cd49f6fb98eb8b8f0f8075899ae3"
HEX40 = re.compile(r"^[a-f0-9]{40}$")

def metadata(url: str) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent":"audioMONASTRY-runpod-pinning/1.0","Accept":"application/json"})
    with urllib.request.urlopen(req, timeout=25) as response:
        return json.load(response)

def verify(data: dict) -> str:
    sha = data.get("sha", "")
    if not isinstance(sha, str) or not HEX40.fullmatch(sha) or not sha.startswith(PREFIX):
        raise ValueError("Upstream revision does not resolve to expected immutable full SHA")
    siblings = data.get("siblings")
    if not isinstance(siblings, list):
        raise ValueError("Upstream metadata lacks siblings; cannot validate checkpoint")
    files = [x for x in siblings if x.get("rfilename") == FILE]
    if len(files) != 1:
        raise ValueError("Expected checkpoint missing or ambiguous")
    item = files[0]
    lfs = item.get("lfs") or {}
    xet = item.get("xet") or {}
    digest = lfs.get("sha256") or xet.get("sha256")
    if digest != EXPECTED:
        raise ValueError("Checkpoint SHA256 absent or differs from expected independent source")
    return sha

def resolve() -> str:
    repo = urllib.parse.quote(REPO, safe="/")
    # 'blobs=true' requests file metadata, including LFS SHA-256.
    url = f"https://huggingface.co/api/models/{repo}/revision/{PREFIX}?blobs=true"
    sha = verify(metadata(url))
    # Re-read at immutable full SHA; ensure the same checkpoint content.
    immutable = f"https://huggingface.co/api/models/{repo}/revision/{sha}?blobs=true"
    if verify(metadata(immutable)) != sha:
        raise ValueError("Immutable revision recheck failed")
    return sha

def update(sha: str) -> None:
    manifest = json.loads(PATH.read_text(encoding="utf-8"))
    matches = [m for m in manifest["models"] if m.get("id") == MODEL_ID]
    if len(matches) != 1 or matches[0].get("repository") != REPO:
        raise ValueError("Manifest model identity drift")
    current = matches[0]["revision"]
    if current != PREFIX and current != sha:
        raise ValueError(f"Refusing to overwrite unexpected revision {current}")
    matches[0]["revision"] = sha
    note = matches[0].get("note", "")
    note = note.replace("full HF commit SHA pending", "full HF commit SHA API-verified")
    matches[0]["note"] = note
    PATH.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="write verified full commit to manifest")
    args = parser.parse_args()
    try:
        sha = resolve()
        if args.apply:
            update(sha)
        print(json.dumps({"model":MODEL_ID,"revision":sha,"checkpoint":FILE,
                          "sha256":EXPECTED,"manifestUpdated":args.apply},indent=2))
        return 0
    except (ValueError, KeyError, urllib.error.URLError, TimeoutError, OSError) as exc:
        print(f"BLOCKED: cannot pin checkpoint safely: {exc}", file=sys.stderr)
        return 4

if __name__ == "__main__":
    raise SystemExit(main())
