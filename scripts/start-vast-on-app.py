#!/usr/bin/env python3
"""Boot the eight Vast roles ON the Hetzner app host and wire the same host.

The caller MUST already have deployed the app and made its scoped .env available.
--yes is required to rent GPUs. No HF dedicated endpoints are ever created.
On failure all this deployment's Vast contracts are deleted (no billed warm disk).
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
KEYS = {
    "VAST_API_KEY", "AI_POD_TOKEN", "GHCR_USERNAME", "GHCR_PASSWORD",
    "CFS3_ACCESS_KEY", "CFS3_SECRET_KEY", "CFS3_BUCKET", "CFS3_ENDPOINT",
    "CFR2_ACCOUNT_ID", "HF_TOKEN", "VAST_COLD_START_MAX_EUR",
    "VAST_IMAGES_FILE", "VAST_STATE_DIR", "VAST_SEARCH_QUOTA_STATE",
}


def load_scoped_env(path: Path) -> None:
    if not path.is_file():
        return
    for line in path.read_text().splitlines():
        if not line or line.lstrip().startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if key not in KEYS or os.environ.get(key):
            continue
        value = value.strip().strip('"').strip("'")
        if value and "\n" not in value and "\r" not in value:
            os.environ[key] = value


def install_30m_teardown_watchdog() -> None:
    """Install independent systemd timer BEFORE renting any Vast GPU.

    The watchdog survives the initiating SSH session and destroys billed GPUs
    before taking Hetzner snapshots. It reads secrets from a root-only env
    file; this function never prints, shells or embeds credential values.
    """
    needed = ("HCLOUD_TOKEN", "STUDIO_ACCESS_TOKEN", "VAST_API_KEY")
    if any(not os.environ.get(key) for key in needed):
        raise RuntimeError("snapshot/delete watchdog credentials unavailable; no GPU rental")
    os.umask(0o077)
    env_file = ROOT / ".env.deploy"
    existing = {}
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1)
                existing[k] = v
    existing.update({k: os.environ[k] for k in needed})
    temp = ROOT / ".env.deploy.watchdog-new"
    temp.write_text("".join(f"{k}={v}\\n" for k, v in existing.items()))
    temp.chmod(0o600)
    os.replace(temp, env_file)
    service = Path("/etc/systemd/system/audiomonastry-production-idle.service")
    timer = Path("/etc/systemd/system/audiomonastry-production-idle.timer")
    service.write_text(
        "[Unit]\\nDescription=audioMONASTRY verified 30m idle backup and deletion\\n"
        "After=network-online.target\\n[Service]\\nType=oneshot\\n"
        "WorkingDirectory=/opt/audiomonastry\\n"
        "ExecStart=/usr/bin/python3 /opt/audiomonastry/scripts/fleet-idle-teardown.py "
        "--apply --idle-minutes 30 --grace-minutes 30\\n"
        "TimeoutStartSec=3600\\n"
    )
    timer.write_text(
        "[Unit]\\nDescription=audioMONASTRY one-minute idle sentinel\\n"
        "[Timer]\\nOnBootSec=60s\\nOnUnitActiveSec=60s\\n"
        "AccuracySec=1s\\nUnit=audiomonastry-production-idle.service\\n"
        "[Install]\\nWantedBy=timers.target\\n"
    )
    subprocess.run(["systemctl", "daemon-reload"], check=True, timeout=30)
    subprocess.run(["systemctl", "enable", "--now", timer.name], check=True, timeout=30)
    subprocess.run(["systemctl", "is-active", "--quiet", timer.name], check=True, timeout=30)
    # The old timer only halts the host, which still incurs Hetzner charges.
    # On the app host the new coordinated snapshots+delete timer supersedes it.
    subprocess.run(["systemctl", "disable", "--now",
                    "audiomonastry-idle-shutdown.timer"], timeout=30, check=False)
    print("Verified 30-minute independent snapshot-and-delete watchdog installed", flush=True)


def verified_app_compose() -> list[str]:
    output = subprocess.check_output(["docker", "inspect", "audiomonastry"], text=True, timeout=20)
    metadata = json.loads(output)[0]
    labels = metadata.get("Config", {}).get("Labels") or {}
    paths = (labels.get("com.docker.compose.project.config_files") or "").split(",")
    files = [Path(p).resolve() for p in paths if p]
    if not files or any(not p.is_file() or not p.is_relative_to(ROOT) for p in files):
        raise RuntimeError("cannot attest live app Compose files inside expected repo")
    args = ["docker", "compose"]
    for file in files:
        args += ["-f", str(file)]
    return args


def restart_app(compose: list[str]) -> None:
    subprocess.run([*compose, "up", "-d", "--no-build", "--force-recreate", "audiomonastry"],
                   check=True, cwd=ROOT, timeout=180)


def app_ready() -> bool:
    for _ in range(15):
        try:
            with urllib.request.urlopen("http://127.0.0.1:8080/api/health", timeout=5) as response:
                if response.status == 200 and json.load(response).get("status") == "ok":
                    return True
        except Exception:
            pass
        time.sleep(2)
    return False


def run(command: list[str]) -> None:
    subprocess.run([sys.executable, *command], check=True, cwd=ROOT, timeout=2100)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--yes", action="store_true", help="authorize a paid rental, capped by existing Vast policy")
    args = parser.parse_args(argv)
    if not args.yes:
        print("DRY RUN: preflight only, no GPU allocation", flush=True)
        return subprocess.call([sys.executable, "scripts/gpu-lifecycle-preflight.py"], cwd=ROOT)

    if os.geteuid() != 0:
        raise RuntimeError("run on the existing root-admin app host to restore the protected app env")
    app_env = ROOT / ".env"
    if not app_env.is_file():
        raise RuntimeError("existing app .env missing; no GPU allocation")
    load_scoped_env(app_env)
    load_scoped_env(ROOT / ".env.deploy")
    os.environ["VAST_APP_ENV"] = str(app_env)
    os.environ.setdefault("VAST_STATE_DIR", "/data/vast-fleet")
    if not os.environ.get("VAST_API_KEY"):
        raise RuntimeError("VAST_API_KEY unavailable on app host; no GPU allocation")
    for key in ("HCLOUD_TOKEN", "STUDIO_ACCESS_TOKEN", "AI_POD_TOKEN",
                "GHCR_USERNAME", "GHCR_PASSWORD", "CFS3_ACCESS_KEY",
                "CFS3_SECRET_KEY", "CFS3_BUCKET"):
        if not os.environ.get(key):
            raise RuntimeError(key + " unavailable on app host; no GPU allocation")
    compose = verified_app_compose()
    install_30m_teardown_watchdog()
    # All model archives, role identifiers and pins must exist BEFORE renting.
    run(["scripts/gpu-lifecycle-preflight.py", "--check-r2"])
    run(["scripts/gpu-pods.py", "preflight"])
    snapshot = ROOT / ".env.vast-prestart"
    shutil.copy2(app_env, snapshot)
    snapshot.chmod(0o600)
    try:
        run(["scripts/gpu-pods.py", "up", "--yes"])
        # gpu-pods.py must write ready URLs and trusted CA into the same app host.
        active = app_env.read_text()
        if "AI_GPU_PROVIDER=vast" not in active or "NODE_EXTRA_CA_CERTS=" not in active:
            raise RuntimeError("Vast endpoints not promoted; delete rental rather than silently bill")
        restart_app(compose)
        if not app_ready():
            raise RuntimeError("app health after Vast promotion failed")
        print("OK: eight attested Vast roles connected to current app host", flush=True)
        return 0
    except BaseException:
        # The app stays usable in its previous state even if the paid fleet fails.
        shutil.copy2(snapshot, app_env)
        app_env.chmod(0o600)
        try:
            restart_app(compose)
        except Exception:
            pass
        try:
            run(["scripts/gpu-pods.py", "down", "--yes"])
        except Exception:
            print("CRITICAL: GPU delete not confirmed; reconcile Vast instances immediately",
                  file=sys.stderr, flush=True)
        raise


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print("Vast host bootstrap blocked/failed: " + type(exc).__name__, file=sys.stderr)
        raise SystemExit(4)
