#!/usr/bin/env python3
"""Cloudflare-Tokens der Betreiber-Dateien pruefen.

Warum: Der externe App-Test (F1) fand, dass *alle* Cloudflare-Credentials in
`.env.portal` mit `9109 Invalid access token` antworten - aber es gibt mehrere
Dateien und mehrere Schluesselnamen (CLOUDFLARE_API_TOKEN, CF_API_KEY,
CF_ACCOUNT_TOKEN, CF_S3_*). Dieses Skript sagt pro Fundstelle, ob der Token
gueltig ist und ob er die Zone `anunnakitools.de` ueberhaupt sieht. Es gibt NIE
Token-Werte aus - nur Erfolg, Fehlercode und Zonenzahl.

Zwei Betriebsarten:

* Standard (LESEND): ausschliesslich GET-Aufrufe (`/user/tokens/verify`,
  `/zones?name=...`). Fuer den Betreiber-Schritt "gueltigen Token mit
  Zone:DNS:Edit hinterlegen" ist das nur eine Messung - Zonen-Leserecht beweist
  das Schreibrecht NICHT.
* `--write-test` (SCHREIBEND, ausdruecklich angeschaltet): legt pro Fundstelle
  einen TXT-Record `_hermes-token-writetest-<zufall>` in der Zone an und loescht
  ihn sofort wieder. Nur so ist Zone:DNS:Edit belegt. Der Record wird in jedem
  Fall entfernt (auch bei Fehlern), der Name ist eindeutig und die TTL minimal.
  Rueckgabewert: 1, sobald eine Fundstelle nicht schreiben darf.

Hinweis zu `/user/tokens/verify`: Dieser Endpunkt verlangt das Recht
`User API Tokens:Read`. Fehlt es, antwortet Cloudflare mit `1000 Invalid API
Token`, OBWOHL der Token fuer Zone/DNS/R2 gueltig ist. Ein `1000` dort ist
deshalb kein Beweis fuer einen toten Token; entscheidend sind Zonenzugriff und
(mit `--write-test`) der Schreibversuch.

Aufruf: python3 scripts/hetzner/cf-token-diagnose.py [domain] [--write-test]
"""
from __future__ import annotations

import json
import pathlib
import secrets
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


def http_call(
    url: str,
    token: str,
    method: str = "GET",
    payload: dict | None = None,
) -> tuple[int, dict]:
    """Ein API-Aufruf. Die Methode entscheidet, ob das LESEND bleibt."""
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    headers = {"Authorization": f"Bearer {token}"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=body, method=method, headers=headers)
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


def get(url: str, token: str) -> tuple[int, dict]:
    """Lesender Aufruf (Name bleibt erhalten, damit bestehende Aufrufer passen)."""
    return http_call(url, token, "GET")


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


def zone_id_for(token: str, domain: str) -> str:
    """Zonen-ID zur Domain (lesend); leer, wenn die Zone nicht sichtbar ist."""
    _status, payload = get(f"{API}/zones?name={domain}", token)
    hits = payload.get("result") or []
    return str(hits[0].get("id") or "") if hits else ""


def write_test(token: str, zone_id: str) -> tuple[bool, str]:
    """TXT-Record anlegen und sofort wieder loeschen: beweist Zone:DNS:Edit.

    Der Record wird auch bei Fehlern entfernt. Rueckgabe (schreibrecht, Klartext).
    """
    name = f"_hermes-token-writetest-{secrets.token_hex(4)}"
    create_status, create_payload = http_call(
        f"{API}/zones/{zone_id}/dns_records",
        token,
        "POST",
        {"type": "TXT", "name": name, "content": "schreibtest", "ttl": 60},
    )
    record_id = str((create_payload.get("result") or {}).get("id") or "")
    cleanup = ""
    if record_id:  # immer aufraeumen - auch wenn das Anlegen als Fehler gewertet wird
        del_status, del_payload = http_call(
            f"{API}/zones/{zone_id}/dns_records/{record_id}", token, "DELETE"
        )
        if del_status >= 300:
            cleanup = (
                f"; WARNUNG Aufraeumen fehlgeschlagen (DELETE http {del_status}: "
                f"{describe_first_error(del_payload)}) - Record {name} bitte im Dashboard loeschen"
            )
    if create_status >= 300 or not record_id:
        return False, f"POST http {create_status}: {describe_first_error(create_payload)}{cleanup}"
    return True, f"SCHREIBRECHT (Testrecord angelegt und wieder geloescht){cleanup}"


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    flags = {a for a in sys.argv[1:] if a.startswith("--")}
    unknown = flags - {"--write-test", "--post-test"}
    if unknown:
        print(f"Unbekannte Option(en): {', '.join(sorted(unknown))}", file=sys.stderr)
        return 2
    write_mode = bool(flags & {"--write-test", "--post-test"})
    domain = args[0] if args else "anunnakitools.de"
    mode = "schreibend, --write-test legt kurz einen TXT-Record an" if write_mode else "nur lesend"
    print(f"Cloudflare-Token-Diagnose ({mode}) · Zone {domain}")
    seen: set[tuple[str, str]] = set()
    sites_with_token = 0
    sites_ok = 0
    for filename, key, label in SOURCES:
        token = read_env_file(ROOT / filename).get(key, "")
        if not token:
            print(f"  {filename:14s} {key:22s} nicht gesetzt")
            continue
        if (filename, token) in seen:
            print(f"  {filename:14s} {key:22s} identisch mit vorherigem Wert (uebersprungen)")
            continue
        seen.add((filename, token))
        sites_with_token += 1
        status, verify = get(f"{API}/user/tokens/verify", token)
        zstatus, zones = get(f"{API}/zones?name={domain}", token)
        found = len(zones.get("result") or [])
        suffix = ""
        if looks_like_global_key(token):
            suffix = " [globaler API-Key: *** unzustaendig, CF_EMAIL fehlt]"
        elif zones.get("_transport"):
            suffix = f" transport={zones['_transport']}"
        print(
            f"  {filename:14s} {key:22s} verify: success={verify.get('success')} "
            f"errors={describe_first_error(verify)} | zones(http {zstatus}): {found}{suffix}"
        )
        if not write_mode:
            continue
        if looks_like_global_key(token):
            print(f"  {'':14s} {'':22s} POST-Test: uebersprungen (globaler API-Key braucht CF_EMAIL)")
            continue
        zone_id = zone_id_for(token, domain)
        if not zone_id:
            print(f"  {'':14s} {'':22s} POST-Test: nicht moeglich, Zone {domain} nicht sichtbar")
            continue
        ok, detail = write_test(token, zone_id)
        print(f"  {'':14s} {'':22s} POST-Test: {detail}")
        if ok:
            sites_ok += 1
    if write_mode:
        print(f"Ergebnis: {sites_ok}/{sites_with_token} Fundstelle(n) mit Zone:DNS:Edit.")
        return 0 if sites_with_token and sites_ok == sites_with_token else 1
    print(
        "Hinweis: 'success=True' + zones>=1 bedeutet nur Zonen-LESERECHT. Ob "
        "Zone:DNS:Edit dabei ist, zeigt erst ein Schreibversuch - dafuer dieses "
        "Skript mit --write-test aufrufen (legt kurz einen TXT-Record an und "
        "loescht ihn wieder)."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
