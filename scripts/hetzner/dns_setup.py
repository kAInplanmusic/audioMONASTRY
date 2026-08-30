#!/usr/bin/env python3
# =============================================================================
# sampleMONK – Hetzner DNS Setup für anunnakitools.de
# -----------------------------------------------------------------------------
# Verwendet die NEUE Hetzner Cloud DNS API (seit 2026 unter api.hetzner.cloud):
#   A     @                  -> TARGET_IP   (Floating IP)
#   CNAME www                -> @            (Wert: anunnakitools.de.)
#   TXT   _acme-challenge    -> PLACEHOLDER
#
# Voraussetzung: HCLOUD_TOKEN (Cloud API Token mit DNS-Berechtigung).
# Der alte DNS-Console-Token (dns.hetzner.com) ist seit 27.05.2026 ungültig.
#
# Aufruf:
#   HCLOUD_TOKEN=xxx TARGET_IP=91.98.104.74 \
#     python3 scripts/hetzner/dns_setup.py --domain anunnakitools.de
# =============================================================================
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

API_BASE = "https://api.hetzner.cloud/v1"
DEFAULT_DOMAIN = os.environ.get("DOMAIN", "anunnakitools.de")
DEFAULT_TARGET_IP = os.environ.get("TARGET_IP")


def die(msg: str) -> None:
    print(f"[dns] ❌ {msg}", file=sys.stderr)
    sys.exit(1)


def api(token: str, method: str, path: str, payload: dict | None = None) -> dict | None:
    req = urllib.request.Request(API_BASE + path, method=method)
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Content-Type", "application/json")
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    try:
        with urllib.request.urlopen(req, data=data, timeout=30) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        body = e.read().decode("utf-8", errors="replace")
        try:
            err = json.loads(body).get("error", {})
            detail = err.get("message") or err.get("code") or body
        except Exception:
            detail = body
        die(f"HTTP {e.code} {method} {path}: {detail}")
    except urllib.error.URLError as e:
        die(f"Netzwerkfehler {method} {path}: {e.reason}")
    return None


def find_zone(token: str, domain: str) -> dict | None:
    query = urllib.parse.urlencode({"name": domain})
    data = api(token, "GET", f"/zones?{query}") or {}
    for zone in data.get("zones", []):
        if zone.get("name") == domain:
            return zone
    return None


def ensure_zone(token: str, domain: str) -> dict:
    zone = find_zone(token, domain)
    if zone:
        print(f"[dns] ✅ Zone vorhanden: {domain} (id={zone['id']})")
        return zone
    result = api(token, "POST", "/zones", {"name": domain, "ttl": 300})
    zone = (result or {}).get("zone")
    if not zone:
        die("Zone konnte nicht angelegt werden.")
    print(f"[dns] ✅ Zone erstellt: {domain} (id={zone['id']})")
    return zone


def get_rrset(token: str, zone_id, name: str, rtype: str) -> dict | None:
    path = f"/zones/{zone_id}/rrsets/{urllib.parse.quote(name, safe='@')}/{rtype}"
    data = api(token, "GET", path)
    if not data:
        return None
    return data.get("rrset")


def upsert_rrset(token: str, zone_id, name: str, rtype: str, value: str) -> None:
    rrset = get_rrset(token, zone_id, name, rtype)
    if rrset is None:
        payload = {
            "name": name,
            "type": rtype,
            "ttl": 300,
            "records": [{"value": value}],
        }
        api(token, "POST", f"/zones/{zone_id}/rrsets", payload)
        print(f"[dns] ✅ erstellt: {rtype} {name} -> {value}")
        return

    records = rrset.get("records", [])
    if len(records) == 1 and records[0].get("value") == value:
        print(f"[dns] ✅ unverändert: {rtype} {name} -> {value}")
        return

    path = f"/zones/{zone_id}/rrsets/{urllib.parse.quote(name, safe='@')}/{rtype}/actions/set_records"
    api(token, "POST", path, {"records": [{"value": value, "comment": ""}]})
    print(f"[dns] ✅ aktualisiert: {rtype} {name} -> {value}")


def main() -> None:
    parser = argparse.ArgumentParser(description="sampleMONK Hetzner DNS Setup (Cloud API)")
    parser.add_argument("--domain", default=DEFAULT_DOMAIN, help="Domain (Standard: anunnakitools.de)")
    parser.add_argument("--target-ip", default=DEFAULT_TARGET_IP, help="Floating IP / TARGET_IP")
    parser.add_argument("--token", default=os.environ.get("HCLOUD_TOKEN") or os.environ.get("HCLOUD_DNS_TOKEN", ""),
                        help="Hetzner Cloud API Token (oder HCLOUD_TOKEN)")
    args = parser.parse_args()

    if not args.token:
        die("HCLOUD_TOKEN fehlt (Cloud Console -> Security -> API Tokens).")

    target_ip = (args.target_ip or "").strip()
    if not target_ip:
        die("TARGET_IP fehlt (z.B. TARGET_IP=91.98.104.74 setzen).")

    token = args.token.strip()
    domain = args.domain.strip().rstrip('.')
    cname_value = f"{domain}."

    zone = ensure_zone(token, domain)
    zone_id = zone["id"]

    upsert_rrset(token, zone_id, "@", "A", target_ip)
    upsert_rrset(token, zone_id, "www", "CNAME", cname_value)
    upsert_rrset(token, zone_id, "_acme-challenge", "TXT", '"PLACEHOLDER"')

    print()
    print("=" * 72)
    print("DNS-Fertig:", domain)
    print("=" * 72)
    print(json.dumps({
        "domain": domain,
        "zone_id": zone_id,
        "records": [
            {"type": "A", "name": "@", "value": target_ip},
            {"type": "CNAME", "name": "www", "value": cname_value},
            {"type": "TXT", "name": "_acme-challenge", "value": '"PLACEHOLDER"'},
        ],
    }, ensure_ascii=False, indent=2))
    print("=" * 72)


if __name__ == "__main__":
    main()
