#!/usr/bin/env python3
"""Fragt von einem Rechner mit freiem Netz HTTP(S)-Adressen ab und schreibt Status und Antwortkopf per PUT (nur Standardbibliothek).
Aufruf: python3 http_check_probe.py <config.json>   config: {"urls": [...], "wait_seconds": 120, "tries": 6, "interval": 20, "put_url": "..."}
HTTPS wird ohne Zertifikatspruefung abgefragt (Ziel ist die Erreichbarkeit der IP, nicht das Zertifikat); es werden keine Zugangsdaten gesendet."""
import json
import ssl
import sys
import time
import urllib.error
import urllib.request


def check(url):
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE

    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *a, **k):
            return None
    opener = urllib.request.build_opener(NoRedirect, urllib.request.HTTPSHandler(context=ctx))
    try:
        with opener.open(urllib.request.Request(url, headers={'User-Agent': 'http-check'}), timeout=12) as r:
            return {'status': r.status, 'location': r.headers.get('Location'), 'server': r.headers.get('Server'), 'body': r.read(200).decode('utf-8', 'replace')}
    except urllib.error.HTTPError as exc:
        return {'status': exc.code, 'location': exc.headers.get('Location'), 'server': exc.headers.get('Server'), 'body': exc.read(200).decode('utf-8', 'replace')}
    except Exception as exc:  # noqa: BLE001
        return {'status': None, 'error': type(exc).__name__}


def put(url, payload):
    req = urllib.request.Request(url, data=json.dumps(payload).encode(), method='PUT', headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status
    except OSError as exc:
        return type(exc).__name__


def main(argv):
    config = json.loads(open(argv[1], encoding='utf-8').read())
    time.sleep(config.get('wait_seconds', 120))
    rounds = []
    for i in range(config.get('tries', 6)):
        rounds.append({'t': round(i * config.get('interval', 20)), 'results': {u: check(u) for u in config['urls']}})
        put(config['put_url'], {'done': False, 'rounds': rounds})
        if i < config.get('tries', 6) - 1:
            time.sleep(config.get('interval', 20))
    print(put(config['put_url'], {'done': True, 'rounds': rounds}))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
