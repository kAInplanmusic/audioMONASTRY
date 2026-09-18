#!/usr/bin/env python3
"""
Portal-Login → signiertes `studio`-Session-Token holen (fuer Live-4-User-Beweise).
=================================================================================
Warum: der Master-Token (STUDIO_ACCESS_TOKEN) autorisiert zwar, ist aber KEIN
Session-Token - der Server zaehlt nur Sockets mit `sessionUserId` als
Session-Mitglieder (Ghostuser/Listener bewusst nicht). Genau deshalb blieb der
Zaehler im Live-Lauf bei "SESSION 1/4": es fehlte das signierte Session-Cookie,
das im Betrieb das PORTAL setzt (POST /api/login -> set-cookie: portal=…; studio=…).

Ausgabe: nur das Token (auf stdout), damit die E2E-Suite es uebernehmen kann:
  STUDIO_ACCESS_TOKEN=$(python3 scripts/portal-studio-token.py) \
  E2E_BASE_URL=http://127.0.0.1:8080 npx playwright test tests/e2e/collab.spec.ts
"""
import json
import sys
import urllib.error
import urllib.request

PORTAL = 'https://anunnakitools.de'
UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36'


def load_env(path='.env.deploy'):
    env = {}
    with open(path, encoding='utf-8') as fh:
        for line in fh:
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                k, v = line.split('=', 1)
                env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def main():
    env = load_env()
    body = json.dumps({'user': env.get('ADMIN_USER'), 'pass': env.get('ADMIN_PASSWORD')}).encode()
    req = urllib.request.Request(PORTAL + '/api/login', data=body, method='POST')
    req.add_header('Content-Type', 'application/json')
    req.add_header('User-Agent', UA)
    with urllib.request.urlopen(req, timeout=40) as res:
        cookies = res.headers.get_all('Set-Cookie') or []
    studio = ''
    for raw in cookies:
        first = raw.split(';')[0]
        if first.startswith('studio='):
            studio = first.split('=', 1)[1]
    if not studio:
        print('kein studio-Cookie im Login erhalten', file=sys.stderr)
        return 1
    print(studio)
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except urllib.error.HTTPError as err:
        print(f'Login fehlgeschlagen: HTTP {err.code}', file=sys.stderr)
        sys.exit(1)
