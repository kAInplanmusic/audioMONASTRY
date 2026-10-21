#!/usr/bin/env python3
"""Cloudflare-DNS fuer die Flotte pruefen + setzen (F1: Portal-Wake + SFU).

Warum es dieses Werkzeug gibt (live gemessen 2026-09-20/21): der A-Record
`origin.anunnakitools.de` zeigte auf einen ALTEN Hetzner-Server
(46.225.253.71) und war zusaetzlich proxied - der Portal-Worker holt den
Origin ueber genau diesen Namen, also lief die Domain dauerhaft in HTTP
521/522, obwohl app-1 lief. Der SFU-Record fehlte ganz.

Vertrag (identisch mit `services/portal-worker/src/index.js` -> syncOriginDns
und `scripts/hetzner/fleet-preflight.sh dns`): beide Records sind
**A-Records, DNS-only** (proxied=false) und zeigen direkt auf die Knoten-IPv4.
Der Proxy darf NICHT an sein: der Worker verbindet mit dem Origin-Zertifikat
(Origin CA) direkt auf app-1, und WebRTC (SFU) ist kein HTTP - Cloudflares
Proxy wuerde beides brechen.

Der Token wird NIE ausgegeben - er geht nur in den Authorization-Header.

Aufruf:
  python3 scripts/hetzner/cf-dns-ensure.py                 # Trockenlauf
  python3 scripts/hetzner/cf-dns-ensure.py --apply          # schreiben
  APP_IP=1.2.3.4 SFU_IP=5.6.7.8 ... cf-dns-ensure.py --apply

IP-HERKUNFT (INFRA-HETZNER-028): ohne APP_IP/SFU_IP werden die Knoten-IPs
default-maessig aus der LIVE-Hetzner-API ueber den ROLLENNAMEN aufgeloest
(GET /servers?name=<FLEET_PREFIX><rolle>-1&label_selector=app=audiomonastry,
Namen audiomonastry-app-1 / audiomonastry-sfu-1; FLEET_PREFIX kommt aus
scripts/hetzner/fleet-names.sh bzw. der Umgebung/Env-Datei). Explizite Werte
GEWINNEN weiter. Liefert die API keinen Knoten zu einer Rolle, bricht der
Lauf MIT der Liste der laufenden Flotte ab - nicht still mit einer alten
Konstante; ohne HCLOUD_TOKEN kommt ein Klartext-Fehler.

Umgebung: CLOUDFLARE_API_TOKEN (oder CLOUDFLARE_TOKEN), DOMAIN (ZONE, nicht der
Host!), ORIGIN_HOST, APP_IP, SFU_SUBDOMAIN/SFU_HOST, SFU_IP, HCLOUD_TOKEN
(nur fuer die Rollen-Aufloesung noetig), FLEET_PREFIX, CF_API_BASE und
HCLOUD_API_BASE (fuer Teststubs).

TOKEN-/IP-HERKUNFT (INFRA-HETZNER-018): die Umgebung gewinnt, fehlende Werte
werden aus `.env.deploy` bzw. `.env.portal` im Repo-Root nachgezogen. Ohne diesen
Rueckfall scheiterte der Aufruf im Flottenstart, obwohl der Token in .env.deploy
stand. `CF_ENV_FILE` zeigt auf eine andere Datei, `CF_ENV_FILE=none` laedt keine
(dieselbe Konvention wie FLEET_ENV_FILE in scripts/hetzner/fleet-preflight.sh).

DEEP-TEST/TEST-SUBDOMAIN (2026-09-29 nachgetragen):
  * `DOMAIN` ist die ZONE (z. B. `anunnakitools.de`) – der Zonen-Lookup laeuft
    ueber `GET /zones?name=$DOMAIN`. Wird hier eine Subdomain (z. B.
    `deeptest.anunnakitools.de`) uebergeben, findet der Lookup KEINE Zone und das
    Werkzeug bricht ab (gemessen mit dem Deep-Test-Trockenlauf).
  * Im Testbetrieb gehoeren die Zielhosts in die Test-Subdomain, die ZONE bleibt
    dieselbe:
      DOMAIN=anunnakitools.de
      ORIGIN_HOST=origin.deeptest.anunnakitools.de
      SFU_HOST=sfu.deeptest.anunnakitools.de
      APP_HOST=deeptest.anunnakitools.de        # oeffentlicher App-Host
  * APP_HOST ist OPTIONAL. Ist er gesetzt, wird er als DRITTER A-Record
    gepflegt – und zwar PROXIED (orange), weil die oeffentliche Erreichbarkeit im
    Betrieb ueber Cloudflare laeuft (`APP_HOST_PROXIED=false` erzwingt DNS-only).
    Die beiden Records ORIGIN_HOST/SFU_HOST bleiben unveraendert DNS-only
    (Worker-`resolveOverride` bzw. WebRTC – ein Proxy dort bricht beides).
  * SICHERHEITS-GUARD: ist `SUBDOMAIN` gesetzt, muessen ALLE Zielhosts innerhalb
    dieser Subdomain liegen (`SUBDOMAIN.DOMAIN` oder `*.SUBDOMAIN.DOMAIN`).
    Sonst bricht das Werkzeug VOR jedem Schreibzugriff ab. Damit kann ein Lauf
    die Produktionsnamen (`origin`/`sfu`/Apex) nicht mehr umbiegen.
"""
from __future__ import annotations

