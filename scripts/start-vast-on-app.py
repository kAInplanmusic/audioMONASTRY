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
    for key in ("AI_POD_TOKEN", "GHCR_USERNAME", "GHCR_PASSWORD", "CFS3_ACCESS_KEY",
                "CFS3_SECRET_KEY", "CFS3_BUCKET"):
        if not os.environ.get(key):
            raise RuntimeError(key + " unavailable on app host; no GPU allocation")
    compose = verified_app_compose()
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
