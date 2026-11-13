"""Vast fleet module – gemeinsame Flotten- und Modell-Helfer der Vast-Skripte.

Genutzt von scripts/vast-pods.py, scripts/vast-fleet-plan.py und
scripts/weights-mirror.py. Quelle der Wahrheit:
  * Flotte:   deploy/gpu/pod-fleet.json (acht Rollen)
  * Modelle:  services/audiomonastry-ai-runtime/model_manifest.json
              (gepinnte Revisionen, 40-stellige Commit-Hashes)

Herkunft: die providerunabhängigen Helfer des früheren scripts/runpod-pods.py
(bis 285ef5c) – Laden von Flotte/Manifest, Gewichte-Einträge mit
Presigned-URLs, Pod-Umgebung, Pflicht-Variablen. Die RunPod-API-Teile
(Pod anlegen/listen/löschen über api.runpod.io) sind entfallen; das macht
scripts/vast-pods.py über die Vast-API.
"""
from __future__ import annotations

import json
import os
import pathlib
import re
import sys
from typing import Any, Dict, List, Optional, Tuple

ROOT = pathlib.Path(__file__).resolve().parent.parent
FLEET_PATH = ROOT / "deploy" / "gpu" / "pod-fleet.json"
MANIFEST_PATH = ROOT / "services" / "audiomonastry-ai-runtime" / "model_manifest.json"
REVISION_RE = re.compile(r"^[0-9a-f]{40}$")

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import s3lite  # noqa: E402


class ConfigError(Exception):
    pass


def load_fleet() -> Dict[str, Any]:
    return json.loads(FLEET_PATH.read_text(encoding="utf-8"))


def load_models() -> Dict[str, Dict[str, Any]]:
    data = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    return {m["id"]: m for m in data["models"]}


def weight_key(prefix: str, model_id: str, revision: str) -> str:
    return f"{prefix}/{model_id}/{revision}.tar"


def manifest_key(prefix: str, model_id: str, revision: str) -> str:
    """Manifest des Edge-Spiegels (workers/weights-mirror.js): dateiweise Gewichte."""
    return f"{prefix}/{model_id}/{revision}/_manifest.json"


def manifest_entries(target: "s3lite.S3Target", prefix: str, model_id: str, revision: str,
                     ttl: int, repo: str = "", required_files: Optional[List[Dict[str, Any]]] = None) -> Optional[List[Dict[str, Any]]]:
    """Dateiweise presigned Eintraege aus dem Manifest des Edge-Spiegels.

    Liefert `None`, wenn kein Manifest liegt - dann bleibt der TAR-Weg gueltig.
    Jeder Eintrag traegt zusaetzlich Repo und Commit, damit der Pod die Datei ins
    HF-Cache-Layout legen kann (pod_start.place_file).
    """
    raw = target.get_bytes(manifest_key(prefix, model_id, revision))
    if raw is None:
        return None
    try:
        doc = json.loads(raw.decode())
    except ValueError:
        return None
    files = doc.get("files") if isinstance(doc, dict) else None
    if not isinstance(files, list) or not files:
        return None
    if doc.get("revision") != revision or (repo and doc.get("repo") != repo):
        return None
    indexed = {item.get("path"): item for item in files if isinstance(item, dict)}
    for required in required_files or []:
        item = indexed.get(required["path"])
        if not item or int(item.get("size") or 0) != int(required["size"]):
            return None
    repo_id = str(doc.get("repo") or repo or "")
    if not repo_id:
        return None
    entries = []
    for item in files:
        path = str(item.get("path") or "")
        sha = str(item.get("sha256") or "")
        if not path or not sha:
            continue
        entries.append({
            "path": path,
            "url": target.presign("GET", f"{prefix}/{model_id}/{revision}/{path}", ttl),
            "sha256": sha,
            "size": int(item.get("size") or 0),
            "repo": repo_id,
            "commit": revision,
        })
    return entries or None


def weights_present(target: "s3lite.S3Target", prefix: str, model_id: str, revision: str) -> bool:
    """Liegen die Gewichte im Speicher - als TAR oder dateiweise (Edge-Spiegel)?"""
    if target.head(weight_key(prefix, model_id, revision)) is not None:
        return True
    return target.head(manifest_key(prefix, model_id, revision)) is not None


