#!/usr/bin/env python3
"""RunPod-Pod-Flotte: planen, Gewichte prüfen, starten, Status, beenden.

Quelle der Flotte: deploy/runpod/pod-fleet.json (5 AI-Pods, alles resident).
Modelle/Revisionen: services/audiomonastry-ai-runtime/model_manifest.json.

Befehle
  plan      Rechnet Belegung (VRAM je Pod) und Kosten, prüft das 4-€-Budget. Kein Netz.
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
API = "https://rest.runpod.io/v1"
USABLE_VRAM_GB = 42  # 48 GB minus 6 GB Sicherheitsmarge (model_manifest.json runtime)
REVISION_RE = re.compile(r"^[0-9a-f]{40}$")

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import s3lite  # noqa: E402


def _http(method: str, url: str, headers: Dict[str, str], body: Optional[bytes], timeout: float) -> Tuple[int, bytes]:
    req = urllib.request.Request(url, data=body, method=method, headers=headers)
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
    worst_total = 0.0
    problems: List[str] = []
    for pod in sorted(fleet["pods"], key=lambda p: p["startOrder"]):
        unknown = [m for m in pod["models"] if m not in models]
        if unknown:
            problems.append(f"{pod['role']}: unbekannte Modelle {unknown}")
            continue
        vram = sum(float(models[m].get("estimatedVRAM", 0)) for m in pod["models"])
        if vram > USABLE_VRAM_GB:
            problems.append(f"{pod['role']}: {vram:.0f} GB > {USABLE_VRAM_GB} GB nutzbar")
        pool = fleet["gpuPools"][pod["gpuPool"]]
        worst = max(g["usdPerHour"] for g in pool) * usd_to_eur
        worst_total += worst
        rows.append({"role": pod["role"], "aiRole": pod["aiRole"], "models": pod["models"], "vramGb": vram,
                     "gpus": [g["id"] for g in pool], "eurPerHourMax": round(worst, 3)})
    vis = fleet.get("visPod") or {}
    vis_eur = 0.0
    if vis.get("enabled"):
        vis_eur = max(g["usdPerHour"] for g in fleet["gpuPools"][vis["gpuPool"]]) * usd_to_eur
    total = worst_total + vis_eur
    limit = float(fleet["budget"]["maxEurPerHour"])
    if total > limit:
        problems.append(f"Kosten {total:.2f} €/h > Budget {limit:.2f} €/h")
    return {"pods": rows, "visEurPerHour": round(vis_eur, 3), "eurPerHourMax": round(total, 3),
            "budgetEurPerHour": limit, "problems": problems}


def print_plan(p: Dict[str, Any]) -> None:
    print(f"{'Rolle':8} {'AI_ROLE':20} {'VRAM':>6}  {'max €/h':>7}  Modelle")
    for r in p["pods"]:
        print(f"{r['role']:8} {r['aiRole']:20} {r['vramGb']:5.0f}G  {r['eurPerHourMax']:7.2f}  {', '.join(r['models'])}")
    if p["visEurPerHour"]:
        print(f"{'vis':8} {'(Visuals)':20} {'':>6}  {p['visEurPerHour']:7.2f}")
    print(f"Summe höchstens {p['eurPerHourMax']:.2f} €/h (Budget {p['budgetEurPerHour']:.2f} €/h)")
    for prob in p["problems"]:
        print(f"PROBLEM: {prob}")


# --------------------------------------------------------------------------- Gewichte
def weight_key(prefix: str, model_id: str, revision: str) -> str:
    return f"{prefix}/{model_id}/{revision}.tar"


def models_with_weights(pod: Dict[str, Any], models: Dict[str, Dict[str, Any]]) -> List[Tuple[str, str]]:
    """(id, revision) aller Modelle mit gepinnter Revision (essentia u. ä. ohne Gewichte fallen raus)."""
    out = []
    for mid in pod["models"]:
        rev = str(models[mid].get("revision", ""))
        if REVISION_RE.fullmatch(rev):
            out.append((mid, rev))
    return out


def weight_entries(pod: Dict[str, Any], models: Dict[str, Dict[str, Any]], target: "s3lite.S3Target",
                   prefix: str, ttl: int) -> Tuple[List[Dict[str, Any]], List[str]]:
    """Presigned-Einträge für AI_WEIGHTS_URLS und Liste fehlender Archive."""
    entries, missing = [], []
    for mid, rev in models_with_weights(pod, models):
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
    if status != 200 or not isinstance(data, list):
        raise ConfigError(f"Pod-Liste nicht lesbar (HTTP {status})")
    prefix = fleet["namePrefix"]
    return [p for p in data if str(p.get("name", "")).startswith(prefix)]


def pod_body(fleet: Dict[str, Any], pod: Dict[str, Any], image: str, token: str,
             entries: List[Dict[str, Any]]) -> Dict[str, Any]:
    env = {
        "AI_ROLE": pod["aiRole"],
        "AI_ROLE_MODELS": ",".join(pod["models"]),
        "AI_RESIDENT_ONLY": "1",
        "AI_POD_TOKEN": token,
        "AI_WEIGHTS_URLS": json.dumps(entries, separators=(",", ":")),
        "AI_RUNTIME_DEVICE": "cuda",
        "HF_HOME": "/workspace/hf-cache",
        "PORT": str(fleet["port"]),
        **pod.get("env", {}),
    }
    for name in pod.get("secretEnv", []):
        value = os.environ.get(name, "").strip()
        if value:
            env[name] = value
    return {
        "name": f"{fleet['namePrefix']}{pod['role']}",
        "imageName": image,
        "gpuTypeIds": [g["id"] for g in fleet["gpuPools"][pod["gpuPool"]]],
        "gpuTypePriority": "custom",
        "gpuCount": 1,
        "cloudType": fleet["cloudType"],
        "containerDiskInGb": pod["containerDiskGb"],
        "volumeInGb": 0,
        "ports": [f"{fleet['port']}/http"],
        "env": env,
        "dockerEntrypoint": ["python", "pod_start.py"],
        "dockerStartCmd": [],
    }


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
    for pod in sorted(fleet["pods"], key=lambda x: x["startOrder"]):
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
        status, data = api("POST", "/pods", pod_body(fleet, pod, image, token, entries))
        if status not in (200, 201) or not isinstance(data, dict) or not data.get("id"):
            print(f"✖ {pod['role']}: Anlegen fehlgeschlagen (HTTP {status}) {str(data)[:300]}")
            return 4
        started[pod["role"]] = data["id"]
        print(f"+ {pod['role']}: angelegt {data['id']} ({data.get('costPerHr', '?')} $/h)")
    # Ist-Kosten gegen das Budget (GPU-Wahl kann vom Plan abweichen).
    actual = sum(float(p.get("costPerHr") or 0) for p in fleet_pods(fleet) if p.get("desiredStatus") != "TERMINATED")
    actual_eur = actual * float(fleet["budget"]["usdToEur"])
    print(f"Ist-Kosten: {actual:.2f} $/h ≈ {actual_eur:.2f} €/h")
    if actual_eur > float(fleet["budget"]["maxEurPerHour"]):
        print("✖ Budget überschritten – Flotte wird beendet.")
        cmd_down(argparse.Namespace(yes=True), fleet)
        return 4
    print("\nFür den Server (.env):")
    for role, pod_id in started.items():
        print(f"RP_POD_ID_{role.upper()}={pod_id}")
    if args.wait:
        print(f"\nWarte auf Bereitschaft (höchstens {args.wait} s):")
        done = wait_ready(started, int(fleet["port"]), token, float(args.wait))
        if not all(done.values()):
            print("✖ Nicht alle Instanzen bereit: " + ", ".join(r for r, ok in done.items() if not ok))
            return 4
    return 0


def cmd_status(fleet: Dict[str, Any]) -> int:
    pods = fleet_pods(fleet)
    token = os.environ.get("AI_POD_TOKEN", "").strip()
    total = 0.0
    for p in sorted(pods, key=lambda x: x.get("name", "")):
        total += float(p.get("costPerHr") or 0)
        state = ready(p["id"], int(fleet["port"]), token)[1] if token else "?"
        print(f"{p.get('name', ''):32} {p['id']:16} {p.get('desiredStatus', ''):10} {p.get('costPerHr', '?')} $/h  {state}")
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
            key = weight_key(prefix, mid, rev)
            present = target.head(key) is not None
            missing_total += 0 if present else 1
            print(f"{'✔' if present else '✖'} {pod['role']:6} {key}")
    print("Alle Gewichte vorhanden." if not missing_total else f"{missing_total} Archive fehlen → scripts/weights-mirror.py")
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
    sub.add_parser("status")
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
            return cmd_status(fleet)
        if args.cmd == "down":
            return cmd_down(args, fleet)
    except ConfigError as exc:
        print(f"Konfiguration: {exc}", file=sys.stderr)
        return 2
    return 2


if __name__ == "__main__":
    sys.exit(main())
