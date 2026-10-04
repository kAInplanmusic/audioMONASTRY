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

Umgebung: CLOUDFLARE_API_TOKEN (oder CLOUDFLARE_TOKEN), DOMAIN (ZONE, nicht der
Host!), ORIGIN_HOST, APP_IP, SFU_SUBDOMAIN/SFU_HOST, SFU_IP, CF_API_BASE
(fuer Teststubs).

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
import sys
import urllib.error
import urllib.request

TOKEN = (os.environ.get("CLOUDFLARE_API_TOKEN") or os.environ.get("CLOUDFLARE_TOKEN") or "").strip()
DOMAIN = os.environ.get("DOMAIN", "anunnakitools.de")
ORIGIN_HOST = os.environ.get("ORIGIN_HOST", f"origin.{DOMAIN}")
APP_IP = os.environ.get("APP_IP", "142.132.229.71")
SFU_SUBDOMAIN = os.environ.get("SFU_SUBDOMAIN", "sfu")
SFU_HOST = os.environ.get("SFU_HOST", f"{SFU_SUBDOMAIN}.{DOMAIN}")
SFU_IP = os.environ.get("SFU_IP", "142.132.231.146")
# Optionaler dritter Record: der OEFFENTLICHE App-Host des Testlaufs
# (z. B. deeptest.anunnakitools.de). Leer = Verhalten wie vorher (2 Records).
APP_HOST = os.environ.get("APP_HOST", "").strip()
APP_HOST_PROXIED = os.environ.get("APP_HOST_PROXIED", "true").strip().lower() not in ("0", "false", "no", "")
# Scope des Ziels: gesetzt (z. B. DEEPTEST_SUBDOMAIN=deeptest), wird JEDER
# Zielhost gegen diese Subdomain geprueft – harter Guard vor jedem Schreibzugriff.
SUBDOMAIN = os.environ.get("SUBDOMAIN", "").strip().strip(".")
# CF_API_BASE umstellbar, z. B. fuer den Teststub (fleet-preflight.sh dns).
API = os.environ.get("CF_API_BASE", "https://api.cloudflare.com/client/v4")


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


def main() -> int:
    apply_changes = "--apply" in sys.argv[1:]
    if not TOKEN:
        print("CLOUDFLARE_API_TOKEN/CLOUDFLARE_TOKEN fehlt (Env-Variable)")
        return 1

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
        (ORIGIN_HOST, "A", APP_IP, False, "Portal-Wake + App (app-1)"),
        (SFU_HOST, "A", SFU_IP, False, "WebRTC-Signaling (sfu-1)"),
    ]
    # Optionaler dritter Record: der oeffentliche App-Host (Apex der Test-
    # Subdomain). Er ist bewusst PROXIED – die oeffentliche Erreichbarkeit laeuft
    # ueber Cloudflare; im Testlauf wird der Deep-Test-Smoke gegen genau diesen
    # Namen gefahren (https://$DEPLOY_DOMAIN/api/health).
    if APP_HOST:
        wanted.append((APP_HOST, "A", APP_IP, APP_HOST_PROXIED,
                       "Deep-Test App-Host (oeffentlich, " + ("proxied/Cloudflare" if APP_HOST_PROXIED else "DNS-only") + ")"))

    # --- SICHERHEITS-GUARD (hart, VOR jedem Schreibzugriff) ------------------
    # WARUM: `DOMAIN` ist die ZONE; ohne Scope-Pruefung wuerde ein Lauf mit
    # Default-Werten (ORIGIN_HOST=origin.$DOMAIN) die PRODUKTIONS-Records
    # umbiegen – live verifiziert: origin.anunnakitools.de = 49.13.75.14,
    # sfu.anunnakitools.de = 46.224.162.10 in der Zone
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