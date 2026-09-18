#!/usr/bin/env python3
"""
Flotte wecken und Wake->ready MESSEN (LIVE-P1-003 Zeile 'Wake->ready < 90 s').
=====================================================================
Ablauf: Login am Portal -> POST /api/wake -> /api/status pollen, bis
state == 'ready'. Ausgegeben wird die Zeit von der Wake-Anfrage bis 'ready'
sowie die Zwischenstaende. Keine Tokens in der Ausgabe.
"""
import json
import sys
import time
import urllib.error
import urllib.request

PORTAL = 'https://anunnakitools.de'


def load_env(path='.env.deploy'):
    env = {}
    with open(path, encoding='utf-8') as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            k, v = line.split('=', 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def call(path, data=None, cookie=None, method=None):
    body = json.dumps(data).encode() if data is not None else None
    req = urllib.request.Request(PORTAL + path, data=body, method=method or ('POST' if data is not None else 'GET'))
    req.add_header('Content-Type', 'application/json')
    # Cloudflare blockt Standard-urllib (Fehler 1010, Browser-Signatur) - ein
    # normaler Browser-UA ist fuer die Portal-API noetig.
    req.add_header('User-Agent', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36')
    req.add_header('Accept', 'application/json')
    if cookie:
        req.add_header('Cookie', cookie)
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            raw = res.read().decode()
            set_cookie = res.headers.get('Set-Cookie') or ''
            return res.status, (json.loads(raw) if raw.strip().startswith('{') else raw), set_cookie
    except urllib.error.HTTPError as err:
        return err.code, err.read().decode()[:200], ''
    except Exception as err:  # noqa: BLE001
        return 0, f'{type(err).__name__}: {err}', ''


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
