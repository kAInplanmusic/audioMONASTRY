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
import time
import urllib.request

PORTAL = 'https://anunnakitools.de'
UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36'


def load_env(path='/home/patrick/audioMONASTRY/.env.deploy'):
    env = {}
    for line in open(path, encoding='utf-8'):
        line = line.strip()
        if line and not line.startswith('#') and '=' in line:
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
