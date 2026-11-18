#!/usr/bin/env python3
"""Misst die Bereitschaft gemieteter Vast-Pods von einem temporaeren Hetzner-Server aus (Messort mit freiem Netz).

Voraussetzung: `vast-pods.py up` mit VAST_RENT_ONLY=1 hat Instanzen gemietet (state.json im State-Verzeichnis).
Ablauf: Zielliste aus dem State -> kleiner Hetzner-Server (Cloud-Init, KEINE Schluessel darauf; nur Pod-Token dieses Laufs, Zertifikate und
eine kurzlebige vorsignierte R2-PUT-URL) -> `pod_reach_probe.py` schreibt den Zeitverlauf nach R2 -> dieses Skript liest ihn und
loescht den Hetzner-Server IMMER (auch bei Fehler/Abbruch). Vast-Instanzen entfernt der Aufrufer mit `vast-pods.py down --yes`.
Umgebung: AI_POD_TOKEN (Pod-Token), CFS3_* (R2), Hetzner-Zugang entweder HCLOUD_TOKEN oder ein vom Netzwerk eingesetzter Header.
"""
import argparse
import base64
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
HETZNER = 'https://api.hetzner.cloud/v1'


def build_targets(state, ports, models_by_role):
    """Ziele fuer die Messung: Primaer- und Zweit-Hosts (`<rolle>-hedge`). `ports`: Instanz-ID -> externer Port."""
    targets = []
    for kind, items in (('', state.get('instances', {})), ('-hedge', state.get('hedges', {}))):
        for role, item in items.items():
            port = ports.get(str(item['id']))
            if not port:
                continue
            targets.append({'name': role + kind, 'host': item['host'], 'port': int(port), 'cert_pem': Path(item['cert']).read_text(),
                            'expect_models': models_by_role.get(role, [])})
    return targets


def build_user_data(probe_source, config):
    """Cloud-Init: legt Messskript und Konfiguration ab, startet die Messung und faehrt danach herunter (loeschen macht dieses Skript)."""
    def b64(text):
        return base64.b64encode(text.encode('utf-8')).decode()
    return '\n'.join([
        '#cloud-config',
        'package_update: false',
        'write_files:',
        '  - path: /opt/probe/pod_reach_probe.py', "    permissions: '0755'", '    encoding: b64', '    content: ' + b64(probe_source),
        '  - path: /opt/probe/config.json', "    permissions: '0600'", '    encoding: b64', '    content: ' + b64(json.dumps(config)),
        'runcmd:',
        '  - [ sh, -c, "python3 /opt/probe/pod_reach_probe.py /opt/probe/config.json > /var/log/probe.out 2>&1; shutdown -h now" ]',
        ''])


def hetzner(method, path, body=None):
    cmd = ['curl', '-sS', '--max-time', '40', '-X', method, '-H', 'Content-Type: application/json']
    token = os.environ.get('HCLOUD_TOKEN', '').strip()
    if token:
        cmd += ['-H', 'Authorization: Bearer ' + token]
    cmd.append(HETZNER + path)
    if body is not None:
        cmd += ['-d', json.dumps(body)]
    out = subprocess.run(cmd, capture_output=True, text=True).stdout
    data = json.loads(out) if out.strip() else {}
    if 'error' in data:
        raise RuntimeError('Hetzner %s %s: %s %s' % (method, path, data['error'].get('code'), data['error'].get('message')))
    return data


def load_pods_module():
    spec = importlib.util.spec_from_file_location('vast_pods_measure', ROOT / 'scripts/vast-pods.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def wait_ports(vp, state, minutes):
    ids = [str(i['id']) for i in list(state.get('instances', {}).values()) + list(state.get('hedges', {}).values())]
    deadline = time.time() + minutes * 60
    ports = {}
    while time.time() < deadline:
        for row in vp.instances():
            found = (row.get('ports') or {}).get('8000/tcp')
            if str(row['id']) in ids and found:
                ports[str(row['id'])] = found[0]['HostPort']
        if len(ports) == len(ids):
            break
        time.sleep(10)
    return ports


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--state-dir', type=Path, default=Path(os.environ.get('VAST_STATE_DIR', '/data/vast-fleet')))
    parser.add_argument('--server-type', default='cx23')
    parser.add_argument('--location', default='hel1')
    parser.add_argument('--probe-minutes', type=float, default=20.0)
    parser.add_argument('--port-wait-minutes', type=float, default=8.0)
    args = parser.parse_args()
    token = os.environ['AI_POD_TOKEN']
    state = json.loads((args.state_dir / 'state.json').read_text())
    vp = load_pods_module()
    fleet = json.loads((ROOT / 'deploy/gpu/pod-fleet.json').read_text())
    pods = fleet['pods'].values() if isinstance(fleet['pods'], dict) else fleet['pods']
    models_by_role = {pod['role']: pod['models'] for pod in pods}
    ports = wait_ports(vp, state, args.port_wait_minutes)
    targets = build_targets(state, ports, models_by_role)
    if not targets:
        raise SystemExit('Keine Ziele mit Port gefunden: nichts zu messen')
    from s3lite import S3Target
    r2 = S3Target.from_r2_env()
    key = 'probe/cold-start-%d.json' % int(time.time())
    config = {'token': token, 'put_url': r2.presign('PUT', key, 3600), 'max_seconds': int(args.probe_minutes * 60), 'interval': 5,
              'put_every': 30, 'targets': targets}
    user_data = build_user_data((ROOT / 'scripts/pod_reach_probe.py').read_text(), config)
    server_id = None
    try:
        created = hetzner('POST', '/servers', {'name': 'audiomonastry-probe-tmp-%d' % int(time.time()), 'server_type': args.server_type,
                                               'location': args.location, 'image': 'ubuntu-24.04', 'user_data': user_data,
                                               'start_after_create': True, 'public_net': {'enable_ipv4': True, 'enable_ipv6': False},
                                               'labels': {'purpose': 'cold-start-probe'}})
        server_id = created['server']['id']
        print(json.dumps({'hetznerServer': server_id, 'targets': [t['name'] for t in targets], 'resultKey': key}), flush=True)
        deadline = time.time() + args.probe_minutes * 60 + 180
        last = None
        while time.time() < deadline:
            time.sleep(20)
            raw = r2.get_bytes(key)
            if not raw:
                continue
            result = json.loads(raw.decode())
            summary = {name: (t['firstTlsS'], t['firstModelsS'], t['firstReadyS']) for name, t in result['targets'].items()}
            if summary != last or result.get('done'):
                print(json.dumps({'elapsedS': result['elapsedS'], 'tlsModelsReadyS': summary, 'done': result.get('done')}), flush=True)
                last = summary
            if result.get('done'):
                print(json.dumps(result), flush=True)
                return 0
        print('Messzeit abgelaufen ohne Abschluss')
        return 1
    finally:
        if server_id is not None:
            try:
                hetzner('DELETE', '/servers/%d' % server_id)
                print(json.dumps({'hetznerServerDeleted': server_id}), flush=True)
            except Exception as exc:  # noqa: BLE001
                print('FEHLER beim Loeschen des Hetzner-Servers %s: %s - von Hand loeschen!' % (server_id, str(exc)[:150]), flush=True)


if __name__ == '__main__':
    sys.exit(main())
