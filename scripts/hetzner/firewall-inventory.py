#!/usr/bin/env python3
"""Firewall-Inventar der Hetzner-Flotte (nur GET) + Abgleich mit den RTC-Ports.

Liest HCLOUD_TOKEN aus .env.deploy des Repos, ruft GET /firewalls ab und zeigt
je Firewall die Regeln. Zusaetzlich wird gemeldet, ob die fuer die SFU-Rolle
erwarteten TURN-/RTP-Ports fehlen (Quelle: services/portal-worker/src/index.js
und scripts/hetzner/provision.py - dieselben Zahlen, eine Wahrheit).
Gibt NIE Token-Werte aus.
"""
from __future__ import annotations

import json
import pathlib
import sys
import urllib.error
import urllib.request

#: Repo-Wurzel aus der Lage DIESER Datei (scripts/hetzner/ -> zwei Ebenen hoch),
#: nicht als absoluter Pfad: das Repo wurde am 2026-09-23 verschoben.
REPO = pathlib.Path(__file__).resolve().parents[2]
#: Ports, die eine sfu-Rolle laut Repo offen haben muss (Protokoll, Port)
EXPECTED_SFU = (
    ("udp", "3478"),
    ("tcp", "3478"),
    ("udp", "49152-49201"),
    ("tcp", "49152-49201"),
)


def token() -> str:
    for line in (REPO / ".env.deploy").read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if line.startswith("HCLOUD_TOKEN="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    return ""


def get(path: str, tok: str) -> dict:
    request = urllib.request.Request(
        f"https://api.hetzner.cloud/v1{path}", headers={"Authorization": f"Bearer {tok}"}
    )
    try:
        with urllib.request.urlopen(request, timeout=25) as response:
            return json.loads(response.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as error:
        return {"_error": f"HTTP {error.code}", "_body": error.read().decode("utf-8", "replace")[:200]}


def main() -> int:
    tok = token()
    if not tok:
        print("HCLOUD_TOKEN fehlt in .env.deploy")
        return 1
    data = get("/firewalls?per_page=50", tok)
    if "_error" in data:
        print("Fehler:", data["_error"], data.get("_body", ""))
        return 1
    for fw in data.get("firewalls", []):
        rules = fw.get("rules", [])
        print(f"Firewall id={fw['id']} name={fw['name']} Regeln={len(rules)}")
        ports = set()
        for rule in rules:
            port = rule.get("port") or "-"
            prot = rule.get("protocol")
            if rule.get("direction") == "in":
                ports.add((prot, port))
            srcs = ",".join(rule.get("source_ips") or [])
            print(f"   {rule.get('direction'):8s} {prot:4s} port={port:20s} src={srcs[:70]}")
        servers = [
            s.get("name")
            for s in get(f"/firewalls/{fw['id']}", tok).get("firewall", {}).get("applied_to", [])
        ]
        print(f"   angewendet auf: {', '.join(str(s) for s in servers) or '-'}")
        if any("sfu" in str(s) for s in servers):
            missing = [f"{p}/{port}" for p, port in EXPECTED_SFU if (p, port) not in ports]
            print(f"   SFU-Ports fehlend: {missing or 'keine'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