def models_with_weights(pod: Dict[str, Any], models: Dict[str, Dict[str, Any]]) -> List[Tuple[str, str]]:
    """(id, revision) aller Modelle mit gepinnter Revision.

    Modelle mit `directRepo: true` fallen raus: ihre Gewichte werden beim Pod-Start
    direkt von HuggingFace geladen (Betreiber-Entscheid 2026-11-08, R2 nicht zumuellen).
    essentia u. ae. ohne Gewichte fallen ebenfalls raus.
    """
    out = []
    for mid in pod["models"]:
        m = models[mid]
        if m.get("directRepo"):
            continue
        rev = str(m.get("revision", ""))
        if REVISION_RE.fullmatch(rev):
            out.append((mid, rev))
    return out


def weight_entries(pod: Dict[str, Any], models: Dict[str, Dict[str, Any]], target: "s3lite.S3Target",
                   prefix: str, ttl: int) -> Tuple[List[Dict[str, Any]], List[str]]:
    """Presigned-Einträge für AI_WEIGHTS_URLS und Liste fehlender Archive.

    Zwei Wege, in dieser Reihenfolge:
    1. Manifest des Edge-Spiegels (dateiweise, ohne TAR) - `weights/<modell>/<rev>/_manifest.json`.
    2. TAR + `.sha256`-Sidecar (der bisherige Weg von scripts/weights-mirror.py).
    """
    entries, missing = [], []
    for mid, rev in models_with_weights(pod, models):
        per_file = manifest_entries(target, prefix, mid, rev, ttl, str(models[mid].get("repository", "")),
                                    models[mid].get("requiredWeightFiles"))
        if per_file is not None:
            entries.extend(per_file)
            continue
        key = weight_key(prefix, mid, rev)
        meta = target.head(key)
        sha = target.get_bytes(key[:-4] + ".sha256")
        if meta is None or sha is None:
            missing.append(key)
            continue
        entries.append({"name": f"{mid.replace('/', '_')}-{rev[:12]}.tar", "url": target.presign("GET", key, ttl),
                        "sha256": sha.decode().split()[0], "size": int(meta.get("content-length", "0") or 0)})
    # Auxiliary checkpoints use the same pinned lock as startup/loaders. Pods
    # receive short-lived URLs, never the R2 credentials. Missing optional
    # mirrors retain the already implemented pinned upstream startup path.
    asset_lock = json.loads((ROOT / "services/audiomonastry-ai-runtime/weight_assets.lock.json").read_text())["models"]
    asset_ids = []
    for mid in pod["models"]:
        asset_ids.extend([mid, *models[mid].get("weightComponents", [])])
    for asset_id in dict.fromkeys(asset_ids):
        asset = asset_lock.get(asset_id)
        if not asset or asset.get("package"):
            continue
        for item in asset["files"]:
            key = f"{prefix}/{asset_id}/{asset['revision']}/{item['path']}"
            meta = target.head(key)
            if meta and int(meta.get("content-length") or 0) == item["size"]:
                entries.append({"dest": f"/data/weights/{asset_id}/{item['path']}",
                                "url": target.presign("GET", key, ttl),
                                "sha256": item["sha256"], "size": item["size"]})
    return entries, missing


