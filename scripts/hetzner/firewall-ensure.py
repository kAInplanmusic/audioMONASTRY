#!/usr/bin/env python3
"""Cross-Node-Firewall-Regeln der Flotte auf die TATSAECHLICHEN Knoten-IPs ziehen.

BEFUND (live gemessen 2026-09-21, SSOT-Item INFRA-HETZNER-014): Nach dem
Neuaufbau der Flotte (neue IPs) trugen drei Hetzner-Firewalls noch die
Quell-IPs der VORHERIGEN Flotte:

  * `audiomonastry-app`    – 8080 nur von 167.233.192.196/32 (alte edge-1)
  * `audiomonastry-ai`     – 8000 + 11434 nur von 142.132.229.71/32 (alte app-1)
  * `audiomonastry-master` – 8000 nur von derselben alten app-1-IP

Folge: der Querverkehr edge->app:8080 (Monitoring-Scrape), app->ai:8000/11434
(Stem-AI/Ollama) und app->master:8000 (master-player) war stumm blockiert –
von aussen unsichtbar, weil alles Oeffentliche ueber Cloudflare laeuft. Die
Regeln entstehen beim Provisionieren/Verdrahten aus festen Werten, deshalb
wiederholt sich der Drift bei JEDEM Neuaufbau.

Dieses Werkzeug leitet den Soll-Zustand aus der LAUFENDEN Flotte ab (Knoten-
Namen -> IPv4) und ersetzt NUR die veralteten Quell-IPs. Jede andere Regel –
auch ICMP, Ports und die Cloudflare-IP-Bereiche – bleibt unveraendert und wird
beim Ruecklesen belegt. Es ist idempotent: sind alle Quell-IPs aktuell, faellt
kein einziger Schreibaufruf an.

Soll-Vertrag (Rolle -> Firewall -> Ports; Quelle = IP des Knotens):
  * Firewall {PREFIX}app    tcp/8080  <- edge-1   (Monitoring-Scrape)
  * Firewall {PREFIX}ai     tcp/8000  <- app-1    (Stem-AI)
  * Firewall {PREFIX}ai     tcp/11434 <- app-1    (Ollama)
  * Firewall {PREFIX}master tcp/8000  <- app-1    (master-player)

Grenze: dieses Werkzeug LEGT KEINE Regeln AN und LOESCHT KEINE. Fehlt eine
Regel ganz, wird das gemeldet (Exit bleibt 0) – ob ein Port offen sein soll,
entscheidet der Verdrahtungs-Pfad (Portal-Worker `/api/wire-fleet` bzw.
scripts/hetzner/firewall-ensure-*.py). Rollen, die es in der laufenden Flotte
nicht gibt, werden gemeldet statt geraten (Exit != 0, weil der Soll-Zustand
dann nicht ableitbar ist).

Aufruf:
  python3 scripts/hetzner/firewall-ensure.py               # abgleichen + anwenden
  python3 scripts/hetzner/firewall-ensure.py --dry-run     # Plan zeigen, nichts schreiben
  python3 scripts/hetzner/firewall-ensure.py --print-config  # netzfrei: Soll-Zuordnung + Env-Datei

Der Token (HCLOUD_TOKEN aus der Umgebung oder der Env-Datei) wird NIE
ausgegeben – nur als Laenge + Fingerabdruck.

Abschalten im Flottenstart: FLEET_FIREWALL_ENSURE=0 bash scripts/hetzner/bring-up-fleet.sh

Umgebung: HCLOUD_TOKEN, HCLOUD_ENV_FILE (Default: <repo>/.env.deploy),
HCLOUD_API_BASE (fuer Teststubs), FLEET_PREFIX (Default audiomonastry-).
"""
from __future__ import annotations

import hashlib
import json
import os
import pathlib
import sys
import urllib.error
import urllib.request

REPO = pathlib.Path(__file__).resolve().parent.parent.parent
#: API-Basis ist umstellbar, damit Tests gegen einen lokalen Stub fahren koennen -
#: ohne diesen Schalter waere "kein Test spricht mit Hetzner" nicht pruefbar.
API = os.environ.get("HCLOUD_API_BASE", "https://api.hetzner.cloud/v1").rstrip("/")
ENV_FILE = pathlib.Path(os.environ.get("HCLOUD_ENV_FILE") or (REPO / ".env.deploy"))
#: Namenspraefix der Knoten (dieselbe Konvention wie scripts/hetzner/fleet-names.sh).
PREFIX = os.environ.get("FLEET_PREFIX") or "audiomonastry-"

