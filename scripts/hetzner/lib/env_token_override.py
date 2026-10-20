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

OVERRIDE_KEYS = ("STUDIO_ACCESS_TOKEN", "SCRAPE_TOKEN", "AI_MODE", "CF_DNS_API_TOKEN")

#: CF_DNS_API_TOKEN (DNS-01 fuer Caddy auf sfu-1, docker-compose.hetzner.yml:86)
#: steht nicht unter diesem Namen in .env.deploy - dort heisst der Token mit
#: Zone:DNS:Edit CLOUDFLARE_API_TOKEN. Der Alias wird hier gebildet statt in
#: einer zweiten Datei gepflegt zu werden. Gemessen 2026-10-20: ohne den
#: Alias crashte Caddy auf dem FRISCHEN Knoten im Restart-Loop
#: ('acme_dns: missing API token', Caddyfile.sfu:42) und nahm RTP-/Stress-
#: Tests mit (Port 8000 tot, ERR_CONNECTION_REFUSED).
ALIASES = {"CF_DNS_API_TOKEN": "CLOUDFLARE_API_TOKEN"}


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
                if value and key not in found and (key in OVERRIDE_KEYS or key in ALIASES.values()):
                    found[key] = value
    except FileNotFoundError:
        print(f"env_token_override: {env_file} nicht gefunden", file=sys.stderr)
        return 1
    for key, source in ALIASES.items():
        if key not in found:
            alias_value = found.get(source) or ""
            if alias_value:
                found[key] = alias_value
    missing = [key for key in OVERRIDE_KEYS if key not in found]
    if missing:
        print(f"env_token_override: fehlt in {env_file}: {', '.join(missing)}", file=sys.stderr)
        return 1
    for key in OVERRIDE_KEYS:
        print(f"{key}={found[key]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
