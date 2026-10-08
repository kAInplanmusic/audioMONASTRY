#!/usr/bin/env python3
"""Gewichte-Spiegel: Hugging Face → R2, damit die Pods nie bei Hugging Face laden müssen.

Je Modell der Pod-Flotte (deploy/runpod/pod-fleet.json) mit gepinnter Revision
(model_manifest.json) entsteht im Bucket:

    weights/<model-id>/<revision>.tar      HF-Cache-Layout (hub/models--org--name/…)
    weights/<model-id>/<revision>.sha256   "<sha256>  <dateiname>"

Die Pods entpacken das Archiv in HF_HOME und laufen offline (pod_start.py).

Ablauf: einmalig auf einem Rechner mit Platz und guter Leitung (z. B. ein CPU-Pod
oder der media-Knoten). Bereits vorhandene Archive werden übersprungen.

    pip install huggingface_hub          # einmalig
    python3 scripts/weights-mirror.py           # zeigt, was fehlt (kein Download)
    python3 scripts/weights-mirror.py --yes     # lädt und spiegelt
    python3 scripts/weights-mirror.py --yes --only brain

Umgebung: CFS3_* / CFR2_ACCOUNT_ID (wie der Server), HF_TOKEN für gegatete Modelle.
Exit-Codes: 0 ok · 2 Konfiguration · 3 Freigabe fehlt · 4 Fehler beim Spiegeln
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import shutil
import sys
import tarfile
import tempfile
from typing import Any, Callable, Dict, List, Optional, Tuple

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import s3lite  # noqa: E402

runpod_pods = None  # lazy, gleiche Lade-Logik wie runpod-pods.py


def _pods_module():
    global runpod_pods
    if runpod_pods is None:
        import importlib.util
        spec = importlib.util.spec_from_file_location("runpod_pods", ROOT / "scripts" / "runpod-pods.py")
        mod = importlib.util.module_from_spec(spec)
        assert spec.loader
        spec.loader.exec_module(mod)
        runpod_pods = mod
    return runpod_pods


#: Repos, die ein Modell zur Laufzeit zusätzlich nachlädt. Offline auf dem Pod
#: müssen sie im selben Archiv liegen. Revision None = beim Spiegeln aktuelle
#: Revision festhalten (steht danach in der .sha256-Begleitdatei).
EXTRA_REPOS: Dict[str, List[Tuple[str, Optional[str]]]] = {
    "pyannote-diarization": [("pyannote/segmentation-3.0", None), ("pyannote/wespeaker-voxceleb-resnet34-LM", None)],
}


def default_download(repo: str, revision: Optional[str], cache_dir: str, token: Optional[str]) -> str:
    try:
        from huggingface_hub import snapshot_download  # type: ignore
    except ImportError as exc:
        raise SystemExit("huggingface_hub fehlt: pip install huggingface_hub") from exc
    return snapshot_download(repo_id=repo, revision=revision, cache_dir=cache_dir, token=token)


#: Austauschbar für Tests: (repo, revision, cache_dir, token) → Pfad des Snapshots.
download: Callable[[str, Optional[str], str, Optional[str]], str] = default_download


def build_archive(model_id: str, model: Dict[str, Any], workdir: str, token: Optional[str]) -> Tuple[str, str]:
    """Lädt Modell (+ Extras) in einen frischen HF-Cache und packt ihn als tar. → (Pfad, sha256)."""
    hf_home = os.path.join(workdir, f"hf-{model_id}")
    cache = os.path.join(hf_home, "hub")
    os.makedirs(cache, exist_ok=True)
    download(model["repository"], model["revision"], cache, token)
    for repo, rev in EXTRA_REPOS.get(model_id, []):
        download(repo, rev, cache, token)
    archive = os.path.join(workdir, f"{model_id.replace('/', '_')}-{model['revision']}.tar")
    with tarfile.open(archive, "w") as tar:
        # Symlinks (snapshots → blobs) bleiben Links; pod_start.py prüft, dass sie im Ziel bleiben.
        tar.add(cache, arcname="hub")
    shutil.rmtree(hf_home, ignore_errors=True)
    return archive, s3lite.sha256_file(archive)


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--yes", action="store_true", help="wirklich laden und hochladen")
    parser.add_argument("--only", default="", help="nur diese Pod-Rollen, z. B. brain,ears")
    parser.add_argument("--force", action="store_true", help="vorhandene Archive neu erzeugen")
    parser.add_argument("--workdir", default="", help="Arbeitsverzeichnis (braucht Platz für das größte Modell × 2)")
    args = parser.parse_args(argv)

    pods = _pods_module()
    fleet, models = pods.load_fleet(), pods.load_models()
    prefix = fleet["weights"]["prefix"]
    roles = set(filter(None, args.only.split(","))) or None
    try:
        target = s3lite.S3Target.from_r2_env()
    except SystemExit as exc:
        print(exc, file=sys.stderr)
        return 2

    todo: List[Tuple[str, str]] = []
    seen = set()
    for pod in fleet["pods"]:
        if roles and pod["role"] not in roles:
            continue
        for mid, rev in pods.models_with_weights(pod, models):
            if mid in seen:
                continue
            seen.add(mid)
            key = pods.weight_key(prefix, mid, rev)
            present = target.head(key) is not None
            print(f"{'✔' if present else '·'} {key}{' (vorhanden)' if present else ''}")
            if args.force or not present:
                todo.append((mid, key))
    if not todo:
        print("Alles gespiegelt.")
        return 0
    if not args.yes:
        print(f"{len(todo)} Modelle fehlen. Mit --yes laden und hochladen.")
        return 3

    token = os.environ.get("HF_TOKEN", "").strip() or None
    workdir = args.workdir or tempfile.mkdtemp(prefix="weights-mirror-")
    failed = 0
    for mid, key in todo:
        try:
            print(f"→ {mid}: lade von Hugging Face …", flush=True)
            archive, sha = build_archive(mid, models[mid], workdir, token)
            size = os.path.getsize(archive)
            print(f"  {size / 2**30:.1f} GB, sha256 {sha[:16]}…, lade nach R2 …", flush=True)
            target.put_file(key, archive, "application/x-tar", meta={"sha256": sha, "model": mid})
            target.put_bytes(key[:-4] + ".sha256", f"{sha}  {os.path.basename(archive)}\n".encode(), "text/plain")
            os.remove(archive)
            print(f"  ✔ {key}")
        except Exception as exc:  # noqa: BLE001 – weiter mit dem nächsten Modell
            failed += 1
            print(f"  ✖ {mid}: {type(exc).__name__}: {exc}", flush=True)
    return 0 if not failed else 4


if __name__ == "__main__":
    sys.exit(main())
