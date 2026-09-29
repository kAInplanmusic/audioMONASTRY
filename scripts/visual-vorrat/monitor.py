#!/usr/bin/env python3
"""Beobachtet den Lauf: Pods, Kosten, fertige LoRAs in R2.

Aufruf:  python3 monitor.py [--price 0.34]
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import subprocess
import time
from pathlib import Path

import r2

BASE = Path(__file__).parent
START_BALANCE = 11.7954513259
ENV = r2.load_env()


def rp(args: list[str], timeout: int = 90) -> str:
    env = {"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": "/home/patrick",
           "RUNPOD_API_KEY": ENV.get("RP_API_KEY", "")}
    res = subprocess.run(["runpodctl", *args], capture_output=True, text=True, env=env, timeout=timeout)
    return (res.stdout or res.stderr).strip()


def pods() -> list[dict]:
    try:
        return json.loads(rp(["pod", "list", "-o", "json"]))
    except Exception:
        return []


def r2_list(prefix: str) -> list[tuple[int, str]]:
    """Listing ueber rclone - dasselbe Werkzeug, mit dem die Dateien hochgeladen wurden."""
    creds = r2._creds()
    cmd = [
        "rclone", "--config", "/dev/null", "ls", f":s3:{creds['bucket']}/{prefix}",
        "--s3-provider", "Cloudflare",
        "--s3-access-key-id", creds["access_key"],
        "--s3-secret-access-key", creds["secret_key"],
        "--s3-endpoint", creds["endpoint"],
    ]
    res = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
    if res.returncode != 0:
        print(f"  (R2-Listing fehlgeschlagen: {(res.stderr or res.stdout).strip()[:150]})")
        return []
    out: list[tuple[int, str]] = []
    for line in res.stdout.splitlines():
        parts = line.split(None, 1)
        if len(parts) == 2 and parts[0].isdigit():
            out.append((int(parts[0]), parts[1].strip()))
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--price", type=float, default=0.82, help="USD/Stunde je Pod")
    ap.add_argument("--run", default="lora-themen-v1")
    args = ap.parse_args()

    now = time.time()
    sym_path = BASE / "out-v3" / "_summary.json"
    planned: list[str] = []
    if sym_path.exists():
        sym = json.loads(sym_path.read_text())
        planned = [s for s, i in sym.items() if i["written"] > 0]

    print(f"=== {dt.datetime.now():%H:%M:%S}  Monitor  (geplant: {len(planned)} Themen) ===\n")

    pl = pods()
    print(f"Pods: {len(pl)} (Kosten: {sum(p.get('costPerHr',0) for p in pl):.2f} USD/h)")

    # Echte Kosten = Startguthaben minus aktuelles Guthaben (verlaesslicher als Schaetzung)
    try:
        u = json.loads(rp(["user"]))
        bal = u.get("clientBalance", 0.0)
        print(f"Guthaben: {bal:.2f} USD | verbraucht: {START_BALANCE - bal:.2f} USD")
    except Exception as exc:
        print(f"(Guthaben nicht lesbar: {exc})")

    total_hrs = 0.0
    for p in pl:
        name = p.get("name", "?")
        pid = p.get("id", "?")
        status = p.get("desiredStatus") or p.get("status") or "?"
        created = p.get("createdAt") or p.get("lastStartedAt")
        hrs = 0.0
        if created:
            try:
                t = dt.datetime.fromisoformat(created.replace("Z", "+00:00")).timestamp()
                hrs = max(0.0, (now - t) / 3600)
            except Exception:
                pass
        total_hrs += hrs
        print(f"  {name:12} {pid:16} {status:12} {hrs:5.2f} h  ~${hrs*args.price:5.2f}")
    print(f"  -> Laufende Pod-Kosten bisher: ~${total_hrs*args.price:.2f} (bei ${args.price}/h je Pod)\n")

    print("Ergebnisse in R2:")
    items = r2_list("lora-out/")
    per_theme: dict[str, dict[str, int]] = {}
    for size, key in items:
        parts = key.split("/")
        if len(parts) >= 2:
            per_theme.setdefault(parts[0], {})[parts[-1]] = size

    done = [t for t, f in per_theme.items() if any(k.endswith(".safetensors") for k in f)]
    failed = [t for t, f in per_theme.items() if "train.log" in f and not any(k.endswith(".safetensors") for k in f)]
    print(f"  LoRA fertig : {len(done)}")
    print(f"  nur Log (evtl. Fehler): {len(failed)}")
    print(f"  offen       : {len(planned) - len(done)}")
    if done:
        print("\n  Fertige LoRAs:")
        for t in sorted(done):
            sz = next(v for k, v in per_theme[t].items() if k.endswith(".safetensors"))
            has_samples = "samples.tar" in per_theme[t]
            print(f"    {t:38} {sz/1e6:7.1f} MB  samples={'ja' if has_samples else 'nein'}")
    still = sorted(set(planned) - set(done))
    if still:
        print(f"\n  Noch offen ({len(still)}):")
        for i in range(0, len(still), 4):
            print("    " + "  ".join(f"{x:30}" for x in still[i:i + 4]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
