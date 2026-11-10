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

#: Gemeinsame Bausteine aus einem ANDEREN Manifest-Eintrag (Repo + Revision von
#: dort, nie ungepinnt), nur die genannten Unterordner. FLEET-P1-010: die
#: ACE-Step-XL-Modelle brauchen VAE + Text-Encoder aus `acestep-v15-shared`
#: (ACE-Step/Ace-Step1.5: nur vae/ und Qwen3-Embedding-0.6B/, nicht das ganze Repo
#: mit turbo + lm-1.7B). handlers_voice.acestep_checkpoints liest sie offline.
ACESTEP_SHARED = ("acestep-v15-shared", ("vae/*", "Qwen3-Embedding-0.6B/*"))
EXTRA_MANIFEST_REPOS: Dict[str, List[Tuple[str, Tuple[str, ...]]]] = {
    "acestep-v15-xl-base": [ACESTEP_SHARED],
    "acestep-v15-xl-sft": [ACESTEP_SHARED],
    "acestep-v15-xl-turbo": [ACESTEP_SHARED],
}


def default_download(repo: str, revision: Optional[str], cache_dir: str, token: Optional[str],
                     allow_patterns: Optional[List[str]] = None,
                     ignore_patterns: Optional[List[str]] = None) -> str:
    try:
        from huggingface_hub import snapshot_download  # type: ignore
    except ImportError as exc:
        raise SystemExit("huggingface_hub fehlt: pip install huggingface_hub") from exc
    return snapshot_download(repo_id=repo, revision=revision, cache_dir=cache_dir, token=token,
                             allow_patterns=allow_patterns, ignore_patterns=ignore_patterns)


def extra_manifest_downloads(model_id: str, models: Dict[str, Dict[str, Any]]) -> List[Tuple[str, str, List[str]]]:
    """(Repo, Revision, Muster) der Manifest-Bausteine eines Modells. Fehlt der
    Eintrag oder ist er nicht gepinnt, bricht das Spiegeln ab (kein ungepinnter Zusatz)."""
    out: List[Tuple[str, str, List[str]]] = []
    for extra_id, patterns in EXTRA_MANIFEST_REPOS.get(model_id, []):
        extra = models.get(extra_id)
        if not extra or not extra.get("repository") or len(str(extra.get("revision") or "")) != 40:
            raise ValueError(f"{model_id}: Baustein {extra_id} fehlt im Manifest oder ist nicht gepinnt")
        out.append((str(extra["repository"]), str(extra["revision"]), list(patterns)))
    return out


#: Austauschbar für Tests: (repo, revision, cache_dir, token[, allow_patterns=]) → Pfad des Snapshots.
download: Callable[..., str] = default_download


#: Dateien, die nie in ein Pod-Archiv gehoeren: formatgleiche Duplikate, die
#: transformers/diffusers nie laden, wenn safetensors vorhanden ist. Live gemessen
#: 2026-11-08: whisper-large-v3 war als 33,2-GB-TAR gespiegelt, obwohl das Modell
#: nur ~3,1 GB braucht (flax_model.msgpack 6,2 GB + fp32-Safetensors/Bins 12,3 GB
#: + pytorch_model.bin 3,1 GB waren mitgepackt).
JUNK_PATTERNS = [
    "flax_model.msgpack",   # Flax/JAX-Duplikat
    "tf_model.h5",          # TensorFlow-Duplikat
    "*.fp32-*",             # fp32-Safetensors/Bins; bf16/fp16 reicht
    "*.msgpack",            # sonstige Flax-Artefakte
    "*.onnx",               # ONNX-Exporte, hier nie genutzt
    "optimizer.pt",         # Trainings-Artefakte
    "scheduler.pt",
    "training_args.bin",
    "*.ckpt",               # Lightning-Checkpoints (nicht die safetensors-Modelle)
]


MVSEP_RELEASE = "https://github.com/ZFTurbo/Music-Source-Separation-Training/releases/download/v1.0.21/"
MVSEP_ASSETS = {
    "mvsep_mega_model_bs_roformer_53_stems_v1.ckpt":
        ("c62820893bbf86d4e734f966bd142d9157cfc8bb8e79e9d8f9ea553f3ff3519f", 1368919887),
    "mvsep_mega_model_bs_roformer_53_stems.yaml":
        ("7e198062a251587088adb91215a4f44ab59e67bd62fcc805cf54d6e7dfc51103", 4184),
}


