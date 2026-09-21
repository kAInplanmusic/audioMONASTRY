#!/usr/bin/env python3
"""Loescht die ungenutzten Legacy-Firewalls des ALTNAMENS in Hetzner.

Warum: nach dem Namespace-Fix (F10) heissen die AKTIVEN Firewalls kanonisch. Die
alten Firewalls des früheren Praefixes blieben liegen - sechs Stueck, an keinen
Server gebunden, mit TEILWEISE ANDEREN Regeln (die alte SFU-Firewall hatte z.B.
keine TURN-Ports). Genau so entsteht ein Fehlgriff: jemand haengt die falsche
Firewall an, und die Ports stimmen nicht.

Der Praefix wird NICHT hier notiert, sondern aus scripts/hetzner/fleet-names.sh
gelesen (EINE Namensquelle; ein zweiter Literalvorrat waere genau die Doppelung,
die F10 beseitigt hat).

Sicherheit: es wird NUR geloescht, wenn `applied_to` leer ist. Ohne `--apply`
laeuft ein Trockenlauf.

Aufruf:
  python3 scripts/hetzner/cleanup-legacy-firewalls.py            # Trockenlauf
  python3 scripts/hetzner/cleanup-legacy-firewalls.py --apply    # loeschen
"""
from __future__ import annotations

import json
import pathlib
import subprocess
import sys
import urllib.error
import urllib.request

REPO = pathlib.Path(__file__).resolve().parent.parent.parent
API = "https://api.hetzner.cloud/v1"


def token() -> str:
    for line in (REPO / ".env.deploy").read_text(encoding="utf-8", errors="replace").splitlines():
        if line.startswith("HCLOUD_TOKEN="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    return ""


def legacy_prefix() -> str:
    """Praefix aus der EINEN Namensquelle (fleet-names.sh), kein zweiter Vorrat.

    Die Bibliothek wird per bash gesourct und der Wert ausgegeben - so gilt genau
    der Wert, den alle anderen Skripte auch sehen (auch ein Betreiber-Override via
    LEGACY_FLEET_PREFIX). Ist er nicht ermittelbar, bricht der Aufruf ab: ein
    eingebauter Ersatzname waere die zweite Namensquelle, die F10 beseitigt hat.
    """
    names_sh = REPO / "scripts" / "hetzner" / "fleet-names.sh"
    if not names_sh.exists():
        return ""
    result = subprocess.run(
        ["bash", "-c", f'source "{names_sh}"; printf %s "$LEGACY_FLEET_PREFIX"'],
        capture_output=True, text=True, timeout=30,
    )
    return result.stdout.strip() if result.returncode == 0 else ""


def api(path: str, tok: str, method: str = "GET") -> dict:
    request = urllib.request.Request(f"{API}{path}", method=method, headers={"Authorization": f"Bearer {tok}"})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            body = response.read().decode("utf-8", "replace")
            return json.loads(body) if body else {}
    except urllib.error.HTTPError as error:
        return {"_error": f"HTTP {error.code}", "_body": error.read().decode("utf-8", "replace")[:200]}


def main() -> int:
    apply_changes = "--apply" in sys.argv[1:]
    if not legacy_prefix():
        print("Legacy-Praefix nicht ermittelbar (scripts/hetzner/fleet-names.sh) - kein Ersatzname im Skript.")
        return 1
    tok = token()
    if not tok:
        print("HCLOUD_TOKEN fehlt in .env.deploy")
        return 1
    prefix = legacy_prefix()
    print(f"Legacy-Praefix: {prefix} (Quelle: scripts/hetzner/fleet-names.sh)")

    firewalls = api("/firewalls?per_page=50", tok).get("firewalls", [])
    candidates = [fw for fw in firewalls if str(fw.get("name", "")).startswith(prefix)]
    if not candidates:
        print("Keine Legacy-Firewalls gefunden - nichts zu tun.")
        return 0

    deleted = 0
    for fw in candidates:
        detail = api(f"/firewalls/{fw['id']}", tok).get("firewall", {})
        applied = detail.get("applied_to") or []
        if applied:
            print(f"  {fw['name']} (id={fw['id']}): UEBERSPRUNGEN - haengt an {len(applied)} Ressource(n)")
            continue
        if not apply_changes:
            print(f"  {fw['name']} (id={fw['id']}): ungebunden, {len(detail.get('rules') or [])} Regeln -> wuerde geloescht")
            continue
        result = api(f"/firewalls/{fw['id']}", tok, "DELETE")
        if "_error" in result:
            print(f"  {fw['name']} (id={fw['id']}): FEHLER {result['_error']} {result.get('_body', '')}")
            continue
        print(f"  {fw['name']} (id={fw['id']}): geloescht")
        deleted += 1

    if apply_changes:
        print(f"Geloescht: {deleted}/{len(candidates)}")
        remaining = [fw["name"] for fw in api("/firewalls?per_page=50", tok).get("firewalls", [])
                     if str(fw.get("name", "")).startswith(prefix)]
        print(f"Kontrolle - verbleibende Legacy-Firewalls: {remaining or 'keine'}")
    else:
        print("Trockenlauf beendet - mit --apply loeschen.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
