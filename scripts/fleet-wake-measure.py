#!/usr/bin/env python3
"""
Flotte wecken und Wake->ready MESSEN (LIVE-P1-003 Zeile 'Wake->ready < 90 s').
=====================================================================
Ablauf: Login am Portal -> POST /api/wake -> /api/status pollen, bis
state == 'ready'. Ausgegeben wird die Zeit von der Wake-Anfrage bis 'ready'
sowie die Zwischenstaende. Keine Tokens in der Ausgabe.
"""
import json
import pathlib
import sys
import time
import urllib.error
import urllib.request

PORTAL = 'https://anunnakitools.de'

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


def call(path, data=None, cookie=None, method=None):
    # Cloudflare blockt Standard-urllib (Fehler 1010, Browser-Signatur) - der
    # Browser-UA kommt aus scripts/lib/restclient.py.
    return portal_call(PORTAL, path, data, cookie, method=method, timeout=30)


def main():
    env = load_env()
    user = env.get('ADMIN_USER')
    password = env.get('ADMIN_PASSWORD')
    if not user or not password:
        print('ADMIN_USER/ADMIN_PASSWORD fehlen in .env.deploy')
        return 1

    status, payload, set_cookie = call('/api/login', {'user': user, 'pass': password})
    if status != 200:
        print('Login fehlgeschlagen:', status, payload)
        return 1
    cookie = (set_cookie.split(';')[0] if set_cookie else '')
    if not cookie:
        print('Kein Session-Cookie erhalten')
        return 1
    print('Portal-Login ok.')

    status, payload, _ = call('/api/status', cookie=cookie)
    print('Status vor dem Wecken:', payload)

    t0 = time.time()
    status, payload, _ = call('/api/wake', data={}, cookie=cookie)
    print(f'POST /api/wake -> HTTP {status} {payload}  (t=0,0s)')
    if status != 200:
        return 1

    last = None
    while time.time() - t0 < 600:
        status, payload, _ = call('/api/status', cookie=cookie)
        elapsed = time.time() - t0
        if not isinstance(payload, dict):
            print(f'  t={elapsed:6.1f}s  unerwartete Antwort ({status}): {str(payload)[:120]}', flush=True)
            time.sleep(5)
            continue
        state = payload.get('state')
        line = f'  t={elapsed:6.1f}s  state={state}  created={payload.get("created")}/{payload.get("total")}'
        if payload.get('states'):
            line += '  ' + ', '.join(payload['states'])
        if payload.get('healthError'):
            line += f"  healthError={payload['healthError']}"
        if line != last:
            print(line, flush=True)
            last = line
        if state == 'ready':
            print(f'\nWAKE->READY: {elapsed:.1f} s  (Ziel: < 90 s)  url={payload.get("url")}  appIp={payload.get("appIp")}')
            return 0
        time.sleep(5)
    print('Timeout: nicht "ready" innerhalb von 600 s')
    return 1


if __name__ == '__main__':
    sys.exit(main())