#: Exit-Vertrag (alles ungleich 0 ist ein Befund, kein Erfolg).
EXIT_OK = 0
EXIT_KONFIG = 1          # Token fehlt oder Soll-Zustand nicht ableitbar (Rolle fehlt)
EXIT_API = 2             # API-Fehler (HTTP/Netz)
EXIT_GEGENPROBE = 3      # frisch zurueckgelesener Zustand weicht vom Ziel ab

#: Soll-Vertrag: (Firewall-Suffix, Port, Rolle, deren IPv4 die einzige Quelle sein muss).
#: Reihenfolge = Ausgabereihenfolge. Die Zahlen sind identisch mit
#: services/portal-worker/src/index.js (firewallRules/openFleetPorts).
CONTRACT = (
    ("app", "8080", "edge"),
    ("ai", "8000", "app"),
    ("ai", "11434", "app"),
    ("master", "8000", "app"),
)


def firewall_name(suffix: str) -> str:
    return f"{PREFIX}{suffix}"


def server_name(role: str) -> str:
    return f"{PREFIX}{role}-1"


def token_source() -> tuple[str, str]:
    """HCLOUD_TOKEN lesen: Umgebung schlaegt Env-Datei. Rueckgabe (Token, Quelle)."""
    from_env = (os.environ.get("HCLOUD_TOKEN") or "").strip()
    if from_env:
        return from_env, "Umgebung"
    if ENV_FILE.is_file():
        for line in ENV_FILE.read_text(encoding="utf-8", errors="replace").splitlines():
            line = line.strip()
            if line.startswith("HCLOUD_TOKEN="):
                return line.split("=", 1)[1].strip().strip('"').strip("'"), str(ENV_FILE)
    return "", ""


def fingerprint(tok: str) -> str:
    """Fingerabdruck des Tokens - der Wert selbst erscheint nie in der Ausgabe."""
    return hashlib.sha256(tok.encode("utf-8")).hexdigest()[:8]


