#!/usr/bin/env python3
"""
Wake mit dem NEUEN Worker verifizieren: zeigt der Aufruf die Verdrahtung?
=====================================================================
Erwartung nach dem Fix: die Antwort enthaelt `wiring` mit dem Ergebnis von
Firewall/DNS/Ports. Der DNS-Teil MUSS hier `ok: false` mit einer Meldung sein -
der bereitgestellte Cloudflare-Token darf kein DNS. Genau das war vorher unsichtbar
(nur console.warn), und der Betreiber sah nur ein dauerhaftes "starting-app".
"""
import json
import pathlib
import sys
import time
import urllib.request

PORTAL = 'https://anunnakitools.de'
UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36'

# Gemeinsame Helfer aus scripts/lib/ (Pfad relativ zur eigenen Datei, damit das
# Skript direkt UND per importlib aus tests/ laeuft).
_LIB = pathlib.Path(__file__).resolve().parents[0] / "lib"
if str(_LIB) not in sys.path:
    sys.path.insert(0, str(_LIB))
from envfile import read_required_env_file  # noqa: E402
from restclient import portal_request  # noqa: E402


#: Repo-Wurzel aus der Lage DIESER Datei (scripts/<datei> -> eine Ebene hoch),
#: nicht als absoluter Pfad. Grund: am 2026-09-23 wurde das Repo verschoben
#: (nach "AnunnakiTools Projekte/laufende Projekte/audioMONASTRY"); ein fest
#: eingetragener Pfad waere danach still falsch gewesen.
_REPO = pathlib.Path(__file__).resolve().parents[1]


def load_env(path=_REPO / '.env.deploy'):
    """KEY=VALUE aus der Deploy-Env; fehlende Datei bricht laut ab (wie bisher)."""
    return read_required_env_file(pathlib.Path(path))


def call(path, data=None, cookie=None):
    """Portal-Aufruf (Browser-UA Pflicht); Fehler kommen als (0, Meldung, '') zurueck."""
    req = portal_request(PORTAL, path, data, cookie, user_agent=UA)
    try:
        with urllib.request.urlopen(req, timeout=120) as res:
            raw = res.read().decode()
            return res.status, (json.loads(raw) if raw.strip().startswith('{') else raw), res.headers.get('Set-Cookie') or ''
    except Exception as err:  # noqa: BLE001
        return 0, str(err), ''


def main():
    env = load_env()
    status, _, set_cookie = call('/api/login', {'user': env.get('ADMIN_USER'), 'pass': env.get('ADMIN_PASSWORD')})
    cookie = set_cookie.split(';')[0]
    print('Login:', status)
    t0 = time.time()
    status, payload, _ = call('/api/wake', data={}, cookie=cookie)
    print(f'WACHE HTTP {status} nach {round(time.time() - t0, 1)} s')
    if isinstance(payload, dict):
        print('  usedSnapshots:', list((payload.get('usedSnapshots') or {}).keys()))
        print('  fallbackRoles:', payload.get('fallbackRoles'))
        print('  WIRING:', json.dumps(payload.get('wiring'), ensure_ascii=False)[:320])
    else:
        print('  Antwort:', str(payload)[:200])
    for i in range(4):
        _, st, _ = call('/api/status', cookie=cookie)
        if isinstance(st, dict):
            print(f'  t={i * 15}s state={st.get("state")} healthError={st.get("healthError")}')
            if st.get('state') == 'ready':
                break
        time.sleep(15)


if __name__ == '__main__':
    main()
