#!/usr/bin/env python3
"""audioMONASTRY – Fleet-Start: die 4 Hetzner-Rollen + App + RunPod-Pods.

Gegenstueck zu scripts/fleet-teardown.py. Behandelt ALLE vier Rollen gleich
(symmetrisch): pruefen -> fehlende provisionieren -> auf RUNNING warten ->
App deployen -> RunPod-Pods starten -> Health-Check je Knoten.

Die vier Rollen (Quelle: scripts/hetzner/provision-fleet.sh):
  audiomonastry-app-1    cx43  app    Caddy+API+Signaling+master-player+TURN
  audiomonastry-sfu-1    cx33  sfu    RTP-Ports 40000-40099
  audiomonastry-media-1  cx43  media  R2-Sync-Worker + Audio-Streaming-Cache
  audiomonastry-edge-1   cx23  edge   Monitoring (Grafana nur localhost)

Aufruf:
  python3 scripts/fleet-start.py              # Plan anzeigen
  python3 scripts/fleet-start.py --yes        # wirklich starten (kostet ab Start)
  python3 scripts/fleet-start.py --yes --no-pods   # nur Hetzner, keine AI-Pods
  python3 scripts/fleet-start.py --yes --only app,sfu
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
ENV_FILE = ROOT / ".env.deploy"
HETZNER_API = "https://api.hetzner.cloud/v1"
ROLES = [
    # (Servername, Rolle, Standard-Typ)
    ("audiomonastry-app-1", "app", "cx43"),
    ("audiomonastry-sfu-1", "sfu", "cx33"),
    ("audiomonastry-media-1", "media", "cx43"),
    ("audiomonastry-edge-1", "edge", "cx23"),
]


def log(msg: str) -> None:
    print(f"[start] {msg}", flush=True)


def load_env() -> dict:
    env: dict[str, str] = {}
    if not ENV_FILE.exists():
        return env
    for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        env[key.strip()] = value.strip().strip('"').strip("'")
    return env


def hcloud(token: str, method: str, path: str, body: dict | None = None, timeout: float = 60):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        f"{HETZNER_API}{path}", data=data, method=method,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    req.add_header("User-Agent", "audiomonastry-fleet-start/1.0")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            return resp.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as exc:
        raw = exc.read() if exc.fp else b""
        return exc.code, (json.loads(raw) if raw else {})
    except (urllib.error.URLError, TimeoutError, OSError):
        return 0, {}


def get_servers(token: str) -> dict[str, dict]:
    status, data = hcloud(token, "GET", "/servers?labels[app]=audiomonastry&per_page=50")
    if status != 200:
        raise SystemExit(f"Hetzner: Server-Liste nicht lesbar (HTTP {status})")
    return {s["name"]: s for s in data.get("servers", [])}


def wait_running(token: str, names: list[str], timeout_s: float = 300) -> dict[str, dict]:
    deadline = time.time() + timeout_s
    out: dict[str, dict] = {}
    while time.time() < deadline:
        servers = get_servers(token)
        out = {n: servers[n] for n in names if n in servers}
        if len(out) == len(names) and all(s.get("status") == "running" for s in out.values()):
            return out
        time.sleep(10)
    return out


def provision_missing(names: list[str]) -> bool:
    """Ruft das bestehende provision-fleet.sh fuer die fehlenden Rollen auf."""
    log(f"provision-fleet.sh fuer {len(names)} fehlende Rolle(n): {names}")
    result = subprocess.run(
        ["bash", str(ROOT / "scripts" / "hetzner" / "provision-fleet.sh")],
        cwd=str(ROOT), capture_output=True, text=True, timeout=1800,
    )
    out = ((result.stdout or "") + (result.stderr or "")).strip()
    for line in out.splitlines()[-20:]:
        log(f"  {line}")
    return result.returncode == 0


def deploy_app(app_ip: str, domain: str) -> bool:
    log(f"Deploy auf app-1 ({app_ip}) ...")
    env = os.environ.copy()
    env.update({"DEPLOY_HOST": f"root@{app_ip}", "DEPLOY_DOMAIN": domain, "DEPLOY_SYNC_ENV": "1"})
    result = subprocess.run(
        ["bash", str(ROOT / "deploy.sh")], cwd=str(ROOT), env=env,
        capture_output=True, text=True, timeout=3600,
    )
    for line in ((result.stdout or "") + (result.stderr or "")).strip().splitlines()[-15:]:
        log(f"  {line}")
    return result.returncode == 0


def health(ip: str, port: int = 8080, timeout: float = 10) -> bool:
    try:
        with urllib.request.urlopen(f"http://{ip}:{port}/api/health", timeout=timeout) as resp:
            body = json.loads(resp.read() or b"{}")
        return body.get("status") == "ok"
    except Exception:  # noqa: BLE001
        return False


def start_pods() -> bool:
    log("RunPod-Pods starten ...")
    result = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "gpu-pods.py"), "up", "--yes"],
        cwd=str(ROOT), capture_output=True, text=True, timeout=1800,
    )
    for line in ((result.stdout or "") + (result.stderr or "")).strip().splitlines()[-20:]:
        log(f"  {line}")
    return result.returncode == 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Fleet starten (4 Hetzner-Rollen + App + Pods)")
    ap.add_argument("--yes", action="store_true", help="wirklich provisionieren/starten (kostet)")
    ap.add_argument("--no-pods", action="store_true", help="keine RunPod-Pods starten")
    ap.add_argument("--only", default="", help="nur diese Rollen, z.B. app,sfu")
    args = ap.parse_args()

    env = load_env()
    for k, v in env.items():
        os.environ.setdefault(k, v)
    token = env.get("HCLOUD_TOKEN", "").strip()
    if not token:
        log("FEHLER: HCLOUD_TOKEN fehlt in .env.deploy")
        return 2
    domain = env.get("DEPLOY_DOMAIN", "hallerbans.de")

    wanted = [r for r in ROLES if not args.only or r[1] in {x.strip() for x in args.only.split(",")}]
    existing = get_servers(token)
    missing = [r for r in wanted if r[0] not in existing]
    present = [r for r in wanted if r[0] in existing]

    log(f"{len(wanted)} Rolle(n) gewuenscht, {len(present)} vorhanden, {len(missing)} fehlen:")
    for name, role, typ in wanted:
        s = existing.get(name)
        state = f"vorhanden ({s['status']}, {s.get('public_net',{}).get('ipv4',{}).get('ip','-')})" if s else "FEHLT"
        log(f"  {name:28} role={role:6} typ={typ:6} {state}")

    if not args.yes:
        log("")
        log("DRY-RUN: wuerde fehlende Server provisionieren, App auf app-1 deployen, Pods starten.")
        log("  Mit --yes ausfuehren (kostet ab Start).")
        return 3

    if missing:
        if not provision_missing([m[0] for m in missing]):
            log("FEHLER: Provisionierung fehlgeschlagen")
            return 4

    servers = wait_running(token, [r[0] for r in wanted])
    missing_after = [r[0] for r in wanted if r[0] not in servers or servers[r[0]].get("status") != "running"]
    if missing_after:
        log(f"FEHLER: nicht RUNNING: {missing_after}")
        return 4

    app = servers.get("audiomonastry-app-1", {})
    app_ip = (app.get("public_net") or {}).get("ipv4", {}).get("ip", "")
    log(f"Alle {len(servers)} Knoten RUNNING.")
    for name, s in sorted(servers.items()):
        ip = (s.get("public_net") or {}).get("ipv4", {}).get("ip", "-")
        log(f"  {name:28} {ip}")

    if app_ip:
        if not deploy_app(app_ip, domain):
            log("WARNUNG: deploy.sh meldete Fehler — Health-Check entscheidet")
    else:
        log("WARNUNG: app-1 ohne IP, Deploy uebersprungen")

    if not args.no_pods:
        if not start_pods():
            log("GPU fleet failed; refusing ready status")
            return 4

    # Health-Checks
    log("")
    log("=== HEALTH-CHECKS ===")
    ok_all = True
    for name, s in sorted(servers.items()):
        ip = (s.get("public_net") or {}).get("ipv4", {}).get("ip", "")
        role = (s.get("labels") or {}).get("role", "?")
        if role == "app" and ip:
            up = health(ip)
            log(f"  {name:28} /api/health: {'OK' if up else 'FEHLT'}")
            ok_all = ok_all and up
        else:
            log(f"  {name:28} provisioniert (kein HTTP-Health fuer Rolle {role})")

    log("")
    log(f"=== FLEET {'BEREIT' if ok_all else 'TEILWEISE BEREIT'} ===")
    log(f"App: https://{domain}")
    return 0 if ok_all else 4


if __name__ == "__main__":
    sys.exit(main())
