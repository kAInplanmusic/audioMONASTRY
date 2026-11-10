#!/usr/bin/env python3
"""RunPod-Pod-Flotte: planen, Gewichte prüfen, starten, Status, beenden.

Quelle der Flotte: deploy/runpod/pod-fleet.json (7 AI-Pods + 1 visPod, 24/48/80/96-GB GPUs).
Modelle/Revisionen: services/audiomonastry-ai-runtime/model_manifest.json.

Befehle
  plan      Rechnet Belegung (VRAM je Pod) und Kosten, prüft das 7,50-€-Budget. Kein Netz.
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
USABLE_VRAM_GB = 42
POOL_USABLE_VRAM_GB = {"ada24": 18, "ada48": 42, "a40": 42, "blackwell96": 88}
REVISION_RE = re.compile(r"^[0-9a-f]{40}$")
MAX_USD_PER_HOUR = 2.5


def _gpu_capacity(gpu_id: str) -> int:
    if "Blackwell" in gpu_id or "96GB" in gpu_id:
        return 96
    if "80GB" in gpu_id:
        return 80
    if "5090" in gpu_id:
        return 32
    if "4090" in gpu_id:
        return 24
    return 48


def guard_gpu_ids(fleet: Dict[str, Any], pod: Dict[str, Any]) -> List[str]:
    pool = fleet["gpuPools"].get(pod["gpuPool"], [])
    allowed = set(fleet["budget"].get("allowedGpus", []))
    choices = [pod["gpuPoolId"]] + list(pod.get("gpuFallbackIds", []))
    max_hour = min(MAX_USD_PER_HOUR, float(fleet["budget"].get("maxUsdPerHourPerInstance", MAX_USD_PER_HOUR)))
    if not pool or len(choices) != len(set(choices)):
        raise ConfigError("invalid GPU pool or duplicate fallbacks")
    approved = []
    for gpu_id in choices:
        match = next((x for x in pool if x["id"] == gpu_id), None)
        if not match or gpu_id not in allowed or not 0 < float(match["usdPerHour"]) <= max_hour:
            raise ConfigError("GPU is not allowed or exceeds hourly cap: " + gpu_id)
        if _gpu_capacity(gpu_id) - float(pod.get("vramSafetyMarginGb", 6)) < float(pod.get("_computedVram", 0)):
            continue
        approved.append(gpu_id)
    if not approved:
        raise ConfigError("no GPU fits model budget: " + pod["role"])
    return approved


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
    """Belegung und Kosten – rein, ohne Netz."""
    rows = []
    usd_to_eur = float(fleet["budget"]["usdToEur"])
    worst_total = 0.0          # Summe aller Pods (worst case)
    worst_always = 0.0         # nur startTrigger=always -> zaehlt fuers Budget
    problems: List[str] = []
    vat = float(fleet["budget"].get("vatMultiplier", 1.0))
    for pod in sorted(fleet["pods"], key=lambda p: p["startOrder"]):
        unknown = [m for m in pod["models"] if m not in models]
        if unknown:
            problems.append(f"{pod['role']}: unbekannte Modelle {unknown}")
            continue
        vram = sum(float(models[m].get("estimatedVRAM", 0)) for m in pod["models"]) + float(pod.get("vramReserveGb", 0))
        # Marge je Pod (pod-fleet.json.vramSafetyMarginGb) oder Pool-Standard:
        # 48-GB-Karten 6 GB, 24-GB-Karten 6 GB. Ein Pod darf sie bewusst senken
        # (audio-brain: 44 GB von 48 GB, sonst passt Qwen3-Omni + Music Flamingo nicht).
        pool_vram = _gpu_capacity(str(pod["gpuPoolId"]))
        margin = float(pod.get("vramSafetyMarginGb", 6))
        pool_limit = pool_vram - margin
        if vram > pool_limit:
            problems.append(f"{pod['role']}: {vram:.0f} GB > {pool_limit:.0f} GB nutzbar ({pod['gpuPool']}, Marge {margin:.0f})")
        try:
            guard_gpu_ids(fleet, {**pod, "_computedVram": vram})
        except ConfigError as exc:
            problems.append(str(exc))
        pool = fleet["gpuPools"][pod["gpuPool"]]
        # Preis der TATSAECHLICHEN GPU (gpuPoolId) nehmen, nicht das teuerste
        # Pool-Mitglied: sonst rechnete der Plan 1,00 $/h (PRO-6000) statt
        # 0,35 $/h (A40) und zeigte ein Vielfaches der echten Kosten.
        gpu_id = str(pod.get("gpuPoolId", ""))
        match = next((g for g in pool if g["id"] == gpu_id), None)
        unit_usd = float(match["usdPerHour"]) if match else max(g["usdPerHour"] for g in pool)
        worst = unit_usd * usd_to_eur * vat
        worst_total += worst
        if pod.get("startTrigger") == "always":
            worst_always += worst
        rows.append({"role": pod["role"], "aiRole": pod["aiRole"], "models": pod["models"], "vramGb": vram,
                     "gpus": [g["id"] for g in pool], "eurPerHourMax": round(worst, 3),
                     "trigger": pod.get("startTrigger", "?")})
    vis = fleet.get("visPod") or {}
    vis_eur = 0.0
    if vis.get("enabled"):
        vis_pool = fleet["gpuPools"][vis["gpuPool"]]
        vis_match = next((g for g in vis_pool if g["id"] == vis.get("gpuPoolId", "")), None)
        vis_usd = float(vis_match["usdPerHour"]) if vis_match else max(g["usdPerHour"] for g in vis_pool)
        vis_eur = vis_usd * usd_to_eur * vat
        # Der Player ist kein AI-Modell, braucht aber VRAM (Headless-Chromium +
        # WebGL/WebGPU + NVENC). Ohne Schaetzung zeigte der Plan 0 GB.
        vis_ids = vis.get("models", [])
        unknown_vis = [mid for mid in vis_ids if mid not in models]
        if unknown_vis:
            problems.append(f"vis: unbekannte Modelle {unknown_vis}")
        vis_vram = float(vis.get("estimatedVRAM", 0) or 0) + float(vis.get("vramReserveGb", 0) or 0) + sum(
            float(models[mid].get("estimatedVRAM", 0)) for mid in vis_ids if mid in models
        )
        vis_limit = _gpu_capacity(str(vis.get("gpuPoolId"))) - float(vis.get("vramSafetyMarginGb", 6))
        try:
            guard_gpu_ids(fleet, {**vis, "_computedVram": vis_vram})
        except ConfigError as exc:
            problems.append(str(exc))
        if vis_vram > vis_limit:
            problems.append(f"vis: {vis_vram:.0f} GB > {vis_limit} GB nutzbar ({vis.get('gpuPool')})")
    total = worst_total + vis_eur
    # Budget gilt fuer die dauerhaft laufenden Pods (startTrigger=always) + vis.
    budget_total = worst_always + vis_eur
    limit = float(fleet["budget"]["maxEurPerHour"])
    if budget_total > limit:
        problems.append(f"Dauer-Kosten {budget_total:.2f} €/h > Budget {limit:.2f} €/h")
    return {"pods": rows, "visEurPerHour": round(vis_eur, 3), "visVramGb": vis_vram if vis.get("enabled") else 0.0,
            "eurPerHourMax": round(total, 3),
            "eurPerHourAlways": round(budget_total, 3),
            "budgetEurPerHour": limit, "problems": problems}


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
                     ttl: int, repo: str = "") -> Optional[List[Dict[str, Any]]]:
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
        per_file = manifest_entries(target, prefix, mid, rev, ttl, str(models[mid].get("repository", "")))
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
             entries: List[Dict[str, Any]], gpu_id: Optional[str] = None) -> Dict[str, Any]:
    env = {
        "AI_ROLE": pod["aiRole"],
        "AI_ROLE_MODELS": ",".join(pod["models"]),
        "AI_RESIDENT_ONLY": "1",
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
        "gpu": {"id": gpu_id or pod["gpuPoolId"], "count": 1},
        "disk": pod["containerDiskGb"],
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


def cmd_up(args: argparse.Namespace, fleet: Dict[str, Any], models: Dict[str, Dict[str, Any]]) -> int:
    p = plan(fleet, models)
    print_plan(p)
    if p["problems"]:
        return 4
    image = require(fleet["imageEnv"])
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
        pod_image = os.environ.get(pod.get("imageEnv", fleet["imageEnv"]), "").strip() or require(fleet["imageEnv"])
        computed = sum(float(models[mid].get("estimatedVRAM", 0)) for mid in pod["models"])
        computed += float(pod.get("vramReserveGb", 0)) + float(pod.get("estimatedVRAM", 0))
        choices = guard_gpu_ids(fleet, {**pod, "_computedVram": computed})
        status, data = 0, {}
        for gpu_id in choices:
            status, data = api("POST", "/pods", pod_body(fleet, pod, pod_image, token, entries, gpu_id))
            if status in (200, 201) and isinstance(data, dict) and data.get("id"):
                break
            message = str(data).lower()
            if status not in (409, 429, 503) and not any(key in message for key in ("out of stock", "no capacity", "unavailable gpu")):
                break
        if status not in (200, 201) or not isinstance(data, dict) or not data.get("id"):
            print(f"✖ {pod['role']}: Anlegen fehlgeschlagen (HTTP {status}) {str(data)[:300]}")
            return 4
        started[pod["role"]] = data["id"]
        print(f"+ {pod['role']}: angelegt {data['id']} ({data.get('cost', '?')} $/h)")
    # Ist-Kosten gegen das Budget (GPU-Wahl kann vom Plan abweichen).
    running = [p for p in fleet_pods(fleet) if p.get("desiredStatus") != "TERMINATED"]
    for p in running:
            per_h = float(p.get("cost") or 0)
            if per_h > min(MAX_USD_PER_HOUR, float(fleet["budget"].get("maxUsdPerHourPerInstance", MAX_USD_PER_HOUR))):
                print(f"✖ {p.get('name')}: Ist-Kosten {per_h:.2f} $/h > {MAX_USD_PER_HOUR:.2f} $/h – Flotte wird beendet.")
                cmd_down(argparse.Namespace(yes=True), fleet)
                return 4
    actual = sum(float(p.get("cost") or 0) for p in running)
    actual_eur = actual * float(fleet["budget"]["usdToEur"]) * float(fleet["budget"].get("vatMultiplier", 1.0))
    print(f"Ist-Kosten: {actual:.2f} $/h ≈ {actual_eur:.2f} €/h")
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
                          "totalEurPerHour": total * float(fleet["budget"]["usdToEur"])},
                         ensure_ascii=False))
        return 0
    for r in rows:
        print(f"{r['name']:32} {r['id']:16} {r['desiredStatus']:10} {r['cost']} $/h  {r['state']}")
    print(f"Summe {total:.2f} $/h ≈ {total * float(fleet['budget']['usdToEur']):.2f} €/h, {len(pods)} Pods")
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
    for pod in fleet["pods"]:
        for mid, rev in models_with_weights(pod, models):
            tar = weight_key(prefix, mid, rev)
            # Der Edge-Spiegel legt dateiweise ab (Manifest) - das zaehlt genauso.
            present = weights_present(target, prefix, mid, rev)
            kind = ".tar" if target.head(tar) is not None else ("dateiweise" if present else "")
            missing_total += 0 if present else 1
            print(f"{'✔' if present else '✖'} {pod['role']:6} {tar}{' [' + kind + ']' if kind else ''}")
    print("Alle Gewichte vorhanden." if not missing_total else f"{missing_total} Archive fehlen → scripts/weights-mirror.py oder Edge-Spiegel (workers/weights-mirror.js)")
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