import json
import os
import pathlib
import sys
import urllib.error
import urllib.parse
import urllib.request

REPO = pathlib.Path(__file__).resolve().parent.parent.parent

# Gemeinsame Helfer aus scripts/lib/ (Pfad relativ zur eigenen Datei, damit das
# Skript direkt UND per importlib aus tests/ laeuft) - dieselbe Konvention wie
# firewall-ensure-turn.py (INFRA-HETZNER-021).
_LIB = pathlib.Path(__file__).resolve().parents[1] / "lib"
if str(_LIB) not in sys.path:
    sys.path.insert(0, str(_LIB))
from fleetnodes import (  # noqa: E402
    PREFIX_DEFAULT,
    fleet_report,
    node_ipv4,
    server_name,
)
from restclient import hcloud_api  # noqa: E402

#: Token-/IP-Herkunft (INFRA-HETZNER-018). Die Umgebung GEWINNT; fehlende Werte
#: kommen aus diesen Dateien. Vorher las das Werkzeug ausschliesslich die
#: Umgebung - im Flottenstart stand der Token aber nur in `.env.deploy`, und der
#: Lauf brach mit "keine Zone fuer anunnakitools.de" ab, obwohl der Token da war
#: (Deep-Test 2026-10-05); erst ein manuelles `export` half.
#: `CF_ENV_FILE` zeigt auf eine andere Datei statt `.env.deploy`; der Wert `none`
#: laedt gar nichts (dieselbe Konvention wie FLEET_ENV_FILE in fleet-preflight.sh).
_ENV_FILE_RAW = os.environ.get("CF_ENV_FILE", "").strip()
if _ENV_FILE_RAW == "none":
    ENV_FILES: tuple[pathlib.Path, ...] = ()
elif _ENV_FILE_RAW:
    ENV_FILES = (pathlib.Path(_ENV_FILE_RAW),)
else:
    ENV_FILES = (REPO / ".env.deploy", REPO / ".env.portal")

#: Schluessel, die aus den Dateien nachgezogen werden, wenn sie nicht gesetzt sind.
_ENV_KEYS = frozenset(
    {
        "CLOUDFLARE_API_TOKEN",
        "CLOUDFLARE_TOKEN",
        "DOMAIN",
        "ORIGIN_HOST",
        "APP_IP",
        "SFU_SUBDOMAIN",
        "SFU_HOST",
        "SFU_IP",
        "APP_HOST",
        "APP_HOST_PROXIED",
        "SUBDOMAIN",
        # INFRA-HETZNER-028: Aufloesung der Knoten-IPs aus der LIVE-Flotte.
        "HCLOUD_TOKEN",
        "FLEET_PREFIX",
    }
)


