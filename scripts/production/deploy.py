"""Deploy the four existing production nodes through a temporary /32 SSH rule.

Never provisions compute, disables idle timers, or exports raw remote output.
"""
import argparse
import concurrent.futures
import ipaddress
import json
import os
from pathlib import Path
import subprocess
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
NAMES = {r: 'audiomonastry-' + r + '-1' for r in ('app', 'sfu', 'media', 'edge')}
TOKEN = os.environ['HETZNER_PRODUCTION_TOKEN']


def api(method, path, body=None):
    req = urllib.request.Request('https://api.hetzner.cloud/v1/' + path,
        data=json.dumps(body).encode() if body is not None else None, method=method,
        headers={'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=45) as response:
        return json.load(response)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mode', choices=['inspect', 'deploy'], default='inspect')
    args = parser.parse_args()
    with urllib.request.urlopen('https://api.ipify.org', timeout=20) as response:
        address = response.read().decode().strip()
    assert ipaddress.ip_address(address).is_global
    servers = {s['name']: s for s in api('GET', 'servers?per_page=50')['servers']}
    nodes = {role: servers[name] for role, name in NAMES.items()}
    assert all(s['labels'].get('app') == 'audiomonastry' and s['status'] == 'running' for s in nodes.values())
    firewalls = api('GET', 'firewalls?per_page=50')['firewalls']
    selected = []
    for role, server in nodes.items():
        attached = {f['id'] for f in server['public_net']['firewalls']}
        fw = next(f for f in firewalls if f['id'] in attached and f['name'] == 'audiomonastry-prod-' + role + '-20261112')
        assert fw['labels'].get('managed-by') == 'production-deploy'
        selected.append(fw)
    with tempfile.TemporaryDirectory(prefix='audio-production-') as temp:
        private = Path(temp)
        key = private / 'key'
        key.write_text(os.environ['AUDIO_PROD_SSH_KEY'] + '\n')
        key.chmod(0o600)
        logdir = private / 'logs'
        logdir.mkdir(mode=0o700)
        changed = []
        def ssh(role, command, data=None, timeout=60):
            host = nodes[role]['public_net']['ipv4']['ip']
            result = subprocess.run(['ssh', '-F', '/dev/null', '-i', str(key), '-o', 'BatchMode=yes',
                '-o', 'StrictHostKeyChecking=accept-new', '-o', 'UserKnownHostsFile=' + str(private/'known_hosts'),
                '-o', 'ConnectTimeout=20', 'root@' + host, command], input=data, capture_output=True, timeout=timeout)
            (logdir/(role+'.last-output')).write_bytes(result.stdout + result.stderr)
            if result.returncode:
                category = next((x for x in ('Permission denied', 'Connection timed out', 'Connection refused', 'No route to host', 'Host key verification failed') if x.encode() in result.stderr), 'command failure')
                raise RuntimeError(role + ' remote command failed: ' + category + ' (exit ' + str(result.returncode) + ')')
            return result.stdout
        try:
            for fw in selected:
                rules = [dict(r, source_ips=[address+'/32']) if r.get('port') == '22' else r for r in fw['rules']]
                assert all(r['source_ips'] == [address+'/32'] for r in rules if r.get('port') == '22')
                api('POST', 'firewalls/'+str(fw['id'])+'/actions/set_rules', {'rules': rules})
                changed.append(fw)
            for role in nodes:
                result = ssh(role, "python3 - <<'CHECK'\nimport json,pathlib,subprocess\np=pathlib.Path('/opt/audiomonastry/.env')\ne=dict(l.split('=',1) for l in p.read_text().splitlines() if '=' in l and not l.startswith('#')) if p.exists() else {}\nr=subprocess.run(['docker','ps','--format','{{.Names}} {{.Status}}'],capture_output=True,text=True)\nprint(json.dumps({'envPresent':p.exists(),'studioAuthPresent':bool(e.get('STUDIO_ACCESS_TOKEN')),'supabaseUrlPresent':bool(e.get('SUPABASE_URL') or e.get('VITE_SUPABASE_URL') or e.get('VITE_SB_URL')),'containers':r.stdout.splitlines()}))\nCHECK")
                print(json.dumps({'role':role,'inventory':json.loads(result)}), flush=True)
            if args.mode == 'deploy':
                raise RuntimeError('Deployment stage requires successful inspection first')
        finally:
            for fw in changed:
                api('POST', 'firewalls/'+str(fw['id'])+'/actions/set_rules', {'rules':fw['rules']})
            print('Original restricted SSH rules restored', flush=True)

if __name__ == '__main__':
    main()
