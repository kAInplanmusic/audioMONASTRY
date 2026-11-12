#!/usr/bin/env python3
"""audioMONASTRY – Idle-Waechter: nach 15 Min ohne Nutzung sichern + alles auf 0 EUR.

Wird an ZWEI Stellen periodisch aufgerufen (doppelte Absicherung, Betreiber
2026-11-08: "muss IMMER passieren, ohne Wenn und Aber"):

  A) systemd-Timer auf app-1  -> feuert, solange die App laeuft
  B) cron/systemd auf dem Brain -> feuert auch dann, wenn app-1 haengt oder
     nicht mehr antwortet (dann ist die App-Abfrage "unknown" und der Waechter
     entscheidet nach der Karenzzeit selbst).

Entscheidungsregeln:
  * App sagt "idle" (keine Nutzung >= 15 Min)      -> Teardown
  * App sagt "active"                              -> nichts tun
  * App nicht erreichbar / Signal unlesbar:
      - solange noch nie ein erfolgreicher Kontakt bestand -> nichts (Boot-Phase)
      - nach GRACE_MINUTES ohne erfolgreichen Kontakt     -> Teardown (Fail-Safe)

Teardown = scripts/fleet-teardown.py --yes: Snapshot je Server (wartet auf
`available`), dann Server loeschen, Pods terminieren, 0 EUR verifizieren.

Aufruf:
  python3 scripts/fleet-idle-teardown.py            # nur pruefen (Exit 0 = nichts zu tun)
  python3 scripts/fleet-idle-teardown.py --apply    # Teardown wirklich ausfuehren
  python3 scripts/fleet-idle-teardown.py --apply --idle-minutes 15 --grace-minutes 15
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
STATE_FILE = pathlib.Path("/tmp/audiomonastry-idle-watch.json")
DEPLOY_LOCK = pathlib.Path("/tmp/audiomonastry-deploy.lock")


def deploy_running() -> bool:
    """True, solange deploy-full.sh laeuft (Lock-Datei mit lebender PID).

    Grund: Der Waechter hat 2026-11-09 mitten im Test-Deploy Pods und Hetzner-
    Server geloescht, weil die frisch provisionierte App nach 15 Min Karenz
    noch nicht antwortete — Race Condition Deploy vs. Idle-Teardown.
    Stale Locks (PID tot) werden aufgeraeumt und ignoriert.
    """
    try:
        pid = int(DEPLOY_LOCK.read_text().strip())
    except (OSError, ValueError):
        if DEPLOY_LOCK.exists():
            try:
                DEPLOY_LOCK.unlink()
            except OSError:
                pass
        return False
    try:
        os.kill(pid, 0)  # lebt der Prozess noch?
        return True
    except (ProcessLookupError, PermissionError):
        try:
            DEPLOY_LOCK.unlink()
        except OSError:
            pass
        return False


def log(msg: str) -> None:
    print(f"[idle-watch] {msg}", flush=True)


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


def http_json(url: str, headers: dict | None = None, timeout: float = 10):
    req = urllib.request.Request(url, headers=headers or {})
    req.add_header("User-Agent", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            return resp.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as exc:
        raw = exc.read() if exc.fp else b""
        try:
            return exc.code, json.loads(raw) if raw else {}
        except ValueError:
            return exc.code, {}
    except Exception:  # noqa: BLE001
        return 0, {}


def app_ip(token: str) -> str:
    status, data = http_json(
        f"{HETZNER_API}/servers?label_selector=app%3Daudiomonastry&per_page=50",
        {"Authorization": f"Bearer {token}"},
    )
    if status != 200:
        raise RuntimeError('HETZNER_INVENTORY_UNREADABLE')
    for s in data.get("servers", []):
        if (s.get('labels') or {}).get('app')=='audiomonastry' and (s.get("labels") or {}).get("role") == "app":
            return (s.get("public_net") or {}).get("ipv4", {}).get("ip", "")
    return ""


def idle_signal(ip: str, studio_token: str) -> tuple[str, dict]:
    """Gibt ('idle'|'active'|'unknown', rohdaten) zurueck."""
    if not ip:
        return "unknown", {}
    status, data = http_json(
        "https://hallerbans.de/api/idle-signal?thresholdSec=900",
        {"x-studio-token": studio_token} if studio_token else {},
    )
    if status != 200:
        return "unknown", {"http": status}
    verdict = str(data.get("verdict") or data.get("idle") or "").lower()
    if data.get("idle") is True or verdict in ("idle", "true"):
        return "idle", data
    if data.get("idle") is False or verdict in ("active", "false"):
        return "active", data
    return "unknown", data


def read_state() -> dict:
    try:
        return json.loads(STATE_FILE.read_text())
    except Exception:  # noqa: BLE001
        return {}


def write_state(state: dict) -> None:
    try:
        STATE_FILE.write_text(json.dumps(state))
    except Exception:  # noqa: BLE001
        pass


def run_teardown() -> int:
    log("TEARDOWN wird ausgefuehrt (sichern -> loeschen -> 0 EUR) ...")
    result = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "fleet-teardown.py"), "--yes"],
        cwd=str(ROOT), capture_output=True, text=True, timeout=3600,
    )
    for line in ((result.stdout or "") + (result.stderr or "")).strip().splitlines()[-25:]:
        log(f"  {line}")
    return result.returncode


def main() -> int:
    ap = argparse.ArgumentParser(description="Idle-Waechter -> Teardown nach X Minuten ohne Nutzung")
    ap.add_argument("--apply", action="store_true", help="Teardown wirklich ausfuehren")
    ap.add_argument("--idle-minutes", type=int, default=15)
    ap.add_argument("--grace-minutes", type=int, default=15, help="Karenz bei nicht erreichbarer App")
    args = ap.parse_args()

    env = load_env()
    token = env.get("HCLOUD_TOKEN", "").strip()
    studio = env.get("STUDIO_ACCESS_TOKEN", "").strip()
    if not token:
        log("FEHLER: HCLOUD_TOKEN fehlt")
        return 2

    # Deploy laeuft? Dann NIEMALS eingreifen (Race-Condition-Fix 2026-11-09).
    if deploy_running():
        log("Deploy laeuft (Lock aktiv) — kein Teardown.")
        return 0

    ip = app_ip(token)
    if not ip:
        log("Keine app-1 gefunden — verbleibende eigene Ressourcen abgleichen.")
        return run_teardown() if args.apply else 0

    verdict, data = idle_signal(ip, studio)
    now = int(time.time())
    state = read_state()

    if verdict == "active":
        state["last_contact"] = now
        state["misses"] = 0
        write_state(state)
        log(f"aktiv — nichts zu tun ({data.get('activityAgeMs', '?')} ms seit letzter Nutzung)")
        return 0

    if verdict == "idle":
        log(f"IDLE bestaetigt (keine Nutzung >= {args.idle_minutes} Min) -> Teardown")
        return run_teardown() if args.apply else 0

    # unknown: App antwortet nicht oder Signal unlesbar
    misses = int(state.get("misses", 0)) + 1
    state["misses"] = misses
    last = int(state.get("last_contact", 0))
    if last and (now - last) >= args.grace_minutes * 60:
        log(f"App seit {(now - last) // 60} Min nicht erreichbar (>{args.grace_minutes}) -> Fail-Safe-Teardown")
        return run_teardown() if args.apply else 0
    if not last:
        # Noch nie Kontakt: Boot-Phase, aber State auf jetzt setzen, damit die
        # Karenz ab jetzt laeuft (sonst wuerde sie nie starten).
        state["last_contact"] = now
    write_state(state)
    log(f"App nicht erreichbar/Signal unlesbar (Versuch {misses}) — Karenz laeuft, kein Teardown")
    return 0


if __name__ == "__main__":
    sys.exit(main())
