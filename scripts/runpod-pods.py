#!/usr/bin/env python3
"""RunPod-Pod-Flotte: planen, Gewichte prüfen, starten, Status, beenden.

Quelle der Flotte: deploy/runpod/pod-fleet.json (7 AI-Pods + visPod; alle 8 Rollen).
Modelle/Revisionen: services/audiomonastry-ai-runtime/model_manifest.json.

Befehle
  plan      Prüft alle acht VRAM-Budgets und das 8,00-€-Gesamtbudget. Kein Netz.
  weights   Prüft, ob alle Gewichte im Speicher (R2) liegen (braucht CFS3_*).
  up        Legt fehlende Pods an (braucht --yes), wartet mit --wait auf "bereit"
            und meldet jede Instanz einzeln, sobald sie fertig geladen ist.
  status    Zeigt laufende Pods der Flotte, Kosten und Bereitschaft.
  down      Beendet alle Pods der Flotte (braucht --yes). Pods speichern nichts:
            Beenden = keine Kosten mehr.

Umgebung
  RP_API_KEY (oder RUNPOD_API_KEY)  RunPod-Schlüssel
  RP_POD_IMAGE                      Image, z. B. ghcr.io/kainplanmusic/audiomonastry-ai-runtime-runpod:<sha>
  AI_POD_TOKEN                      gemeinsames Geheimnis Server ↔ Pods (mind. 32 Zeichen)
  CFS3_* / CFR2_ACCOUNT_ID          R2-Zugang für die Gewichte (wie der Server)
  HF_TOKEN                          nur für gegatete Modelle (pyannote, Stable Audio)

Exit-Codes: 0 ok · 2 Konfiguration · 3 Freigabe fehlt (kein HTTP-Aufruf) · 4 Budget/Bereitschaft
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import re
import sys
import time
import urllib.error
import urllib.request
from typing import Any, Callable, Dict, List, Optional, Tuple

ROOT = pathlib.Path(__file__).resolve().parent.parent
FLEET_PATH = ROOT / "deploy" / "runpod" / "pod-fleet.json"
MANIFEST_PATH = ROOT / "services" / "audiomonastry-ai-runtime" / "model_manifest.json"
API = "https://api.runpod.io/v2"
USABLE_VRAM_GB = 42  # Default fuer 48 GB; echte Limits aus GPU-Pool-Metadaten
POOL_USABLE_VRAM_GB = {"48ada": 42, "48economy": 42, "96pro": 88, "32fast": 27}
REVISION_RE = re.compile(r"^[0-9a-f]{40}$")
# ONLY hard financial guard: total fleet <= 8 EUR/h; never an independent per-GPU USD cap.
ALLOWED_GPU_IDS = ()  # dynamic from fleet budget


def gpu_details(fleet: Dict[str, Any], pod: Dict[str, Any]) -> Dict[str, Any]:
    selected = str(pod.get("gpuPoolId", ""))
    for item in fleet["gpuPools"][pod["gpuPool"]]:
        if item["id"] == selected:
            return item
    raise ConfigError(f"{pod['role']}: GPU {selected!r} fehlt in gpuPools[{pod['gpuPool']}]")


def gross_eur(fleet: Dict[str, Any], usd_per_hour: float) -> float:
    budget = fleet["budget"]
    return (usd_per_hour * float(budget["usdToEur"]) *
            float(budget.get("taxMultiplier", 1.0)) +
            float(budget.get("unbilledEurPerHourReserve", 0.0)))


def guard_gpu_ids(fleet: Dict[str, Any], pod: Dict[str, Any]) -> List[str]:
    pool = fleet["gpuPools"][pod["gpuPool"]]
    allow = set(fleet["budget"]["allowedGpus"])
    if not pool:
        raise ConfigError(f"{pod['role']}: GPU-Pool leer")
    for entry in pool:
        gpu_id = str(entry.get("id", ""))
        price = float(entry.get("usdPerHour", 0))
        if gpu_id not in allow or price <= 0:
            raise ConfigError(f"{pod['role']}: GPU {gpu_id!r} nicht erlaubt oder Preis ungueltig")
        if int(entry.get("vramGb", 0)) < 24:
            raise ConfigError(f"{pod['role']}: GPU {gpu_id!r} unter 24 GB")
    gpu_details(fleet, pod)
    return [gpu["id"] for gpu in pool]



sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import s3lite  # noqa: E402


def _http(method: str, url: str, headers: Dict[str, str], body: Optional[bytes], timeout: float) -> Tuple[int, bytes]:
    req = urllib.request.Request(url, data=body, method=method, headers=headers)
    # Browser-UA ist Pflicht: ohne ihn beantwortet Cloudflare die REST-API mit HTTP 403
    # (gleiche Falle wie in runpod-warm.py / runpod-deploy.py, dort dokumentiert).
    if not any(h.lower() == "user-agent" for h in req.headers):
        req.add_header("User-Agent", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read() if exc.fp else b""
    except (urllib.error.URLError, TimeoutError, OSError):
        return 0, b""


#: Einziger Netzwerkzugang – Tests ersetzen ihn.
transport: Callable[[str, str, Dict[str, str], Optional[bytes], float], Tuple[int, bytes]] = _http
sleep: Callable[[float], None] = time.sleep


class ConfigError(Exception):
    pass


# --------------------------------------------------------------------------- Laden
def load_fleet() -> Dict[str, Any]:
    return json.loads(FLEET_PATH.read_text(encoding="utf-8"))


def load_models() -> Dict[str, Dict[str, Any]]:
    data = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    return {m["id"]: m for m in data["models"]}


# --------------------------------------------------------------------------- Planung
def plan(fleet: Dict[str, Any], models: Dict[str, Dict[str, Any]]) -> Dict[str, Any]:
    """Exakt 8 GPU-Rollen; Preflight ist nur eine SCHÄTZUNG, keine GPU-Freigabe."""
    specs = list(fleet["pods"])
    if fleet.get("visPod", {}).get("enabled"):
        specs.append(fleet["visPod"])
    problems: List[str] = []
    rows: List[Dict[str, Any]] = []
    usd_hour = 0.0
    if len(specs) != 8 or len(set(p["role"] for p in specs)) != 8:
        problems.append("Flotte muss exakt acht unterschiedliche Rollen enthalten")
    for pod in sorted(specs, key=lambda x: x.get("startOrder", 99)):
        try:
            guard_gpu_ids(fleet, pod)
            gpu = gpu_details(fleet, pod)
        except (ConfigError, KeyError, ValueError) as exc:
            problems.append(str(exc))
            continue
        unknown = [id_ for id_ in pod.get("models", []) if id_ not in models]
        if unknown:
            problems.append(f"{pod['role']}: unbekannte Modelle {unknown}")
            continue
        model_gb = sum(float(models[mid].get("estimatedVRAM", 0)) for mid in pod["models"])
        reserve_gb = float(pod.get("vramReserveGb", 0))
        if pod["role"] == "vis":
            reserve_gb += float(pod.get("estimatedVRAM", 0))
        vram = model_gb + reserve_gb
        margin = float(pod.get("vramSafetyMarginGb", 6))
        capacity = float(gpu["vramGb"])
        if vram > capacity - margin:
            problems.append(f"{pod['role']}: Planlast {vram:g} GB > Limit {capacity-margin:g} GB")
        price = float(gpu["usdPerHour"])
        usd_hour += price
        rows.append({"role":pod["role"],"aiRole":pod["aiRole"],"models":pod["models"],
                     "vramGb":vram,"gpuMemoryGb":capacity,"marginGb":margin,
                     "gpus":[p["id"] for p in fleet["gpuPools"][pod["gpuPool"]]],
                     "eurPerHourMax":round(price*float(fleet["budget"]["usdToEur"]),3),
                     "trigger":pod.get("startTrigger","always")})
    gross = gross_eur(fleet, usd_hour)
    maximum = float(fleet["budget"]["maxEurPerHour"])
    if gross > maximum:
        problems.append(f"Gesamtkosten inkl. Steuer/Puffer {gross:.2f} €/h > {maximum:.2f} €/h")
    vis = next((r for r in rows if r["role"] == "vis"), None)
    return {"pods":[r for r in rows if r["role"]!="vis"],
            "visEurPerHour":vis["eurPerHourMax"] if vis else 0.0,
            "visVramGb":vis["vramGb"] if vis else 0.0,
            "eurPerHourMax":round(gross,3),"eurPerHourAlways":round(gross,3),
            "budgetEurPerHour":maximum,"problems":problems,
            "usdPerHour":round(usd_hour,3),"grossIncludesTaxAndReserve":True}


def print_plan(p: Dict[str, Any]) -> None:
    print(f"{'Rolle':12} {'AI_ROLE':20} {'VRAM':>6}  {'max €/h':>7}  {'Trigger':10} Modelle")
    for r in p["pods"]:
        print(f"{r['role']:12} {r['aiRole']:20} {r['vramGb']:5.0f}G  {r['eurPerHourMax']:7.2f}  {r.get('trigger','?'):10} {', '.join(r['models'])}")
    if p["visEurPerHour"]:
        print(f"{'vis':12} {'(Visuals)':20} {p['visVramGb']:5.0f}G  {p['visEurPerHour']:7.2f}")
    print(f"Summe alle Pods (worst case): {p['eurPerHourMax']:.2f} €/h · davon dauerhaft (always): {p['eurPerHourAlways']:.2f} €/h (Budget {p['budgetEurPerHour']:.2f} €/h)")
    for prob in p["problems"]:
        print(f"PROBLEM: {prob}")


# --------------------------------------------------------------------------- Gewichte
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


# --------------------------------------------------------------------------- RunPod
def api_key() -> str:
    return (os.environ.get("RP_API_KEY") or os.environ.get("RUNPOD_API_KEY") or os.environ.get("RP_AGENT_KEY") or "").strip()


def api(method: str, path: str, body: Optional[Dict[str, Any]] = None, timeout: float = 60) -> Tuple[int, Any]:
    key = api_key()
    if not key:
        raise ConfigError("RP_API_KEY fehlt")
    data = json.dumps(body).encode() if body is not None else None
    status, raw = transport(method, f"{API}{path}", {"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
                            data, timeout)
    try:
        parsed = json.loads(raw.decode() or "null")
    except ValueError:
        parsed = raw.decode(errors="replace")
    return status, parsed


def fleet_pods(fleet: Dict[str, Any]) -> List[Dict[str, Any]]:
    status, data = api("GET", "/pods")
    if status != 200:
        raise ConfigError(f"Pod-Liste nicht lesbar (HTTP {status})")
    # API v2 gibt {"pods": [...], "pagination": {...}} zurück
    pods = data.get("pods", []) if isinstance(data, dict) else data
    if not isinstance(pods, list):
        pods = []
    prefix = fleet["namePrefix"]
    return [p for p in pods if str(p.get("name", "")).startswith(prefix)]


def pod_body(fleet: Dict[str, Any], pod: Dict[str, Any], image: str, token: str,
             entries: List[Dict[str, Any]]) -> Dict[str, Any]:
    env = {
        "AI_ROLE": pod["aiRole"],
        "AI_ROLE_MODELS": ",".join(pod["models"]),
        "AI_RESIDENT_ONLY": "1",
        "AI_VERIFY_MODEL_STARTUP": "1",
        "AI_POD_TOKEN": token,
        "AI_WEIGHTS_URLS": json.dumps(entries, separators=(",", ":")),
        "AI_RUNTIME_DEVICE": "cuda",
        # INFRA-RUNPOD-020: volumeInGb=0 -> /workspace ist NICHT beschreibbar
        # (RunPod mountet es ro); die Gewichte-Phase starb im Restart-Loop mit
        # PermissionError. /tmp liegt auf der Container-Disk (120 GB) und ist
        # ephemeral - genau richtig fuer Presigned-URL-Downloads (neue TTL je up).
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
        "cloud": str(fleet.get("cloudType", "SECURE")).upper(),
        "env": env,
        "ports": [f"{fleet['port']}/http"],
    }
    # Privates GHCR-Image: Registry-Credential binden. RunPod-v3-API nennt das
    # Feld `registry` (Credential-ID, kein Login-Paar). `containerRegistryAuthId`
    # wird mit HTTP 422 "additional properties not allowed" abgelehnt (live
    # gemessen 2026-11-07). Der Key darf nur GESETZT erscheinen, wenn ein Wert da ist.
    rid = os.environ.get("RP_REGISTRY_AUTH_ID", "").strip()
    if rid:
        body["registry"] = rid
    if pod.get("minCudaVersion"):
        body["gpu"]["minCudaVersion"] = pod["minCudaVersion"]
    return body


def proxy_url(pod_id: str, port: int) -> str:
    return f"https://{pod_id}-{port}.proxy.runpod.net"


def ready(pod_id: str, port: int, token: str) -> Tuple[bool, str]:
    status, raw = transport("GET", f"{proxy_url(pod_id, port)}/ready", {"Authorization": f"Bearer {token}"}, None, 15)
    if status == 200:
        return True, "ready"
    try:
        detail = json.loads(raw.decode() or "{}").get("status", "")
    except ValueError:
        detail = ""
    return False, detail or (f"HTTP {status}" if status else "nicht erreichbar")


def wait_ready(pods: Dict[str, str], port: int, token: str, timeout_s: float, interval_s: float = 15) -> Dict[str, bool]:
    """Wartet, bis jede Instanz bereit ist; meldet jede einzeln, sobald sie es ist."""
    done: Dict[str, bool] = {role: False for role in pods}
    deadline = time.time() + timeout_s
    while time.time() < deadline and not all(done.values()):
        for role, pod_id in pods.items():
            if done[role]:
                continue
            ok, detail = ready(pod_id, port, token)
            if ok:
                done[role] = True
                print(f"  ✔ {role} bereit ({proxy_url(pod_id, port)})", flush=True)
            elif detail == "failed":
                print(f"  ✖ {role}: Modelle konnten nicht geladen werden (GET /ready zeigt die Gründe)", flush=True)
                return done
        if not all(done.values()):
            sleep(interval_s)
    return done


# --------------------------------------------------------------------------- Befehle
def require(name: str, min_len: int = 1) -> str:
    value = os.environ.get(name, "").strip()
    if len(value) < min_len:
        raise ConfigError(f"{name} fehlt" + (f" oder ist kürzer als {min_len} Zeichen" if min_len > 1 else ""))
    return value


def resolve_image(fleet: Dict[str, Any], pod: Dict[str, Any]) -> str:
    """Role-specific profiles must never inherit an incompatible common image."""
    owner = pod if pod.get("imageEnv") else fleet
    name = owner["imageEnv"]
    value = os.environ.get(name, "").strip() or owner.get("image", "")
    if not value:
        raise ConfigError(f"{name} fehlt")
    return value


def live_fleet_cost() -> Dict[str, Any]:
    import importlib.util
    spec = importlib.util.spec_from_file_location("runpod_fleet_cost", ROOT / "scripts/runpod-fleet-probe.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    state = module.probe()
    if not state.get("budgetVerified"):
        raise ConfigError("Whole-account compute cost unavailable")
    return state


def cmd_up(args: argparse.Namespace, fleet: Dict[str, Any], models: Dict[str, Dict[str, Any]]) -> int:
    p = plan(fleet, models)
    print_plan(p)
    if p["problems"]:
        return 4
    requested_roles = set(args.only.split(",")) if args.only else None
    vis_selected = fleet.get("visPod", {}).get("enabled") and (requested_roles is None or "vis" in requested_roles)
    if vis_selected and os.environ.get("RP_VIS_AI_IMAGE_READY", "") != "1":
        print("BLOCKED: vis requires verified Chromium/NVENC + UniverSR/DeReverb image (RP_VIS_AI_IMAGE_READY=1).")
        return 4
    token = require("AI_POD_TOKEN", 32)
    if not api_key():
        raise ConfigError("RP_API_KEY fehlt")
    if not args.yes:
        print("Ohne --yes wird nichts gestartet (kein HTTP-Aufruf). Pods kosten ab Start.")
        return 3
    target = s3lite.S3Target.from_r2_env()
    prefix, ttl = fleet["weights"]["prefix"], int(fleet["weights"]["urlTtlSeconds"])
    roles = set(args.only.split(",")) if args.only else None
    existing = {p["name"]: p for p in fleet_pods(fleet) if p.get("desiredStatus") != "TERMINATED"}
    started: Dict[str, str] = {}
    # Alle Pods inkl. visPod (wenn enabled), sortiert nach startOrder.
    all_pods = list(fleet["pods"])
    vis = fleet.get("visPod") or {}
    if vis.get("enabled"):
        all_pods.append({**vis, "startOrder": 99, "env": {}})
    for pod in sorted(all_pods, key=lambda x: x.get("startOrder", 99)):
        if roles and pod["role"] not in roles:
            continue
        name = f"{fleet['namePrefix']}{pod['role']}"
        if name in existing:
            started[pod["role"]] = existing[name]["id"]
            print(f"= {pod['role']}: läuft schon ({existing[name]['id']})")
            continue
        entries, missing = weight_entries(pod, models, target, prefix, ttl)
        if missing:
            print(f"✖ {pod['role']}: Gewichte fehlen im Speicher: {', '.join(missing)} → scripts/weights-mirror.py")
            return 4
        # Fail closed on current whole-fleet spend, BEFORE creating a billable GPU.
        whole_account = live_fleet_cost()
        current_usd = float(whole_account["existingComputeUsdPerHour"])
        status, catalog = api("GET", "/catalog/gpus?include=AVAILABILITY&product=POD")
        if status != 200:
            raise ConfigError("Live Pod GPU quote unavailable")
        gpu = next((item for item in catalog.get("gpus", []) if item["id"] == pod["gpuPoolId"]), None)
        cloud = str(fleet.get("cloudType", "SECURE")).lower()
        estimate_usd = float((gpu or {}).get("price", {}).get(cloud, 0))
        if estimate_usd <= 0:
            raise ConfigError("Selected GPU has no live price quote")
        projected_eur = gross_eur(fleet, current_usd + estimate_usd)
        if projected_eur > float(fleet["budget"]["maxEurPerHour"]):
            print(f"BLOCKED: projected whole-fleet cost {projected_eur:.2f} EUR/h > 8 EUR/h")
            return 4
        pod_image = resolve_image(fleet, pod)
        status, data = api("POST", "/pods", pod_body(fleet, pod, pod_image, token, entries))
        if status not in (200, 201) or not isinstance(data, dict) or not data.get("id"):
            print(f"✖ {pod['role']}: Anlegen fehlgeschlagen (HTTP {status}) {str(data)[:300]}")
            return 4
        started[pod["role"]] = data["id"]
        print(f"+ {pod['role']}: angelegt {data['id']} ({data.get('cost', '?')} $/h)")
    # Ist-Kosten gegen das Budget (GPU-Wahl kann vom Plan abweichen).
    running = [p for p in fleet_pods(fleet) if p.get("desiredStatus") != "TERMINATED"]
    # No individual GPU price cap; the fleet total below is the only cost limit.
    actual = float(live_fleet_cost()["existingComputeUsdPerHour"])
    actual_eur = gross_eur(fleet, actual)
    print(f"Ist-Kosten: {actual:.2f} $/h ≈ {actual_eur:.2f} €/h inkl. USt-/Puffer-Annahme")
    if actual_eur > float(fleet["budget"]["maxEurPerHour"]):
        print("✖ Budget überschritten – Flotte wird beendet.")
        cmd_down(argparse.Namespace(yes=True), fleet)
        return 4
    print("\nFür den Server (.env):")
    for role, pod_id in started.items():
        print(f"RP_POD_ID_{role.upper().replace('-', '_')}={pod_id}")
    if args.wait:
        print(f"\nWarte auf Bereitschaft (höchstens {args.wait} s):")
        done = wait_ready(started, int(fleet["port"]), token, float(args.wait))
        if not all(done.values()):
            print("✖ Nicht alle Instanzen bereit: " + ", ".join(r for r, ok in done.items() if not ok))
            return 4
    return 0


def cmd_status(fleet: Dict[str, Any], as_json: bool = False) -> int:
    pods = fleet_pods(fleet)
    token = os.environ.get("AI_POD_TOKEN", "").strip()
    total = 0.0
    rows: List[Dict[str, Any]] = []
    for p in sorted(pods, key=lambda x: x.get("name", "")):
        cost = float(p.get("cost") or 0)
        total += cost
        ok, state = ready(p["id"], int(fleet["port"]), token) if token else (False, "?")
        rows.append({"name": p.get("name", ""), "id": p["id"],
                     "desiredStatus": p.get("desiredStatus", ""),
                     "cost": cost, "ready": ok, "state": state})
    if as_json:
        print(json.dumps({"pods": rows, "totalUsdPerHour": total,
                          "totalEurPerHour": gross_eur(fleet, total)},
                         ensure_ascii=False))
        return 0
    for r in rows:
        print(f"{r['name']:32} {r['id']:16} {r['desiredStatus']:10} {r['cost']} $/h  {r['state']}")
    print(f"Summe {total:.2f} $/h ≈ {gross_eur(fleet, total):.2f} €/h, {len(pods)} Pods")
    return 0


def cmd_down(args: argparse.Namespace, fleet: Dict[str, Any]) -> int:
    pods = [p for p in fleet_pods(fleet) if p.get("desiredStatus") != "TERMINATED"]
    if not pods:
        print("Keine Pods der Flotte aktiv.")
        return 0
    if not args.yes:
        print(f"{len(pods)} Pods würden beendet: {', '.join(p['name'] for p in pods)}. Ohne --yes passiert nichts.")
        return 3
    failed = 0
    for p in pods:
        status, _ = api("DELETE", f"/pods/{p['id']}")
        ok = status in (200, 202, 204)
        failed += 0 if ok else 1
        print(f"{'-' if ok else '✖'} {p['name']} ({p['id']}) {'beendet' if ok else f'HTTP {status}'}")
    return 0 if not failed else 4


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


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("plan")
    sub.add_parser("weights")
    up = sub.add_parser("up")
    up.add_argument("--yes", action="store_true", help="wirklich starten (kostet ab Start)")
    up.add_argument("--wait", type=int, default=0, help="Sekunden auf Bereitschaft warten (z. B. 900)")
    up.add_argument("--only", default="", help="nur diese Rollen, z. B. brain")
    status_p = sub.add_parser("status")
    status_p.add_argument("--json", action="store_true", dest="as_json")
    down = sub.add_parser("down")
    down.add_argument("--yes", action="store_true")
    args = parser.parse_args(argv)
    fleet, models = load_fleet(), load_models()
    # Static source-of-truth gate blocks cost-bearing up operations on manifest drift.
    if args.cmd in ("up", "weights", "plan"):
        from importlib.util import module_from_spec, spec_from_file_location
        gate_path = ROOT / "scripts" / "runpod-ssot-preflight.py"
        gate_spec = spec_from_file_location("runpod_ssot_preflight", gate_path)
        if gate_spec is None or gate_spec.loader is None:
            print("BLOCKED: SSOT preflight cannot be loaded", file=sys.stderr)
            return 4
        gate = module_from_spec(gate_spec)
        gate_spec.loader.exec_module(gate)
        report = gate.check(fleet, json.loads(MANIFEST_PATH.read_text(encoding="utf-8")))
        if report["errors"]:
            for issue in report["errors"]:
                print("BLOCKED SSOT:", issue, file=sys.stderr)
            return 4
    try:
        if args.cmd == "plan":
            p = plan(fleet, models)
            print_plan(p)
            return 4 if p["problems"] else 0
        if args.cmd == "weights":
            return cmd_weights(fleet, models)
        if args.cmd == "up":
            return cmd_up(args, fleet, models)
        if args.cmd == "status":
            return cmd_status(fleet, as_json=getattr(args, "as_json", False))
        if args.cmd == "down":
            return cmd_down(args, fleet)
    except ConfigError as exc:
        print(f"Konfiguration: {exc}", file=sys.stderr)
        return 2
    return 2


if __name__ == "__main__":
    sys.exit(main())
