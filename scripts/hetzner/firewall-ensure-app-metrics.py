#!/usr/bin/env python3
"""Erlaubt dem Monitoring-Knoten den direkten Scrape der App-Metriken.

Warum das noetig ist (live gemessen 2026-09-20): `prometheus.yml` fragt den Job
`audiomonastry` ueber `APP_TARGET` ab - Default ist die Produktions-Domain
(`https://anunnakitools.de/api/metrics`). Solange die Cloudflare-Kette steht,
ist das sinnvoll; ist sie gestoert (F1: origin-DNS + Token), meldet Prometheus
`health=down, HTTP 521` und die App-Metrik ist blind - obwohl die App laeuft.
Die App-firewall erlaubt ausserdem nur Cloudflare-CIDRs auf 80/443, ein
Monitoring-Knoten kommt also gar nicht durch.

Loesung: die App-firewall oeffnet ihren Metrik-Port (Default 8080) NUR fuer den
Monitoring-Knoten; `APP_SCHEME=http`, `APP_TARGET=<app-ip>:8080` auf edge-1. Der
Scrape laeuft dann direkt gegen den Container - unabhaengig von DNS, Worker und
Zertifikaten. Geschuetzt bleibt er durch `SCRAPE_TOKEN` (fail-closed).

Aufruf:
  python3 scripts/hetzner/firewall-ensure-app-metrics.py                      # Trockenlauf
  python3 scripts/hetzner/firewall-ensure-app-metrics.py --apply              # schreiben
  python3 scripts/hetzner/firewall-ensure-app-metrics.py --port 8080 --from-ip <edge-ip>
"""
from __future__ import annotations

import json
import pathlib
import sys
import urllib.error
import urllib.request

REPO = pathlib.Path(__file__).resolve().parent.parent.parent

# Gemeinsame Helfer aus scripts/lib/ (Pfad relativ zur eigenen Datei, damit das
# Skript direkt UND per importlib aus tests/ laeuft).
_LIB = pathlib.Path(__file__).resolve().parents[1] / "lib"
if str(_LIB) not in sys.path:
    sys.path.insert(0, str(_LIB))
from restclient import hcloud_api  # noqa: E402
APP_IP = "142.132.229.71"
EDGE_IP = "167.233.192.196"
METRICS_PORT = "8080"


def token() -> str:
    for line in (REPO / ".env.deploy").read_text(encoding="utf-8", errors="replace").splitlines():
        if line.startswith("HCLOUD_TOKEN="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    return ""


def api(path: str, tok: str, method: str = "GET", payload: dict | None = None) -> dict:
    """Hetzner-Cloud-REST (Fehler als {"_error", "_body"}) - Transport in scripts/lib."""
    return hcloud_api(path, tok, method, payload)


def key(rule: dict) -> tuple:
    return (rule.get("direction"), rule.get("protocol"), rule.get("port") or "", tuple(sorted(rule.get("source_ips") or [])))


def main() -> int:
    args = sys.argv[1:]
    apply_changes = "--apply" in args
    port = args[args.index("--port") + 1] if "--port" in args else METRICS_PORT
    source_ip = args[args.index("--from-ip") + 1] if "--from-ip" in args else EDGE_IP
    app_ip = args[args.index("--app-ip") + 1] if "--app-ip" in args else APP_IP

    tok = token()
    if not tok:
        print("HCLOUD_TOKEN fehlt in .env.deploy")
        return 1

    servers = api("/servers?per_page=50", tok).get("servers", [])
    app = next((s for s in servers if (s.get("public_net", {}).get("ipv4") or {}).get("ip") == app_ip), None)
    if app is None:
        print(f"Kein Server mit IP {app_ip}")
        return 1
    print(f"App-Knoten: {app['name']} ({app_ip}), Quelle: {source_ip}/32, Port: {port}/tcp")

    firewalls = api("/firewalls?per_page=50", tok).get("firewalls", [])
    relevant = []
    for fw in firewalls:
        detail = api(f"/firewalls/{fw['id']}", tok).get("firewall", {})
        if any((a.get("server") or {}).get("id") == app["id"] for a in (detail.get("applied_to") or [])):
            relevant.append((fw, detail))
    if not relevant:
        print("Keine Firewall am App-Knoten - nichts zu tun.")
        return 0

    wanted = {"direction": "in", "protocol": "tcp", "port": port, "source_ips": [f"{source_ip}/32"]}
    changed = False
    for fw, detail in relevant:
        rules = detail.get("rules", [])
        have = {key(r) for r in rules}
        if key(wanted) in have:
            print(f"Firewall {fw['name']}: Regel {port}/tcp von {source_ip}/32 ist schon da (idempotent).")
            continue
        conflicting = [r for r in rules if r.get("port") == port and r.get("direction") == "in"]
        for other in conflicting:
            if set(other.get("source_ips") or []) == {"0.0.0.0/0", "::/0"}:
                print(f"  HINWEIS: {port}/tcp ist bereits fuer ALLE offen ({fw['name']}) - die Quelle wird nicht eingeschraenkt.")
        if not apply_changes:
            print(f"Firewall {fw['name']} (id={fw['id']}): wuerde {port}/tcp fuer {source_ip}/32 oeffnen.")
            changed = True
            continue
        result = api(f"/firewalls/{fw['id']}/actions/set_rules", tok, "POST", {"rules": rules + [wanted]})
        if "_error" in result:
            print("FEHLER:", result["_error"], result.get("_body", ""))
            return 1
        after = api(f"/firewalls/{fw['id']}", tok).get("firewall", {}).get("rules", [])
        present = any(key(r) == key(wanted) for r in after)
        print(f"Firewall {fw['name']}: gesetzt ({len(rules)} -> {len(after)} Regeln), Kontrolle: {'OK' if present else 'FEHLT'}")
        changed = True

    if not changed:
        print("Nichts zu tun (idempotent).")
    elif not apply_changes:
        print("Trockenlauf beendet - mit --apply schreiben.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
