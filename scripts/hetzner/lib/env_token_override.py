#!/usr/bin/env python3
"""INFRA-HETZNER-027 (2): Portal-konsistente Tokens aus .env.deploy.

Schreibt (nur auf stdout) die Zeilen STUDIO_ACCESS_TOKEN/SCRAPE_TOKEN aus der
Deploy-Env. bring-up-fleet.sh sync_env nutzt das, um auf ALLEN Knoten dieselben
Tokens zu setzen - das Repo-.env haelt davon verschiedene Werte, und der
Portal-Worker validiert gegen die .env.deploy-Variante (gemessen 2026-10-18:
/api/fleet-map 200 nur mit dem .env.deploy-Token).

Die Werte werden nie geloggt: der Aufrufer pipet stdout direkt in eine Datei
bzw. per ssh-stdin auf den Knoten.
"""
from __future__ import annotations

import os
import sys

OVERRIDE_KEYS = ("STUDIO_ACCESS_TOKEN", "SCRAPE_TOKEN")


def main() -> int:
    env_file = os.environ.get("DEPLOY_ENV_FILE", ".env.deploy")
    found: dict[str, str] = {}
    try:
        with open(env_file, encoding="utf-8") as handle:
            for raw in handle:
                line = raw.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                if key in OVERRIDE_KEYS and value and key not in found:
                    found[key] = value
    except FileNotFoundError:
        print(f"env_token_override: {env_file} nicht gefunden", file=sys.stderr)
        return 1
    missing = [key for key in OVERRIDE_KEYS if key not in found]
    if missing:
        print(f"env_token_override: fehlt in {env_file}: {', '.join(missing)}", file=sys.stderr)
        return 1
    for key in OVERRIDE_KEYS:
        print(f"{key}={found[key]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