def pod_body(fleet: Dict[str, Any], pod: Dict[str, Any], image: str, token: str,
             entries: List[Dict[str, Any]]) -> Dict[str, Any]:
    env = {
        "AI_ROLE": pod["aiRole"],
        "AI_ROLE_MODELS": ",".join(pod["models"]),
        "AI_RESIDENT_ONLY": "1",
        "AI_VERIFY_MODEL_STARTUP": "1",
        "HOME": "/data/home",
        "XDG_CACHE_HOME": "/data/cache",
        "TRITON_CACHE_DIR": "/data/triton-cache",
        "TORCHINDUCTOR_CACHE_DIR": "/data/torchinductor-cache",
        "AI_POD_TOKEN": token,
        "AI_WEIGHTS_URLS": json.dumps(entries, separators=(",", ":")),
        "AI_RUNTIME_DEVICE": "cuda",
        # /tmp liegt auf der Container-Disk und ist ephemeral - genau richtig
        # fuer Presigned-URL-Downloads (neue TTL je up). vast-pods.py legt
        # HF_HOME/AI_WEIGHTS_TMP auf /data um.
        "HF_HOME": "/tmp/hf-cache",
        "AI_WEIGHTS_TMP": "/tmp/weights-tmp",
        "PORT": str(fleet["port"]),
        **pod.get("env", {}),
    }
    for name in pod.get("secretEnv", []):
        value = os.environ.get(name, "").strip()
        if value:
            env[name] = value
    body: Dict[str, Any] = {
        "name": f"{fleet['namePrefix']}{pod['role']}",
        "image": image,
        "entrypoint": ["python", "-u", "pod_start.py"],
        "cmd": [],
        "gpu": {"id": pod["gpuPoolId"], "count": 1},
        "disk": pod["containerDiskGb"],
        "cloud": str(pod.get("cloudType", fleet.get("cloudType", "SECURE"))).upper(),
        "env": env,
        "ports": [f"{fleet['port']}/http"],
    }
    if pod.get("dataCenterIds"):
        body["dataCenterIds"] = pod["dataCenterIds"]
    for field in ("minCudaVersion", "minRamPerGpu", "minVcpuCountPerGpu"):
        if pod.get(field):
            body["gpu"][field] = pod[field]
    return body


def require(name: str, min_len: int = 1) -> str:
    value = os.environ.get(name, "").strip()
    if len(value) < min_len:
        raise ConfigError(f"{name} fehlt" + (f" oder ist kürzer als {min_len} Zeichen" if min_len > 1 else ""))
    return value


def resolve_image(fleet: Dict[str, Any], pod: Dict[str, Any]) -> str:
    """Role-specific profiles must never inherit an incompatible common image."""
    gpu_env = pod.get("gpuImageEnv", {}).get(pod.get("gpuPoolId"))
    if gpu_env:
        value = os.environ.get(gpu_env, "").strip()
        if not value:
            raise ConfigError(gpu_env + " required for selected GPU architecture")
        return value
    owner = pod if pod.get("imageEnv") else fleet
    name = owner["imageEnv"]
    value = os.environ.get(name, "").strip() or owner.get("image", "")
    if not value:
        raise ConfigError(f"{name} fehlt")
    return value


def cmd_weights(fleet: Dict[str, Any], models: Dict[str, Dict[str, Any]]) -> int:
    target = s3lite.S3Target.from_r2_env()
    prefix = fleet["weights"]["prefix"]
    missing_total = 0
    all_pods = [*fleet["pods"], *([fleet["visPod"]] if fleet.get("visPod", {}).get("enabled") else [])]
    for pod in all_pods:
        entries, missing = weight_entries(pod, models, target, prefix, 3600)
        missing_total += len(missing)
        print(f"{'✔' if not missing else '✖'} {pod['role']:11} R2-Downloadplan: {len(entries)} Eintraege; {len(missing)} Pflichtbestaende fehlen")
        for key in missing:
            print(f"  fehlt: {key}")
        direct = [mid for mid in pod["models"] if models[mid].get("directRepo")]
        if direct:
            print(f"  direkter Upstream/Paket: {', '.join(direct)} (durch diesen R2-Check nicht bestaetigt)")
    print("R2-Pflichtbestaende im Downloadplan vorhanden; keine vollstaendige Hash-/GPU-Pruefung." if not missing_total else f"{missing_total} Pflichtbestaende fehlen → scripts/weights-mirror.py oder Edge-Spiegel (workers/weights-mirror.js)")
    return 0 if not missing_total else 4


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "fleet":
        print(json.dumps(load_fleet(), indent=2))
    elif len(sys.argv) > 1 and sys.argv[1] == "models":
        print(json.dumps(load_models(), indent=2))
    elif len(sys.argv) > 1 and sys.argv[1] == "weights":
        sys.exit(cmd_weights(load_fleet(), load_models()))
    else:
        print(json.dumps({"fleet": load_fleet(), "models": load_models()}, indent=2))
