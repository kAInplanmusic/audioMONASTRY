#!/usr/bin/env python3
"""Misst von einem Rechner mit freiem Netz, wann Vast-Pods per TLS erreichbar und bereit sind (nur Standardbibliothek).

Aufruf: python3 pod_reach_probe.py <config.json>
config: {"token": "...", "put_url": "https://... oder http://...", "max_seconds": 1500, "interval": 5, "put_every": 30,
         "targets": [{"name": "audio-brain", "host": "1.2.3.4", "port": 12345, "cert_pem": "...", "expect_models": ["qwen3-4b"]}]}
Je Ziel wird der Zeitverlauf festgehalten (Sekunden seit Start): erste TCP-Verbindung, erster TLS-Handshake, erstes /models mit
den erwarteten geladenen Modellen, erstes /ready=200, Fehlerarten. Der Stand wird regelmaessig per PUT an `put_url` geschrieben.
Das Token ist ein Einmal-Pod-Token dieses Laufs; es wird nie ausgegeben.
"""
import json
import os
import socket
import ssl
import sys
import tempfile
import time
import urllib.request


def now():
    return time.time()


def make_context(cert_pem):
    handle = tempfile.NamedTemporaryFile('w', suffix='.pem', delete=False)
    handle.write(cert_pem)
    handle.close()
    context = ssl.create_default_context(cafile=handle.name)
    os.unlink(handle.name)
    return context


def request(host, port, path, token, context, timeout=10):
    """Ein GET ueber TLS. Rueckgabe (Phase, Statuscode oder None, Text). Phase = 'tcp' | 'tls' | 'http'."""
    phase = 'tcp'
    try:
        raw = socket.create_connection((host, port), timeout=timeout)
    except OSError as exc:
        return 'none', None, type(exc).__name__
    tls = None
    try:
        phase = 'tcp'
        raw.settimeout(timeout)
        tls = context.wrap_socket(raw, server_hostname=host)
        phase = 'tls'
        tls.sendall(('GET %s HTTP/1.1\r\nHost: %s\r\nAuthorization: Bearer %s\r\nConnection: close\r\n\r\n' % (path, host, token)).encode())
        data = b''
        while True:
            chunk = tls.recv(65536)
            if not chunk:
                break
            data += chunk
            if len(data) > 1 << 20:
                break
        head, _, body = data.partition(b'\r\n\r\n')
        status = int(head.split(b' ', 2)[1]) if head.startswith(b'HTTP/') else None
        return 'http', status, body.decode('utf-8', errors='replace')
    except (OSError, ssl.SSLError, ValueError, IndexError) as exc:
        return phase, None, type(exc).__name__
    finally:
        for sock in (tls, raw):
            try:
                if sock is not None:
                    sock.close()
            except OSError:
                pass


def loaded_models(body):
    try:
        return sorted(m['id'] for m in json.loads(body).get('models', []) if m.get('loaded'))
    except (ValueError, TypeError, AttributeError, KeyError):
        return None


def new_target_state():
    return {'firstTcpS': None, 'firstTlsS': None, 'firstModelsS': None, 'firstReadyS': None, 'lastReadyStatus': None,
            'errors': {}, 'attempts': 0}


def step(target, state, token, context, t0):
    """Ein Messdurchlauf fuer ein Ziel (aktualisiert `state`). Gibt True zurueck, wenn das Ziel fertig ist (/ready=200)."""
    elapsed = round(now() - t0, 1)
    state['attempts'] += 1
    phase, status, text = request(target['host'], target['port'], '/models', token, context)
    if phase in ('tcp', 'tls', 'http') and state['firstTcpS'] is None:
        state['firstTcpS'] = elapsed
    if phase in ('tls', 'http') and state['firstTlsS'] is None:
        state['firstTlsS'] = elapsed
    if phase == 'http' and status == 200:
        got = loaded_models(text)
        if got is not None and set(target.get('expect_models', [])) <= set(got) and state['firstModelsS'] is None:
            state['firstModelsS'] = elapsed
    elif status is None:
        state['errors'][text] = state['errors'].get(text, 0) + 1
    else:
        key = 'HTTP %s' % status
        state['errors'][key] = state['errors'].get(key, 0) + 1
    if state['firstModelsS'] is not None:
        phase2, status2, _ = request(target['host'], target['port'], '/ready', token, context)
        state['lastReadyStatus'] = status2
        if status2 == 200 and state['firstReadyS'] is None:
            state['firstReadyS'] = elapsed
    return state['firstReadyS'] is not None


def put_json(url, payload):
    data = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data, method='PUT', headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=20) as response:
            return response.status
    except OSError as exc:
        return type(exc).__name__


def run(config, sleep=time.sleep):
    t0 = now()
    token = config['token']
    contexts = {t['name']: make_context(t['cert_pem']) for t in config['targets']}
    states = {t['name']: new_target_state() for t in config['targets']}
    done = set()
    last_put = 0.0
    result = {'startedEpoch': t0, 'host': socket.gethostname(), 'done': False, 'elapsedS': 0, 'targets': states}
    while now() - t0 < config.get('max_seconds', 1500) and len(done) < len(config['targets']):
        for target in config['targets']:
            if target['name'] in done:
                continue
            if step(target, states[target['name']], token, contexts[target['name']], t0):
                done.add(target['name'])
        result['elapsedS'] = round(now() - t0, 1)
        if now() - last_put >= config.get('put_every', 30):
            put_json(config['put_url'], result)
            last_put = now()
        if len(done) < len(config['targets']):
            sleep(config.get('interval', 5))
    result['done'] = True
    result['allReady'] = len(done) == len(config['targets'])
    result['elapsedS'] = round(now() - t0, 1)
    status = put_json(config['put_url'], result)
    return result, status


def main(argv):
    config = json.loads(open(argv[1], encoding='utf-8').read())
    result, status = run(config)
    print(json.dumps({'allReady': result['allReady'], 'elapsedS': result['elapsedS'], 'finalPut': status}))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