def api(path: str, tok: str, method: str = "GET", payload: dict | None = None) -> dict:
    body = json.dumps(payload).encode("utf-8") if payload is not None else None
    request = urllib.request.Request(
        f"{API}{path}", data=body, method=method,
        headers={
            "Authorization": f"Bearer {tok}",
            "Content-Type": "application/json",
            "User-Agent": "audioMONASTRY/1.0",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            raw = response.read().decode("utf-8", "replace")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as error:
        return {"_error": f"HTTP {error.code}", "_body": error.read().decode("utf-8", "replace")[:250]}
    except urllib.error.URLError as error:
        return {"_error": f"Netzwerkfehler: {error.reason}"}


def get_all(resource: str, tok: str) -> list[dict]:
    """Ressource vollstaendig lesen (Hetzner paginiert mit 50 je Seite)."""
    items: list[dict] = []
    page = 1
    while True:
        data = api(f"/{resource}?page={page}&per_page=50", tok)
        if "_error" in data:
            raise ApiError(f"{data['_error']} {data.get('_body', '')}".strip())
        batch = data.get(resource) or []
        items.extend(batch)
        meta = (data.get("meta") or {}).get("pagination") or {}
        if page >= int(meta.get("last_page", page) or page):
            return items
        page += 1


class ApiError(RuntimeError):
    """API-Antwort war nicht verwertbar - wird als Exit 2 gemeldet."""


def node_ipv4(servers: list[dict], role: str) -> str:
    """IPv4 des Knotens dieser Rolle oder '' (dann wird gemeldet, nicht geraten)."""
    wanted = server_name(role)
    for server in servers:
        if server.get("name") == wanted:
            return (((server.get("public_net") or {}).get("ipv4") or {}).get("ip") or "")
    return ""


def is_ipv4_host(entry: str) -> bool:
    """True fuer eine einzelne IPv4-Adresse (mit oder ohne /32)."""
    host = str(entry).split("/", 1)[0]
    parts = host.split(".")
    if len(parts) != 4:
        return False
    for part in parts:
        if not part.isdigit() or not 0 <= int(part) <= 255:
            return False
    return ":" not in str(entry)  # IPv6 ausschliessen


def canonical(rule: dict) -> tuple:
    """Vergleichsform einer Regel (Reihenfolge der Quellen zaehlt nicht)."""
    return (
        rule.get("direction"),
        rule.get("protocol"),
        rule.get("port") or "",
        tuple(sorted(str(s) for s in (rule.get("source_ips") or []))),
        rule.get("description") or "",
    )


def rule_set(rules: list[dict]) -> list[tuple]:
    return sorted(canonical(rule) for rule in rules)


def contract_ports(suffix: str) -> dict[str, str]:
    """Port -> Quellrolle fuer diese Firewall (nur In/tcp-Regeln des Vertrags)."""
    return {port: role for fw_suffix, port, role in CONTRACT if fw_suffix == suffix}


def plan_firewall(firewall: dict, ips: dict[str, str]) -> dict:
    """Soll/Ist einer Firewall vergleichen - OHNE zu schreiben.

    Ersetzt ausschliesslich die Quell-IPv4-Eintraege (Host oder /32) der
    Vertrags-Ports durch die IP des zustaendigen Knotens. Alles andere - ICMP,
    andere Ports, Cloudflare-CIDRs, IPv6-Quellen, Beschreibungen - wird
    unveraendert uebernommen.
    """
    name = str(firewall.get("name", ""))
    suffix = name[len(PREFIX):] if name.startswith(PREFIX) else name
    ports = contract_ports(suffix)
    changes: list[str] = []
    hints: list[str] = []
    seen_ports: set[str] = set()
    new_rules: list[dict] = []
    changed = False

    for rule in firewall.get("rules") or []:
        port = str(rule.get("port") or "")
        role = ports.get(port) if rule.get("direction") == "in" and rule.get("protocol") == "tcp" else None
        if role is None:
            new_rules.append(dict(rule))          # fremde Regel: zeichengleich uebernehmen
            continue
        seen_ports.add(port)
        ip = ips.get(role, "")
        wanted = f"{ip}/32"
        current = [str(s) for s in (rule.get("source_ips") or [])]
        if ip and wanted in current:
            new_rules.append(dict(rule))          # schon aktuell: unveraendert
            continue
        if "0.0.0.0/0" in current:
            # Offene Regel NICHT einschraenken - das waere eine Aenderung der
            # Bedeutung, nicht ein IP-Wechsel (non-destruktiv).
            new_rules.append(dict(rule))
            hints.append(
                f"tcp/{port}: fuer ALLE offen (0.0.0.0/0) - Regel unveraendert, "
                f"die Quelle wird bewusst nicht eingeschraenkt"
            )
            continue
        replaced = [wanted if is_ipv4_host(entry) else entry for entry in current]
        if replaced != current and ip:
            neu = dict(rule)
            neu["source_ips"] = replaced
            new_rules.append(neu)
            changed = True
            for before, after in zip(current, replaced):
                if before != after:
                    changes.append(f"tcp/{port}: {before} -> {after}  (Quelle: Knoten {server_name(role)})")
        else:
            # Nicht ersetzbar (keine IPv4-/32-Quelle) - nichts anfassen, nur melden.
            new_rules.append(dict(rule))
            hints.append(
                f"tcp/{port}: keine ersetzbare IPv4-Quelle vorhanden "
                f"(aktuell: {', '.join(current) or '-'}) - Regel unveraendert, Soll waere "
                f"{wanted if ip else 'IP von ' + server_name(role) + ' (unbekannt)'}"
            )

    for port, role in ports.items():
        if port not in seen_ports:
            hints.append(
                f"tcp/{port}: Regel fehlt auf dieser Firewall - dieses Werkzeug legt keine Regeln an "
                f"(Soll-Quelle waere die IP von {server_name(role)}). Der Verdrahtungs-Pfad setzt sie."
            )

    return {
        "id": firewall.get("id"),
        "name": firewall.get("name"),
        "changes": changes,
        "hints": hints,
        "rules": new_rules,
        "changed": changed,
        "checked": len(seen_ports),
    }


def print_contract() -> None:
    """Soll-Zuordnung ohne Netz und ohne Token."""
    print("Soll-Zuordnung (Quelle ist die IPv4 des Knotens, abgeleitet aus GET /servers):")
    for fw_suffix, port, role in CONTRACT:
        print(f"  Firewall {firewall_name(fw_suffix):<24} tcp/{port:<6} Quelle: {server_name(role)}")
    tok, source = token_source()
    hinweis = "vorhanden" if tok else "NICHT gesetzt"
    print(f"  Env-Datei:   {ENV_FILE}")
    print(f"  Token:       {hinweis} (Quelle: {source or 'weder Umgebung noch Env-Datei'}; Wert wird nie ausgegeben)")
    print(f"  Namenspraefix: {PREFIX}   (Rollen ohne Knoten werden gemeldet, nicht geraten)")
    print("  Abgleich im Flottenstart: Schritt 3/9 von scripts/hetzner/bring-up-fleet.sh")
    print("  Abschalten:  FLEET_FIREWALL_ENSURE=0 bash scripts/hetzner/bring-up-fleet.sh")


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    dry_run = "--dry-run" in args

    if "--print-config" in args or "--help" in args or "-h" in args:
        print_contract()
        return EXIT_OK

    tok, source = token_source()
    if not tok:
        print("HCLOUD_TOKEN fehlt (Umgebung oder Env-Datei).")
        print(f"  erwartete Env-Datei: {ENV_FILE}")
        return EXIT_KONFIG
    print(f"Token: gesetzt (Laenge {len(tok)}, Fingerabdruck {fingerprint(tok)}, Quelle: {source})")

    try:
        servers = get_all("servers", tok)
        firewalls = get_all("firewalls", tok)
    except ApiError as error:
        print(f"FEHLER beim Lesen der Flotte: {error}")
        return EXIT_API

    rollen = sorted({role for _suffix, _port, role in CONTRACT})
    ips: dict[str, str] = {}
    print("Knoten der laufenden Flotte:")
    fehlend: list[str] = []
    for role in rollen:
        ip = node_ipv4(servers, role)
        if ip:
            ips[role] = ip
            print(f"  {server_name(role):<26} {ip}")
        else:
            fehlend.append(role)
            print(f"  {server_name(role):<26} FEHLT (keine oeffentliche IPv4 gefunden)")
    if fehlend:
        # Soll-Zustand nicht ableitbar: melden statt raten (Exit != 0).
        print(
            "FEHLER: Soll-Zustand nicht ableitbar - Knoten fehlen: "
            + ", ".join(server_name(role) for role in fehlend)
        )
        return EXIT_KONFIG

    vertraglich = {firewall_name(suffix) for suffix, _port, _role in CONTRACT}
    plaene = [
        plan_firewall(fw, ips)
        for fw in firewalls
        if str(fw.get("name", "")) in vertraglich
    ]

    geprueft = sum(plan["checked"] for plan in plaene)
    geaendert = 0
    gegenprobe_fehler = False
    ids: list[str] = []

    for plan in plaene:
        ids.append(f"{plan['name']}={plan['id']}")
        if not plan["changes"] and not plan["hints"]:
            print(f"Firewall {plan['name']} (id {plan['id']}): alle Quell-IPs aktuell")
            continue
        print(f"Firewall {plan['name']} (id {plan['id']}):")
        for change in plan["changes"]:
            print(f"  {change}")
        for hint in plan["hints"]:
            print(f"  HINWEIS {hint}")

        if not plan["changed"]:
            continue
        if dry_run:
            print(f"  -> wuerde {len(plan['changes'])} Regel(n) schreiben (Trockenlauf)")
            geaendert += len(plan["changes"])
            continue

        result = api(f"/firewalls/{plan['id']}/actions/set_rules", tok, "POST", {"rules": plan["rules"]})
        if "_error" in result:
            print(f"FEHLER beim Schreiben von {plan['name']}: {result['_error']} {result.get('_body', '')}".strip())
            return EXIT_API
        geaendert += len(plan["changes"])

        # Gegenprobe: FRISCH zuruecklesen (kein Vertrauen in die Schreibantwort).
        try:
            antwort = api(f"/firewalls/{plan['id']}", tok)
        except Exception as error:  # pragma: no cover - defensiv
            print(f"FEHLER bei der Gegenprobe von {plan['name']}: {error}")
            return EXIT_API
        if "_error" in antwort:
            print(
                f"FEHLER: Gegenprobe von {plan['name']} nicht lesbar: "
                f"{antwort['_error']} {antwort.get('_body', '')}".strip()
            )
            return EXIT_API
        frisch = antwort.get("firewall") or {}
        if not frisch:
            print(f"FEHLER: Gegenprobe von {plan['name']} lieferte keine Firewall zurueck.")
            gegenprobe_fehler = True
            continue
        soll = rule_set(plan["rules"])
        ist = rule_set(frisch.get("rules") or [])
        if soll != ist:
            gegenprobe_fehler = True
            print(f"FEHLER: Gegenprobe von {plan['name']} weicht ab (frisch gelesen):")
            for eintrag in [r for r in ist if r not in soll]:
                print(f"  unerwartet: {eintrag}")
            for eintrag in [r for r in soll if r not in ist]:
                print(f"  fehlt:      {eintrag}")
            continue
        print(f"  Gegenprobe OK ({len(ist)} Regel(n) frisch gelesen, identisch mit dem Ziel)")

    print()
    if geaendert == 0:
        print("Alle Quell-IPs sind aktuell - unveraendert (kein Schreibaufruf).")
    elif dry_run:
        print(f"Trockenlauf beendet - nichts geschrieben ({geaendert} Regel(n) waeren zu aendern).")
    else:
        print(f"{geaendert} Regel(n) korrigiert und frisch gegengelesen.")
    print(f"Zaehler: geaendert={geaendert} geprueft={geprueft}")
    print("Firewall-IDs: " + (", ".join(ids) if ids else "keine Vertrags-Firewall gefunden"))

    return EXIT_GEGENPROBE if gegenprobe_fehler else EXIT_OK


if __name__ == "__main__":
    raise SystemExit(main())
