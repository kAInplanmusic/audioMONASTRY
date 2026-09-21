#!/usr/bin/env python3
"""
Portal-Verdrahtung nach dem Wake: /api/wire-fleet + Status bis 'ready'.
=====================================================================
Der Wake allein macht die App nicht erreichbar: die origin-DNS zeigt sonst auf
eine alte IP (gemessen: HTTP 522, state 'starting-app' fuer immer). Dieses Skript
loggt sich ein, ruft /api/wire-fleet (Firewall + origin-DNS auf die neue app-IP +
Fleet-Ports) und pollt dann /api/status bis 'ready' - mit Zeitmessung.
"""
import json
import pathlib
import sys
import time
import urllib.error
import urllib.request

PORTAL = 'https://anunnakitools.de'
UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36'

# Gemeinsame Helfer aus scripts/lib/ (Pfad relativ zur eigenen Datei, damit das
# Skript direkt UND per importlib aus tests/ laeuft).
_LIB = pathlib.Path(__file__).resolve().parents[0] / "lib"
if str(_LIB) not in sys.path:
    sys.path.insert(0, str(_LIB))
from envfile import read_required_env_file  # noqa: E402
from restclient import portal_call  # noqa: E402


def load_env(path='.env.deploy'):
    """KEY=VALUE aus der Deploy-Env; eine fehlende Datei bricht laut ab (wie bisher)."""
    return read_required_env_file(pathlib.Path(path))


def call(path, data=None, cookie=None):
    """Portal-Aufruf mit Browser-UA (Cloudflare blockt Standard-urllib, Fehler 1010)."""
    return portal_call(PORTAL, path, data, cookie, timeout=40, user_agent=UA)


def main():
    env = load_env()
    status, payload, set_cookie = call('/api/login', {'user': env.get('ADMIN_USER'), 'pass': env.get('ADMIN_PASSWORD')})
    if status != 200:
        print('Login fehlgeschlagen:', status, payload)
        return 1
    cookie = set_cookie.split(';')[0] if set_cookie else ''
    print('Login ok.')

    status, payload, _ = call('/api/wire-fleet', data={}, cookie=cookie)
    print(f'POST /api/wire-fleet -> HTTP {status}')
    print('  ' + json.dumps(payload)[:400])

    t0 = time.time()
    last = None
    while time.time() - t0 < 300:
        status, payload, _ = call('/api/status', cookie=cookie)
        if not isinstance(payload, dict):
            time.sleep(5)
            continue
        line = f'  t={time.time() - t0:5.1f}s  state={payload.get("state")}  appIp={payload.get("appIp")}  healthError={payload.get("healthError")}'
        if line != last:
            print(line, flush=True)
            last = line
        if payload.get('state') == 'ready':
            print(f'\nVERDRAHTET + READY nach {time.time() - t0:.1f} s')
            return 0
        time.sleep(5)
    print('Nicht "ready" innerhalb von 300 s')
    return 1


if __name__ == '__main__':
    sys.exit(main())
