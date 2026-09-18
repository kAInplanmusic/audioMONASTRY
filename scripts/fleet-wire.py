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
import sys
import time
import urllib.error
import urllib.request

PORTAL = 'https://anunnakitools.de'
UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36'


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


def call(path, data=None, cookie=None):
    body = json.dumps(data).encode() if data is not None else None
    req = urllib.request.Request(PORTAL + path, data=body, method='POST' if data is not None else 'GET')
    req.add_header('Content-Type', 'application/json')
    req.add_header('User-Agent', UA)
    req.add_header('Accept', 'application/json')
    if cookie:
        req.add_header('Cookie', cookie)
    try:
        with urllib.request.urlopen(req, timeout=40) as res:
            raw = res.read().decode()
            return res.status, (json.loads(raw) if raw.strip().startswith('{') else raw), res.headers.get('Set-Cookie') or ''
    except urllib.error.HTTPError as err:
        return err.code, err.read().decode()[:200], ''
    except Exception as err:  # noqa: BLE001
        return 0, f'{type(err).__name__}: {err}', ''


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