def _read_env_file_values() -> dict:
    """Werte aus .env.deploy/.env.portal lesen (nur bekannte Schluessel).

    Bewusst OHNE `os.environ` zu schreiben: ein Import soll die Umgebung des
    Aufrufers nicht veraendern (sonst faerbt diese Datei z. B. Testlaeufe, die
    gerade das Fehlen eines Tokens pruefen wollen). Der Vorrang der Umgebung
    entsteht stattdessen in `_env()`.
    """
    values: dict = {}
    for path in ENV_FILES:
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for line in text.splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith("export "):
                line = line[7:].lstrip()
            key, separator, value = line.partition("=")
            key = key.strip()
            if not separator or key not in _ENV_KEYS or key in values:
                continue
            values[key] = value.strip().strip('"').strip("'")
    return values


#: Werte aus den Dateien (die Umgebung gewinnt erst in `_env()`).
_FILE_ENV = _read_env_file_values()


def _env(name: str, default: str = "") -> str:
    """ENV-Wert: Umgebung zuerst, dann .env.deploy/.env.portal, dann Default."""
    value = os.environ.get(name)
    if value is None:
        value = _FILE_ENV.get(name)
    return (default if value is None else value).strip()


TOKEN = _env("CLOUDFLARE_API_TOKEN") or _env("CLOUDFLARE_TOKEN")
DOMAIN = _env("DOMAIN", "anunnakitools.de") or "anunnakitools.de"
ORIGIN_HOST = _env("ORIGIN_HOST") or f"origin.{DOMAIN}"
#: Knoten-IPs (INFRA-HETZNER-028): KEINE gepinnten Defaults mehr. Ohne
#: APP_IP/SFU_IP wird der Knoten zur Laufzeit ueber seinen ROLLENNAMEN aus der
#: LIVE-Hetzner-Flotte aufgeloest (siehe `ips_aus_flotte`); explizite Werte
#: (Umgebung/Env-Datei) gewinnen weiterhin. Ein leerer Wert heisst hier nicht
#: "fehlend", sondern "aus der Flotte aufloesen".
#: Historie: hier standen gemessene Werte als Konstanten - Stand 2026-10-12
#: lautete die Flotte app-1 = 78.47.65.129, sfu-1 = 2.31.36.78, media-1 =
#: 178.105.96.144, edge-1 = 2.28.101.4. Bereits am 2026-10-11 war ein Lauf mit
#: den September-Werten fast auf einen abgeschalteten Server gegangen, und
#: gemessen 2026-10-21 zeigte origin. nach einem Rebuild auf die alte IP
#: (HTTP 521), bis der Operator die IPs von Hand mitgab. Genau diese Drift
#: einer Konstante hinter der Flotte ist damit dauerhaft behoben.
APP_IP = _env("APP_IP")
SFU_SUBDOMAIN = _env("SFU_SUBDOMAIN") or "sfu"
SFU_HOST = _env("SFU_HOST") or f"{SFU_SUBDOMAIN}.{DOMAIN}"
SFU_IP = _env("SFU_IP")

#: Hetzner-Aufloesung (INFRA-HETZNER-028): der Token folgt derselben Konvention
#: wie bei den Firewall-Werkzeugen (Umgebung gewinnt, sonst Env-Datei); der
#: Namenspraefix ist der aus fleet-names.sh (Umgebung/Env-Datei > Default).
HCLOUD_TOKEN = _env("HCLOUD_TOKEN")
FLEET_PREFIX = _env("FLEET_PREFIX") or PREFIX_DEFAULT
# Optionaler dritter Record: der OEFFENTLICHE App-Host des Testlaufs
# (z. B. deeptest.anunnakitools.de). Leer = Verhalten wie vorher (2 Records).
APP_HOST = _env("APP_HOST")
APP_HOST_PROXIED = _env("APP_HOST_PROXIED", "true").lower() not in ("0", "false", "no", "")
# Scope des Ziels: gesetzt (z. B. DEEPTEST_SUBDOMAIN=deeptest), wird JEDER
# Zielhost gegen diese Subdomain geprueft – harter Guard vor jedem Schreibzugriff.
SUBDOMAIN = _env("SUBDOMAIN").strip(".")
# CF_API_BASE umstellbar, z. B. fuer den Teststub (fleet-preflight.sh dns).
API = _env("CF_API_BASE", "https://api.cloudflare.com/client/v4")


