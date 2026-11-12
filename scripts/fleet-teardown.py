#!/usr/bin/env python3
"""audioMONASTRY – Fleet-Teardown: sichern, dann KOMPLETT auf 0 EUR.

Ablauf (in dieser Reihenfolge, mit Abbruch bei Fehlern):
  1. Alle Hetzner-Server mit label app=audiomonastry finden (die 4 Rollen
     app|sfu|media|edge, plus etwaige Test-Server).
  2. Je Server einen Snapshot erstellen und WARTEN, bis er `available` ist
     (Hetzner-Snapshots laufen asynchron; wer den Server zu frueh loescht,
     verliert die Sicherung).
  3. Je Server DELETE /servers/{id} – nicht nur "stop": ein gestoppter Server
     kostet weiter Disk-Grundpreis, geloescht kostet er 0 EUR.
  4. Alle RunPod-Pods der Flotte terminieren (runpod-pods.py down --yes).
  5. Verifizieren: 0 laufende Server, 0 laufende Pods. Exit 0 nur dann.

Kosten nach dem Lauf: nur die Snapshots (Hetzner 0,01 EUR/GB/Monat).
Die Server selbst und die Pods sind auf 0 EUR.

Aufruf:
  python3 scripts/fleet-teardown.py            # zeigt nur den Plan
  python3 scripts/fleet-teardown.py --yes      # wirklich sichern + loeschen
  python3 scripts/fleet-teardown.py --yes --no-snapshot   # ohne Sicherung (Notfall)
  python3 scripts/fleet-teardown.py --yes --keep-pods     # Pods laufen lassen
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
LABEL_SELECTOR = "labels[app]=audiomonastry"


def log(msg: str) -> None:
    print(f"[teardown] {msg}", flush=True)


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
        f"{HETZNER_API}{path}",
        data=data,
        method=method,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    req.add_header("User-Agent", "audiomonastry-teardown/1.0")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            return resp.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as exc:
        raw = exc.read() if exc.fp else b""
        return exc.code, (json.loads(raw) if raw else {})


def get_servers(token: str) -> list[dict]:
    status, data = hcloud(token, "GET", f"/servers?{LABEL_SELECTOR}&per_page=50")
    if status != 200:
        raise SystemExit(f"Hetzner: Server-Liste nicht lesbar (HTTP {status}) {str(data)[:200]}")
    return data.get("servers", [])


def create_snapshot(token: str, server_id: int, description: str) -> int | None:
    # Hetzner-Server-Snapshot: eigener Action-Endpoint. POST /images mit
    # source.server existiert nicht (HTTP 404, live gemessen 2026-11-08).
    status, data = hcloud(token, "POST", f"/servers/{server_id}/actions/create_image", {
        "type": "snapshot",
        "description": description,
    })
    if status not in (200, 201):
        log(f"  FEHLER Snapshot ({description}): HTTP {status} {str(data)[:200]}")
        return None
    image_id = data.get("image", {}).get("id")
    log(f"  Snapshot erstellt: {image_id} ({description})")
    return image_id


def wait_snapshot(token: str, image_id: int, timeout_s: float = 900) -> bool:
    """Wartet, bis der Snapshot `available` ist. Ohne dieses Warten wuerde der
    Server geloescht, waehrend das Image noch geschrieben wird -> Datenverlust."""
    deadline = time.time() + timeout_s
    last = ""
    while time.time() < deadline:
        status, data = hcloud(token, "GET", f"/images/{image_id}")
        if status == 200:
            st = data.get("image", {}).get("status", "")
            if st != last:
                log(f"  Snapshot {image_id}: {st}")
                last = st
            if st == "available":
                return True
            if st in ("unavailable", "error"):
                return False
        time.sleep(10)
    log(f"  TIMEOUT: Snapshot {image_id} nicht fertig nach {timeout_s:.0f}s")
    return False


def delete_server(token: str, server_id: int, name: str) -> bool:
    status, data = hcloud(token, "DELETE", f"/servers/{server_id}")
    if status in (200, 202, 204, 404):
        log(f"  GELOESCHT: {name} ({server_id})")
        return True
    log(f"  FEHLER beim Loeschen von {name}: HTTP {status} {str(data)[:200]}")
    return False


def pods_down() -> bool:
    if json.loads((ROOT/'deploy/gpu-provider.json').read_text())['provider'] == 'vast':
        import importlib.util
        import re
        spec=importlib.util.spec_from_file_location('idle_vast',ROOT/'scripts/vast-pods.py')
        module=importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        pattern=re.compile(r'^audiomonastry-vast-(?:brain|ears|voice|music|studio|audio-brain|song|vis)-[0-9]{10,20}$')
        for instance in module.instances():
            if pattern.fullmatch(instance.get('label') or ''):
                try:module.destroy(instance['id'])
                except RuntimeError:pass
        return not any(pattern.fullmatch(x.get('label') or '') for x in module.instances())
    log("Vast: aufgezeichnete Flotten-Instanzen beenden ...")
    result = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "gpu-pods.py"), "down", "--yes"],
        cwd=str(ROOT), capture_output=True, text=True, timeout=600,
    )
    out = (result.stdout or "") + (result.stderr or "")
    for line in out.strip().splitlines()[-12:]:
        log(f"  {line}")
    return result.returncode == 0


def pods_running_count() -> int:
    if json.loads((ROOT / "deploy/gpu-provider.json").read_text())["provider"] == "vast":
        import importlib.util
        spec = importlib.util.spec_from_file_location("vast_pods", ROOT / "scripts/vast-pods.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        try:
            return sum(1 for x in module.instances() if str(x.get("label", "")).startswith(module.PREFIX))
        except Exception:
            return -1
    key = os.environ.get("RP_API_KEY", "").strip()
    if not key:
        env = load_env()
        key = env.get("RP_API_KEY", "").strip()
    if not key:
        return -1
    req = urllib.request.Request(
        "https://api.runpod.io/v2/pods",
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    )
    req.add_header("User-Agent", "audiomonastry-teardown/1.0")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read() or b"{}")
    except Exception:  # noqa: BLE001
        return -1
    return sum(1 for p in data.get("pods", []) if p.get("name", "").startswith("audiomonastry-"))


def main() -> int:
    ap = argparse.ArgumentParser(description="Fleet sichern und komplett auf 0 EUR bringen")
    ap.add_argument("--yes", action="store_true", help="wirklich sichern und loeschen")
    ap.add_argument("--no-snapshot", action="store_true", help="ohne Sicherung loeschen (Notfall)")
    ap.add_argument("--keep-pods", action="store_true", help="RunPod-Pods nicht anfassen")
    args = ap.parse_args()

    env = load_env()
    token = env.get("HCLOUD_TOKEN", "").strip() or os.environ.get("HCLOUD_TOKEN", "").strip()
    if not token:
        log("FEHLER: HCLOUD_TOKEN fehlt in .env.deploy")
        return 2
    for k, v in env.items():
        os.environ.setdefault(k, v)

    servers = get_servers(token)
    log(f"{len(servers)} Hetzner-Server (label app=audiomonastry):")
    total_disk = 0
    for s in servers:
        role = (s.get("labels") or {}).get("role", "?")
        disk = s.get("server_type", {}).get("disk", 0)
        total_disk += disk
        log(f"  {s['name']:28} id={s['id']:10} role={role:6} {s['server_type']['name']:6} disk={disk}GB status={s['status']}")

    if not args.yes:
        snap_cost = total_disk * 0.01
        log("")
        log(f"DRY-RUN: wuerde {len(servers)} Server sichern und loeschen.")
        log(f"  Snapshot-Kosten danach: ~{snap_cost:.2f} EUR/Monat ({total_disk} GB x 0,01 EUR/GB)")
        log("  Mit --yes ausfuehren.")
        return 3

    if not servers and (args.keep_pods or pods_running_count() == 0):
        log("Nichts zu tun: 0 Server, 0 Pods.")
        return 0

    # Remove billed GPU contracts before snapshots. Both authorized watchdog
    # hosts delete themselves last; shared work roles precede both coordinators.
    if not args.keep_pods and not pods_down():
        log('Vast cleanup not confirmed; CPU cleanup continues and final inventory must fail closed.')
    runner_role=env.get('FLEET_TEARDOWN_RUNNER_ROLE','app')
    servers.sort(key=lambda item:(item.get('labels',{}).get('role') == runner_role,
                                 item.get('labels',{}).get('role') in ('app','edge')))

    failed = 0
    for s in servers:
        name, sid = s["name"], s["id"]
        log(f"Server {name} ({sid}):")
        if not args.no_snapshot:
            img = create_snapshot(token, sid, f"audiomonastry-snapshot-{name}-{time.strftime('%Y%m%d-%H%M')}")
            if img is None:
                log(f"  UEBERSPRUNGEN: Snapshot fehlgeschlagen, Server {name} bleibt stehen (kein Datenverlust).")
                failed += 1
                continue
            if not wait_snapshot(token, img):
                log(f"  UEBERSPRUNGEN: Snapshot {img} nicht verfuegbar, Server {name} bleibt stehen.")
                failed += 1
                continue
        if not delete_server(token, sid, name):
            failed += 1

    if not args.keep_pods:
        if not pods_down():
            failed += 1

    # Verifizieren: wirklich 0?
    left_servers = get_servers(token)
    left_pods = pods_running_count()
    log("")
    log("=== VERIFIKATION ===")
    log(f"  Hetzner-Server laufend: {len(left_servers)}")
    log(f"  RunPod-Pods laufend:    {left_pods if left_pods >= 0 else 'unbekannt'}")
    ok = not left_servers and left_pods == 0
    log(f"  Provisionierung auf 0 EUR: {'JA' if ok else 'NEIN'}")
    if failed:
        log(f"  Fehler beim Abbau: {failed}")
    return 0 if ok and not failed else 4


if __name__ == "__main__":
    sys.exit(main())
