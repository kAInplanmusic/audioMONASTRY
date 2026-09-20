#!/usr/bin/env python3
"""Cloudflare-Tokens der Betreiber-Dateien LESEND pruefen.

Warum: Der externe App-Test (F1) fand, dass *alle* Cloudflare-Credentials in
`.env.portal` mit `9109 Invalid access token` antworten - aber es gibt mehrere
Dateien und mehrere Schluesselnamen (CLOUDFLARE_API_TOKEN, CF_API_KEY,
CF_ACCOUNT_TOKEN, CF_S3_*). Dieses Skript sagt pro Fundstelle, ob der Token
gueltig ist und ob er die Zone `anunnakitools.de` ueberhaupt sieht. Es schreibt
NICHTS (kein PATCH, kein POST) und gibt NIE Token-Werte aus - nur Erfolg,
Fehlercode und Zonenzahl. Damit ist der Betreiber-Schritt "gueltigen Token mit
Zone:DNS:Edit hinterlegen" eine Messung statt einer Vermutung.

Aufruf: python3 scripts/hetzner/cf-token-diagnose.py [domain]
"""
from __future__ import annotations

import json
import pathlib
import sys
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
API = "https://api.cloudflare.com/client/v4"
#: (Datei, Schluesselname, Beschriftung)
SOURCES = (
    (".env.deploy", "CLOUDFLARE_API_TOKEN", "deploy"),
    (".env.deploy", "CF_API_KEY", "deploy"),
    (".env.portal", "CLOUDFLARE_API_TOKEN", "portal"),
    (".env.portal", "CF_API_KEY", "portal"),
    (".env.portal", "CF_ACCOUNT_TOKEN", "portal"),
)


def read_env_file(path: pathlib.Path) -> dict[str, str]:
    """Sehr einfacher KEY=VALUE-Leser (Werte werden nie ausgegeben)."""
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, raw = line.partition("=")
        values[key.strip()] = raw.strip().strip('"').strip("'")
    return values


def get(url: str, token: str) -> tuple[int, dict]:
    request = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return response.status, json.loads(response.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as error:  # 4xx/5xx liefern die Fehlercodes
        try:
            return error.code, json.loads(error.read().decode("utf-8", "replace"))
        except Exception:
            return error.code, {}
    except Exception as error:  # Netz/Timeout
        return 0, {"_transport": str(error)[:80]}


def describe_first_error(payload: dict) -> str:
    errors = payload.get("errors") or []
    if not errors:
        return "-"
    first = errors[0] or {}
    return f"{first.get('code', '-')} {str(first.get('message', ''))[:70]}"


def looks_like_global_key(token: str) -> bool:
    """Globaler API-Key = 37 Hex-Zeichen. Fuer ihn ist /user/tokens/verify die
    FALSCHE Pruefung (er braucht X-Auth-Email + X-Auth-Key); ein 'Invalid API
    Token' hier ist deshalb kein Beweis, dass der Schluessel tot ist."""
    return len(token) == 37 and all(c in "0123456789abcdefABCDEF" for c in token)


def main() -> int:
    domain = sys.argv[1] if len(sys.argv) > 1 else "anunnakitools.de"
    print(f"Cloudflare-Token-Diagnose (nur lesend) · Zone {domain}")
    seen: set[tuple[str, str]] = set()
    for filename, key, label in SOURCES:
        token = read_env_file(ROOT / filename).get(key, "")
        if not token:
            print(f"  {filename:14s} {key:22s} nicht gesetzt")
            continue
        if (filename, token) in seen:
            print(f"  {filename:14s} {key:22s} identisch mit vorherigem Wert (uebersprungen)")
            continue
        seen.add((filename, token))
        status, verify = get(f"{API}/user/tokens/verify", token)
        zstatus, zones = get(f"{API}/zones?name={domain}", token)
        found = len(zones.get("result") or [])
        suffix = ""
        if looks_like_global_key(token):
            suffix = " [globaler API-Key: verify-Endpunkt unzustaendig, CF_EMAIL fehlt]"
        elif zones.get("_transport"):
            suffix = f" transport={zones['_transport']}"
        print(
            f"  {filename:14s} {key:22s} verify: success={verify.get('success')} "
            f"errors={describe_first_error(verify)} | zones(http {zstatus}): {found}{suffix}"
        )
    print(
        "Hinweis: 'success=True' + zones>=1 bedeutet nur Zonen-LESERECHT. Ob "
        "Zone:DNS:Edit dabei ist, zeigt erst ein Schreibversuch "
        "(scripts/hetzner/fleet-preflight.sh dns prueft die Verdrahtung lesend, "
        "der Portal-Worker schreibt)."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