def headers() -> dict:
    return {
        "Authorization": f"Bearer {TOKEN}",
        "Content-Type": "application/json",
        "User-Agent": "audioMONASTRY/1.0",
    }


def api(method: str, path: str, payload: dict | None = None) -> dict:
    body = json.dumps(payload).encode("utf-8") if payload is not None else None
    request = urllib.request.Request(f"{API}{path}", data=body, method=method, headers=headers())
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            raw = response.read().decode("utf-8", "replace")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as error:
        return {"_error": f"HTTP {error.code}", "_body": error.read().decode("utf-8", "replace")[:300]}


def fail(message: str) -> int:
    print(f"  FEHLER {message}")
    return 1


class HetznerFehler(RuntimeError):
    """Knoten-IP nicht aus der Flotte aufloesbar - wird als Exit 1 gemeldet."""


#: Hetzner-Label ALLER Flottenknoten (provision.py setzt es bei jedem Server);
#: dieselbe Abfrage nennt die Anleitung in docs/HETZNER_DEPLOY.md.
FLEET_LABEL = "app=audiomonastry"


def _hetzner_servers(token: str, query: str) -> list[dict]:
    """GET /servers mit Query; bei `_error` fliegt HetznerFehler (Klartext)."""
    data = hcloud_api(query, token, detail_limit=300)
    if "_error" in data:
        raise HetznerFehler(
            f"Hetzner-API nicht lesbar: {data['_error']} {data.get('_body', '')}".strip()
        )
    return list(data.get("servers") or [])


def _fleet_liste(token: str) -> list[dict]:
    """Alle Flottenknoten (Label app=audiomonastry) - Quelle der Fehlermeldung."""
    servers: list[dict] = []
    page = 1
    while True:
        batch = _hetzner_servers(
            token,
            f"/servers?label_selector={urllib.parse.quote(FLEET_LABEL, safe='')}"
            f"&page={page}&per_page=50",
        )
        servers.extend(batch)
        if len(batch) < 50:  # Hetzner paginiert mit max. 50 je Seite
            return servers
        page += 1


def _rolle_ip(token: str, rolle: str) -> str:
    """IPv4 des Knotens <FLEET_PREFIX><rolle>-1 aus der LIVE-Flotte (nie geraten).

    Abfrage genau nach Ticket INFRA-HETZNER-028: GET /servers?name=<Name> plus
    Label-Selektor app=audiomonastry. Der Namensvergleich passiert zusaetzlich
    clientseitig (fleetnodes.node_ipv4) - die Namenskonvention bleibt die
    einzige Quelle, ein Treffer mit fremdem Namen zaehlt nicht.
    """
    name = server_name(rolle, FLEET_PREFIX)
    query = (
        f"/servers?name={urllib.parse.quote(name, safe='')}"
        f"&label_selector={urllib.parse.quote(FLEET_LABEL, safe='')}"
    )
    return node_ipv4(_hetzner_servers(token, query), rolle, FLEET_PREFIX)


def ips_aus_flotte(app_ip: str, sfu_ip: str) -> tuple[str, str]:
    """Fehlende Knoten-IPs aus der LIVE-Flotte aufloesen (Rollennamen).

    Explizite Werte (Umgebung/Env-Datei) bleiben unberuehrt - sie GEWINNEN
    weiter (gemessener Aufruf APP_IP=... SFU_IP=... --apply). Ohne Wert wird
    der Knoten ueber den ROLLENNAMEN gesucht; scheitert das, fliegt ein
    HetznerFehler MIT Liste der laufenden Flotte - kein Rueckfall auf eine
    alte Konstante (INFRA-HETZNER-028).
    """
    fehlend = [rolle for rolle, wert in (("app", app_ip), ("sfu", sfu_ip)) if not wert]
    if not fehlend:
        return app_ip, sfu_ip
    if not HCLOUD_TOKEN:
        quelle = ", ".join(str(p) for p in ENV_FILES) if ENV_FILES else "keine Env-Datei geladen"
        raise HetznerFehler(
            "APP_IP/SFU_IP fehlen und HCLOUD_TOKEN ist nicht gesetzt "
            f"(Umgebung und {quelle}) - die Knoten-IP laesst sich nicht aus der "
            "Flotte aufloesen. APP_IP=<app-1-IPv4> SFU_IP=<sfu-1-IPv4> explizit "
            "setzen oder HCLOUD_TOKEN bereitstellen."
        )
    aufgeloest: dict[str, str] = {}
    for rolle in fehlend:
        ip = _rolle_ip(HCLOUD_TOKEN, rolle)
        if not ip:
            fehlende_var = "APP_IP" if rolle == "app" else "SFU_IP"
            raise HetznerFehler(
                f"Kein Knoten fuer die Rolle '{rolle}' ({server_name(rolle, FLEET_PREFIX)}) "
                f"in der Hetzner-Flotte (Label {FLEET_LABEL}). Laufende Flotte: "
                f"{fleet_report(_fleet_liste(HCLOUD_TOKEN))}. Sonst IP explizit "
                f"setzen: {fehlende_var}=<IPv4>."
            )
        aufgeloest[rolle] = ip
        print(
            f"  Rolle {rolle} -> {server_name(rolle, FLEET_PREFIX)} = {ip} "
            "(aus der laufenden Flotte)"
        )
    return aufgeloest.get("app", app_ip), aufgeloest.get("sfu", sfu_ip)


