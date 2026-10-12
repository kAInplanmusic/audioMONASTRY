#!/usr/bin/env python3
"""Knoten der laufenden Flotte ueber den ROLLENNAMEN finden (eine Konvention, eine Quelle).

WARUM: die Firewall-Werkzeuge trugen die Knoten-IPs als feste Defaults. Nach einem
Neuaufbau zeigten sie damit auf die VORHERIGE Flotte - dokumentierte Fehlerklasse
(INFRA-HETZNER-014, INFRA-HETZNER-021): mit einem alten Default findet die
Server-Suche keinen Knoten (das Werkzeug bricht ab, statt zu arbeiten), und waere
die alte IP einmal wieder vergeben, traefe die Regel den falschen Rechner.

Die IP wird deshalb aus dem Rollennamen abgeleitet: ``{PREFIX}{rolle}-1``.
Dieselbe Konvention nutzen ``scripts/hetzner/fleet-names.sh`` (FLEET_PREFIX,
Default ``audiomonastry-``) und ``scripts/hetzner/firewall-ensure.py``.

Rollen ohne Knoten werden GEMELDET, nicht geraten: die Werkzeuge setzen
``fleet_report()`` in ihre Fehlermeldung, damit im Log steht, welche Knoten es
tatsaechlich gibt.
"""
from __future__ import annotations

import os
from typing import Any, Iterable, Optional

#: Namenspraefix der Knoten (identisch zu fleet-names.sh und firewall-ensure.py).
PREFIX_DEFAULT = "audiomonastry-"


def prefix(override: Optional[str] = None) -> str:
    """Praefix: Argument > Umgebung (``FLEET_PREFIX``) > Default."""
    return override or os.environ.get("FLEET_PREFIX") or PREFIX_DEFAULT


def server_name(role: str, prefix_override: Optional[str] = None) -> str:
    """Knotenname einer Rolle, z. B. ``sfu`` -> ``audiomonastry-sfu-1``."""
    return f"{prefix(prefix_override)}{role}-1"


def find_node(
    servers: Optional[Iterable[dict]], role: str, prefix_override: Optional[str] = None
) -> Optional[dict]:
    """Server-Datensatz dieser Rolle oder ``None`` (kein Raten)."""
    wanted = server_name(role, prefix_override)
    for server in servers or []:
        if str(server.get("name")) == wanted:
            return server
    return None


def node_ipv4(servers: Optional[Iterable[dict]], role: str, prefix_override: Optional[str] = None) -> str:
    """IPv4 des Knotens dieser Rolle oder ``''`` (dann wird gemeldet, nicht geraten)."""
    node = find_node(servers, role, prefix_override)
    if not node:
        return ""
    return str(((node.get("public_net") or {}).get("ipv4") or {}).get("ip") or "")


def fleet_report(servers: Optional[Iterable[dict]]) -> str:
    """Klartext der LAUFENDEN Flotte fuer Fehlermeldungen."""
    parts = []
    for server in sorted(servers or [], key=lambda s: str(s.get("name"))):
        ip = str(((server.get("public_net") or {}).get("ipv4") or {}).get("ip") or "keine IPv4")
        parts.append(f"{server.get('name')}={ip}({server.get('status', '?')})")
    return ", ".join(parts) or "keine Server im Konto"


def as_roles(servers: Optional[Iterable[dict]], prefix_override: Optional[str] = None) -> dict[str, Any]:
    """{Rolle: IPv4} fuer alle Knoten, die der Namenskonvention folgen (Diagnose)."""
    pre = prefix(prefix_override)
    out: dict[str, Any] = {}
    for server in servers or []:
        name = str(server.get("name") or "")
        if not name.startswith(pre):
            continue
        role = name[len(pre):]
        if role.endswith("-1"):
            role = role[:-2]
        out[role] = str(((server.get("public_net") or {}).get("ipv4") or {}).get("ip") or "")
    return out
