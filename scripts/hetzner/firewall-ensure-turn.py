#!/usr/bin/env python3
"""Sichert die TURN-Ports der Rolle sfu in der Hetzner-Firewall (idempotent).

Warum: `services/portal-worker/src/index.js` (firewallRules) und
`scripts/hetzner/provision.py` erwarten fuer die Rolle sfu die Ports 3478
udp/tcp (coturn-Signalisierung) und 49152-49201 udp/tcp (Relay). Die LIVE
Firewall der Flotte hatte am 2026-09-20 nur 22/80/443/ICMP + RTP 40000-40099 -
ohne diese vier Regeln kann kein Browser einen TURN-Relay aufbauen, egal wie
korrekt die Anwendung konfiguriert ist.

Das Skript liest HCLOUD_TOKEN aus .env.deploy, holt die Firewall des Knotens
ueber die IP (Server -> firewall-IDs), vergleicht die IN-Regeln und schreibt
per POST /firewalls/{id}/actions/set_rules nur, wenn Regeln fehlen. Ohne
`--apply` wird nichts geschrieben (Trockenlauf).

Aufruf:
  python3 scripts/hetzner/firewall-ensure-turn.py                 # Trockenlauf
  python3 scripts/hetzner/firewall-ensure-turn.py --apply         # schreiben
  python3 scripts/hetzner/firewall-ensure-turn.py --ip <sfu-ip>   # anderer Knoten
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
DEFAULT_IP = "142.132.231.146"  # sfu-1
#: Muss identisch mit portal-worker/firewallRules und provision.py sein.
TURN_RULES = (
    {"direction": "in", "protocol": "udp", "port": "3478", "source_ips": ["0.0.0.0/0", "::/0"]},
    {"direction": "in", "protocol": "tcp", "port": "3478", "source_ips": ["0.0.0.0/0", "::/0"]},
    {"direction": "in", "protocol": "udp", "port": "49152-49201", "source_ips": ["0.0.0.0/0", "::/0"]},
    {"direction": "in", "protocol": "tcp", "port": "49152-49201", "source_ips": ["0.0.0.0/0", "::/0"]},
)


def token() -> str:
    for line in (REPO / ".env.deploy").read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if line.startswith("HCLOUD_TOKEN="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    return ""


def api(path: str, tok: str, method: str = "GET", payload: dict | None = None) -> dict:
    """Hetzner-Cloud-REST (Fehler als {"_error", "_body"}) - Transport in scripts/lib.

    Die Fehlergrenze von 300 Zeichen ist hier historisch gewachsen und bleibt.
    """
    return hcloud_api(path, tok, method, payload, detail_limit=300)


def rule_key(rule: dict) -> tuple:
    return (
        rule.get("direction"),
        rule.get("protocol"),
        rule.get("port") or "",
        tuple(sorted(rule.get("source_ips") or [])),
    )


def main() -> int:
    args = sys.argv[1:]
    apply_changes = "--apply" in args
    ip = DEFAULT_IP
    if "--ip" in args:
        ip = args[args.index("--ip") + 1]

    tok = token()
    if not tok:
        print("HCLOUD_TOKEN fehlt in .env.deploy")
        return 1

    servers = api("/servers?per_page=50", tok).get("servers", [])
    server = next((s for s in servers if (s.get("public_net", {}).get("ipv4") or {}).get("ip") == ip), None)
    if server is None:
        print(f"Kein Server mit IP {ip} gefunden")
        return 1
    print(f"Server {server['name']} (id={server['id']}) IP={ip}")

    firewalls = api("/firewalls?per_page=50", tok).get("firewalls", [])
    relevant = []
    for fw in firewalls:
        detail = api(f"/firewalls/{fw['id']}", tok).get("firewall", {})
        for applied in detail.get("applied_to", []) or []:
            if (applied.get("server") or {}).get("id") == server["id"]:
                relevant.append((fw, detail))
    if not relevant:
        print("Keine Firewall auf diesen Server angewendet - nichts zu tun.")
        return 0

    changed = False
    for fw, detail in relevant:
        rules = detail.get("rules", [])
        have = {rule_key(r) for r in rules}
        missing = [r for r in TURN_RULES if rule_key(r) not in have]
        print(f"Firewall {fw['name']} (id={fw['id']}): {len(rules)} Regeln, fehlend: "
              f"{[f'{r['protocol']}/{r['port']}' for r in missing] or 'keine'}")
        if not missing:
            continue
        payload = {"rules": rules + missing}
        if not apply_changes:
            print("   Trockenlauf: set_rules wuerde die 4 fehlenden Regeln ergaenzen.")
            changed = True
            continue
        result = api(f"/firewalls/{fw['id']}/actions/set_rules", tok, "POST", payload)
        if "_error" in result:
            print("   FEHLER:", result["_error"], result.get("_body", ""))
            return 1
        actions = result.get("actions") or []
        print(f"   gesetzt: {len(actions)} Action(s) -> Status {[a.get('status') for a in actions]}")
        after = api(f"/firewalls/{fw['id']}", tok).get("firewall", {}).get("rules", [])
        print(f"   Kontrolle: {len(after)} Regeln, TURN vorhanden: "
              f"{[f'{r['protocol']}/{r['port']}' for r in TURN_RULES if rule_key(r) not in {rule_key(x) for x in after}] or 'alle'}")
        changed = True
    if not changed:
        print("Nichts zu tun (idempotent).")
    elif not apply_changes:
        print("Trockenlauf beendet - mit --apply schreiben.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