def main() -> int:
    apply_changes = "--apply" in sys.argv[1:]
    if not TOKEN:
        quellen = ", ".join(str(p) for p in ENV_FILES) if ENV_FILES else "keine Env-Datei geladen"
        print(f"CLOUDFLARE_API_TOKEN/CLOUDFLARE_TOKEN fehlt (Umgebung und {quellen})")
        return 1

    # Knoten-IPs (INFRA-HETZNER-028): explizite Werte gewinnen; fehlen sie,
    # wird der Knoten ueber den ROLLENNAMEN aus der LIVE-Flotte aufgeloest.
    # Scheitert das (kein HCLOUD_TOKEN, API-Fehler, Rolle fehlt), bricht der
    # Lauf hier mit Klartext ab - bevor irgendein Record gelesen wird.
    try:
        app_ip, sfu_ip = ips_aus_flotte(APP_IP, SFU_IP)
    except HetznerFehler as error:
        return fail(str(error))

    zones = api("GET", f"/zones?name={DOMAIN}&per_page=1").get("result", [])
    if not zones:
        return fail(f"keine Zone fuer {DOMAIN} - Token oder Domain pruefen")
    zone = zones[0]
    zone_id = zone["id"]
    print(f"Zone: {zone['name']} (id={zone_id})")

    records_raw = api("GET", f"/zones/{zone_id}/dns_records?per_page=100")
    if "_error" in records_raw:
        return fail(f"DNS-Records nicht lesbar: {records_raw['_error']} {records_raw.get('_body', '')}")
    by_name: dict[str, dict] = {}
    for record in records_raw.get("result", []) or []:
        by_name.setdefault(record.get("name", ""), record)

    # Vertrag: A, DNS-only (proxied=false), direkt auf den Knoten.
    wanted = [
        (ORIGIN_HOST, "A", app_ip, False, "Portal-Wake + App (app-1)"),
        (SFU_HOST, "A", sfu_ip, False, "WebRTC-Signaling (sfu-1)"),
    ]
    # Optionaler dritter Record: der oeffentliche App-Host (Apex der Test-
    # Subdomain). Er ist bewusst PROXIED – die oeffentliche Erreichbarkeit laeuft
    # ueber Cloudflare; im Testlauf wird der Deep-Test-Smoke gegen genau diesen
    # Namen gefahren (https://$DEPLOY_DOMAIN/api/health).
    if APP_HOST:
        wanted.append((APP_HOST, "A", app_ip, APP_HOST_PROXIED,
                       "Deep-Test App-Host (oeffentlich, " + ("proxied/Cloudflare" if APP_HOST_PROXIED else "DNS-only") + ")"))

    # --- SICHERHEITS-GUARD (hart, VOR jedem Schreibzugriff) ------------------
    # WARUM: `DOMAIN` ist die ZONE; ohne Scope-Pruefung wuerde ein Lauf mit
    # Default-Werten (ORIGIN_HOST=origin.$DOMAIN) die PRODUKTIONS-Records
    # umbiegen – gemessen 2026-10-12 in der Zone 5a1fc69c28aacfed10a3c239cf138ba7:
    # origin.anunnakitools.de = 78.47.65.129 (app-1, korrekt),
    # sfu.anunnakitools.de   = 2.28.133.48. Das ist KEIN Flottenknoten mehr (die
    # Flotte vom 2026-10-10 hat sfu-1 = 2.31.36.78, media-1 = 178.105.96.144) –
    # Drift, NICHT ohne Freigabe aendern, siehe INFRA-HETZNER-020.
    # 5a1fc69c28aacfed10a3c239cf138ba7. Mit SUBDOMAIN=deeptest darf ausschliesslich
    # innerhalb von *.deeptest.anunnakitools.de geschrieben werden.
    if SUBDOMAIN:
        apex = f"{SUBDOMAIN}.{DOMAIN}"
        suffix = f".{SUBDOMAIN}.{DOMAIN}"
        outside = [name for name, *_ in wanted if name != apex and not name.endswith(suffix)]
        if outside:
            print(f"  ABBRUCH (Scope-Guard): SUBDOMAIN={SUBDOMAIN} gesetzt, aber diese Zielhosts liegen AUSSERHALB von {apex} / *{suffix}:")
            for name in outside:
                print(f"    - {name}")
            print("  Ein Schreibzugriff auf Produktionsnamen ist untersagt (origin./sfu./Apex der Zone).")
            print("  Korrekt fuer den Testlauf: DOMAIN=<Zone>, ORIGIN_HOST=origin.<SUBDOMAIN>.<Zone>,")
            print("  SFU_HOST=sfu.<SUBDOMAIN>.<Zone>, APP_HOST=<SUBDOMAIN>.<Zone>.")
            return 1

    print("  Ziel (Scope %s):" % (f"*.{SUBDOMAIN}.{DOMAIN}" if SUBDOMAIN else f"Zone {DOMAIN} (kein Scope-Guard aktiv)"))
    for name, rtype, content, proxied, note in wanted:
        print(f"    {name} {rtype} -> {content} proxied={str(proxied).lower()}  ({note})")

    changed = False
    for name, rtype, content, proxied, note in wanted:
        existing = by_name.get(name)
        if existing is None:
            changed = True
            if not apply_changes:
                print(f"  {name} ({rtype} -> {content}, proxied={str(proxied).lower()}): fehlt -> wuerde angelegt ({note})")
                continue
            result = api("POST", f"/zones/{zone_id}/dns_records", {
                "type": rtype, "name": name, "content": content, "proxied": proxied, "comment": note,
            })
            if "_error" in result:
                return fail(f"{name}: {result['_error']} {result.get('_body', '')}")
            print(f"  {name} ({rtype} -> {content}, proxied={str(proxied).lower()}): angelegt ({note})")
            continue

        current_type = existing.get("type")
        current_content = existing.get("content")
        current_proxied = existing.get("proxied") is True
        if current_type == rtype and current_content == content and current_proxied is proxied:
            print(f"  {name} ({rtype} -> {content}, proxied={str(proxied).lower()}): bereits korrekt ({note})")
            continue

        changed = True
        drift = []
        if current_type != rtype:
            drift.append(f"type={current_type}")
        if current_content != content:
            drift.append(f"zeigt auf {current_content}")
        if current_proxied is not proxied:
            drift.append("proxied=true" if current_proxied else "proxied=false")
        if not apply_changes:
            print(f"  {name}: {'/'.join(drift)} -> wuerde auf {rtype} {content}, proxied={str(proxied).lower()} gesetzt ({note})")
            continue
        result = api("PUT", f"/zones/{zone_id}/dns_records/{existing['id']}", {
            "type": rtype, "name": name, "content": content, "proxied": proxied, "comment": note,
        })
        if "_error" in result:
            return fail(f"{name}: {result['_error']} {result.get('_body', '')}")
        print(f"  {name}: {'/'.join(drift)} korrigiert -> {rtype} {content}, proxied={str(proxied).lower()} ({note})")

    if not changed:
        print("Nichts zu tun (idempotent).")
    elif not apply_changes:
        print("Trockenlauf beendet - mit --apply schreiben.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())