def build_mvsep_release_archive(model_id: str, model: Dict[str, Any], workdir: str) -> Tuple[str, str]:
    """Mirror official GitHub release files; verify bytes before R2 upload.

    Release tag may be mutable, but the expected full SHA-256 hashes are not.
    Never accept a changed checkpoint at this release URL.
    """
    import urllib.request
    if model_id != "mvsep-mega-53" or model.get("repository") != "ZFTurbo/Music-Source-Separation-Training":
        raise ValueError("MVSEP source identity does not match SSOT")
    if len(str(model.get("revision", ""))) != 40:
        raise ValueError("MVSEP release revision must be a 40-char pinned commit")
    release_dir = pathlib.Path(workdir) / "mvsep-release"
    if release_dir.exists():
        shutil.rmtree(release_dir)
    payload_dir = release_dir / "extras" / model_id
    payload_dir.mkdir(parents=True, exist_ok=True)
    for name, (expected_sha, expected_size) in MVSEP_ASSETS.items():
        target_file = payload_dir / name
        request = urllib.request.Request(
            MVSEP_RELEASE + name, headers={"User-Agent": "audioMONASTRY-weights-mirror/1.0"})
        digest = hashlib.sha256()
        total = 0
        with urllib.request.urlopen(request, timeout=120) as response, target_file.open("wb") as output:
            while True:
                chunk = response.read(8 * 1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > expected_size:
                    raise ValueError(f"MVSEP asset too large: {name}")
                digest.update(chunk)
                output.write(chunk)
        if total != expected_size or digest.hexdigest() != expected_sha:
            raise ValueError(f"MVSEP asset mismatch: {name}")
    archive = pathlib.Path(workdir) / f"{model_id}-{model['revision']}.tar"
    with tarfile.open(archive, "w") as tar:
        tar.add(release_dir / "extras", arcname="extras")
    shutil.rmtree(release_dir, ignore_errors=True)
    return str(archive), s3lite.sha256_file(str(archive))


BEAT_THIS_CHECKPOINT_URL = "https://cloud.cp.jku.at/public.php/dav/files/7ik4RrBKTS273gp/final0.ckpt"
BEAT_THIS_CHECKPOINT_SHA = "8c328b45f59d8dd3dff219253ff6a8d6482be57d0133a29140e2febbf8eb8331"
BEAT_THIS_CHECKPOINT_SIZE = 81058141
BEAT_THIS_COMMIT = "ad7974846029835307ba19a3d5cefbf40b243041"


def build_beat_this_archive(model_id: str, model: Dict[str, Any], workdir: str) -> Tuple[str, str]:
    """Mirror the separately published beat_this checkpoint with exact SHA256."""
    import urllib.request
    if (model_id != "beat-this" or model.get("repository") != "CPJKU/beat_this"
            or model.get("revision") != BEAT_THIS_COMMIT):
        raise ValueError("beat_this repository/revision does not match pinned source")
    work = pathlib.Path(workdir) / "beat-this-release"
    if work.exists():
        shutil.rmtree(work)
    target_dir = work / "extras" / "beat-this"
    target_dir.mkdir(parents=True, exist_ok=True)
    checkpoint = target_dir / "final0.ckpt"
    digest = hashlib.sha256()
    size = 0
    req = urllib.request.Request(BEAT_THIS_CHECKPOINT_URL,
                                 headers={"User-Agent": "audioMONASTRY-weights-mirror/1.0"})
    with urllib.request.urlopen(req, timeout=120) as response, checkpoint.open("wb") as output:
        while True:
            block = response.read(4 * 1024 * 1024)
            if not block:
                break
            size += len(block)
            if size > BEAT_THIS_CHECKPOINT_SIZE:
                raise ValueError("beat_this checkpoint size unexpectedly exceeded")
            digest.update(block)
            output.write(block)
    if size != BEAT_THIS_CHECKPOINT_SIZE or digest.hexdigest() != BEAT_THIS_CHECKPOINT_SHA:
        raise ValueError("beat_this checkpoint digest/size mismatch; do not mirror")
    archive = pathlib.Path(workdir) / f"{model_id}-{model['revision']}.tar"
    with tarfile.open(archive, "w") as tar:
        tar.add(work / "extras", arcname="extras")
    shutil.rmtree(work, ignore_errors=True)
    return str(archive), s3lite.sha256_file(str(archive))


def build_archive(model_id: str, model: Dict[str, Any], workdir: str, token: Optional[str],
                  models: Optional[Dict[str, Dict[str, Any]]] = None) -> Tuple[str, str]:
    """Lädt Modell (+ Extras) in einen frischen HF-Cache und packt ihn als tar. → (Pfad, sha256)."""
    hf_home = os.path.join(workdir, f"hf-{model_id}")
    cache = os.path.join(hf_home, "hub")
    # IMMER frisch: ein wiederverwendeter Cache aus einem abgebrochenen Lauf haelt
    # sonst alte Revisionen und Blobs, und tar.add(cache) packt beide mit
    # (acestep-v15-xl-* waren dadurch 41,4 GB statt 20 GB).
    shutil.rmtree(hf_home, ignore_errors=True)
    os.makedirs(cache, exist_ok=True)
    # Stem checkpoint files are .ckpt: never omit them from the HF mirror.
    # The generic "*.ckpt" ignore was silently producing empty RoFormer caches.
    ignore = [p for p in JUNK_PATTERNS if p != "*.ckpt"] if model.get("task") == "stem.separate" else JUNK_PATTERNS
    if model_id == "mvsep-mega-53":
        return build_mvsep_release_archive(model_id, model, workdir)
    if model_id == "beat-this":
        return build_beat_this_archive(model_id, model, workdir)
    download(model["repository"], model["revision"], cache, token, allow_patterns=None,
             ignore_patterns=ignore)
    for repo, rev in EXTRA_REPOS.get(model_id, []):
        download(repo, rev, cache, token, ignore_patterns=JUNK_PATTERNS)
    for repo, rev, patterns in extra_manifest_downloads(model_id, models or {}):
        download(repo, rev, cache, token, allow_patterns=patterns, ignore_patterns=JUNK_PATTERNS)
    # Zweite Stufe: pytorch_model.bin entfernen, WENN im selben Ordner
    # safetensors liegt (transformers bevorzugt safetensors ohnehin). Modelle,
    # die NUR .bin haben (z. B. laion/larger_clap_music), behalten ihre Datei.
    for root, _dirs, files in os.walk(cache):
        if any(f.endswith(".safetensors") for f in files):
            for fname in files:
                if fname.startswith("pytorch_model") and fname.endswith(".bin"):
                    try:
                        os.remove(os.path.join(root, fname))
                    except OSError:
                        pass
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
    for pod in [*fleet["pods"], *([fleet["visPod"]] if fleet.get("visPod", {}).get("enabled") else [])]:
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
            archive, sha = build_archive(mid, models[mid], workdir, token, models)
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
