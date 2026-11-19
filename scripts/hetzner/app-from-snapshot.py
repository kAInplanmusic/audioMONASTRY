#!/usr/bin/env python3
"""Stellt den App-Server aus einem Hetzner-Snapshot wieder her und uebergibt ihm die geprueften Vast-Pod-Adressen (Cloud-Init, keine Schluessel).

Ablauf: Server aus Snapshot (neue IPv4), Cloud-Init legt die CA nach /opt/audiomonastry/vast-ca/ca.pem, fuehrt die Pod-Werte in
/opt/audiomonastry/.env zusammen (vorhandene Schluessel werden ersetzt, alles andere bleibt) und erzeugt den App-Container neu.
Optional (--check): kleiner Messserver fragt danach die neue IP per HTTP(S) ab und schreibt das Ergebnis nach R2.
DNS wird NICHT geaendert. Hetzner-Zugang entweder HCLOUD_TOKEN oder ein vom Netzwerk eingesetzter Header.
"""
import argparse
import base64
import json
import os
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
HETZNER = 'https://api.hetzner.cloud/v1'

APPLY = '''#!/usr/bin/env python3
import os, subprocess
env_path = '/opt/audiomonastry/.env'
new = {}
for line in open('/root/vast-runtime.env', encoding='utf-8'):
    if '=' in line:
        key, value = line.rstrip('\\n').split('=', 1)
        new[key] = value
kept = []
if os.path.exists(env_path):
    kept = [l for l in open(env_path, encoding='utf-8').read().splitlines() if l.partition('=')[0] not in new]
tmp = env_path + '.vast-new'
with open(tmp, 'w', encoding='utf-8') as fh:
    fh.write('\\n'.join(kept + [k + '=' + v for k, v in new.items()]) + '\\n')
os.chmod(tmp, 0o600)
os.replace(tmp, env_path)
subprocess.run(['docker', 'compose', '-f', 'docker-compose.hetzner.yml', 'up', '-d', '--no-build', '--force-recreate', 'audiomonastry'],
               cwd='/opt/audiomonastry', check=False)
print('vast runtime applied')
'''


def build_user_data(runtime_env_text, ca_pem):
    def b64(text):
        return base64.b64encode(text.encode('utf-8')).decode()
    return '\n'.join([
        '#cloud-config',
        'write_files:',
        '  - path: /opt/audiomonastry/vast-ca/ca.pem', "    permissions: '0644'", '    encoding: b64', '    content: ' + b64(ca_pem),
        '  - path: /root/vast-runtime.env', "    permissions: '0600'", '    encoding: b64', '    content: ' + b64(runtime_env_text),
        '  - path: /root/apply-vast-runtime.py', "    permissions: '0700'", '    encoding: b64', '    content: ' + b64(APPLY),
        'runcmd:',
        '  - [ sh, -c, "sleep 25; python3 /root/apply-vast-runtime.py > /var/log/apply-vast-runtime.log 2>&1" ]',
        ''])


def hetzner(method, path, body=None):
    cmd = ['curl', '-sS', '--max-time', '60', '-X', method, '-H', 'Content-Type: application/json']
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


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--snapshot-id', type=int, required=True)
    parser.add_argument('--runtime-env', type=Path, required=True)
    parser.add_argument('--ca', type=Path, required=True)
    parser.add_argument('--name', default='audiomonastry-prod')
    parser.add_argument('--server-type', default='ccx33')
    parser.add_argument('--location', default='hel1')
    parser.add_argument('--firewall', type=int, help='Firewall-ID, die angehaengt wird (optional)')
    parser.add_argument('--check', action='store_true', help='Messserver fragt die neue IP danach per HTTP(S) ab')
    args = parser.parse_args()
    existing = hetzner('GET', '/servers?per_page=50')['servers']
    if any(s['name'] == args.name for s in existing):
        raise SystemExit('Ein Server %s existiert bereits: nichts angelegt' % args.name)
    body = {'name': args.name, 'server_type': args.server_type, 'location': args.location, 'image': str(args.snapshot_id),
            'user_data': build_user_data(args.runtime_env.read_text(), args.ca.read_text()), 'start_after_create': True,
            'public_net': {'enable_ipv4': True, 'enable_ipv6': True}, 'labels': {'purpose': 'audiomonastry-app', 'restored-from': str(args.snapshot_id)}}
    if args.firewall:
        body['firewalls'] = [{'firewall': args.firewall}]
    created = hetzner('POST', '/servers', body)
    server = created['server']
    ip = server['public_net']['ipv4']['ip']
    print(json.dumps({'appServer': server['id'], 'ipv4': ip, 'type': args.server_type, 'location': args.location}), flush=True)
    for _ in range(40):
        time.sleep(6)
        status = hetzner('GET', '/servers/%d' % server['id'])['server']['status']
        if status == 'running':
            break
    print(json.dumps({'appServerStatus': status}), flush=True)
    if args.check:
        from s3lite import S3Target
        r2 = S3Target.from_r2_env()
        key = 'probe/app-check-%d.json' % int(time.time())
        config = {'urls': ['http://%s/' % ip, 'https://%s/' % ip, 'http://%s:8080/api/health' % ip], 'wait_seconds': 150, 'tries': 8, 'interval': 20,
                  'put_url': r2.presign('PUT', key, 3600)}
        probe = (ROOT / 'scripts/hetzner/http_check_probe.py').read_text()
        ud = '\n'.join(['#cloud-config', 'write_files:'] + [
            '  - path: /opt/probe/%s' % name + "\n    permissions: '0755'\n    encoding: b64\n    content: " + base64.b64encode(text.encode()).decode()
            for name, text in (('http_check_probe.py', probe), ('config.json', json.dumps(config)))] +
            ['runcmd:', '  - [ sh, -c, "python3 /opt/probe/http_check_probe.py /opt/probe/config.json > /var/log/probe.out 2>&1; shutdown -h now" ]', ''])
        probe_server = hetzner('POST', '/servers', {'name': 'audiomonastry-probe-tmp-%d' % int(time.time()), 'server_type': 'cx23', 'location': args.location,
                                                    'image': 'ubuntu-24.04', 'user_data': ud, 'start_after_create': True,
                                                    'public_net': {'enable_ipv4': True, 'enable_ipv6': False}, 'labels': {'purpose': 'app-check'}})['server']
        print(json.dumps({'checkServer': probe_server['id'], 'resultKey': key}), flush=True)
    return 0


if __name__ == '__main__':
    sys.exit(main())
