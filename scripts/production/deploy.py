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
import base64
import sys
import urllib.request
import urllib.error
import provision

ROOT = Path(__file__).resolve().parents[2]
NAMES = {r: 'audiomonastry-' + r + '-1' for r in ('app', 'sfu', 'media', 'edge')}
TOKEN = os.environ['HETZNER_PRODUCTION_TOKEN']


def api(method, path, body=None):
    req = urllib.request.Request('https://api.hetzner.cloud/v1/' + path,
        data=json.dumps(body).encode() if body is not None else None, method=method,
        headers={'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=45) as response:
            return json.load(response)
    except urllib.error.HTTPError as exc:
        try:
            error = json.load(exc).get('error', {})
            code = error.get('code', '')
            if not isinstance(code, str) or not code.replace('_', '').isalnum():
                code = 'unclassified'
        except (ValueError, AttributeError):
            code = 'unclassified'
        if code == 'resource_limit_exceeded':
            # This provider category contains the exhausted quota, not a request
            # payload. Keep a restrictive character allowlist and redact secrets.
            detail = str(error.get('message', ''))
            for value in (TOKEN, os.environ.get('AUDIO_PROD_SSH_KEY', '')):
                if value:
                    detail = detail.replace(value, '[redacted]')
            detail = ''.join(c for c in detail[:240] if c.isalnum() or c in ' .,:_-()')
            print(json.dumps({'hetznerQuotaError': detail}), flush=True)
            if detail.lower() == 'shared core limit exceeded':
                code += ':shared_core'
        raise RuntimeError('HETZNER_HTTP_' + str(exc.code) + ':' + code) from None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mode', choices=['inspect', 'restore', 'diagnose', 'deploy', 'verify', 'ai'], default='inspect')
    args = parser.parse_args()
    if args.mode == 'inspect':
        servers = api('GET', 'servers?per_page=50')['servers']
        print(json.dumps({'expectedNodes': [
            {'role': role, 'present': any(s['name'] == name for s in servers),
             'status': next((s['status'] for s in servers if s['name'] == name), 'missing')}
            for role, name in NAMES.items()]}), flush=True)
        provider = json.loads(os.environ.get('AUDIO_PROD_PROVIDER_ENV') or '{}')
        required = ('VAST_API_KEY', 'AI_POD_TOKEN', 'GHCR_USERNAME', 'GHCR_PASSWORD',
                    'CFS3_ACCESS_KEY', 'CFS3_SECRET_KEY', 'CFS3_BUCKET', 'CFS3_ENDPOINT',
                    'SUPABASE_URL', 'SUPABASE_ANON_PUB', 'STUDIO_ACCESS_TOKEN')
        print(json.dumps({'missingProviderVariables': [k for k in required if not provider.get(k)]}), flush=True)
        if provider.get('VAST_API_KEY'):
            request = urllib.request.Request('https://console.vast.ai/api/v0/users/current/',
                headers={'Authorization': 'Bearer ' + provider['VAST_API_KEY']})
            try:
                with urllib.request.urlopen(request, timeout=30) as response:
                    account = json.load(response)
                print(json.dumps({'vastBalanceUsd': account.get('balance'),
                                  'vastCreditUsd': account.get('credit')}), flush=True)
            except urllib.error.HTTPError as exc:
                print(json.dumps({'vastAccountHttpStatus': exc.code}), flush=True)
        images = api('GET', 'images?type=snapshot&per_page=50')['images']
        print(json.dumps({'roleSnapshots': [
            {'id': x['id'], 'description': x.get('description'), 'labels': x.get('labels'),
             'created': x.get('created'), 'diskSize': x.get('disk_size')}
            for x in images if 'audiomonastry' in str(x.get('description', '')).lower()
            or x.get('labels', {}).get('app') == 'audiomonastry']}), flush=True)
        return
    if args.mode == 'restore':
        with tempfile.TemporaryDirectory(prefix='audio-recovery-') as temp:
            key = Path(temp) / 'key'
            key.write_text(os.environ['AUDIO_PROD_SSH_KEY'] + '\n')
            key.chmod(0o600)
            public = subprocess.check_output(['ssh-keygen', '-y', '-f', str(key)], text=True).strip()
            nodes = provision.restore(api, public)
            print(json.dumps({'restoredRoles': list(nodes), 'existingDataPreserved': True}), flush=True)
        return
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
                if args.mode=='diagnose':
                    diagnostic=(ROOT/'scripts/production/build-diagnostics.py').read_bytes()
                    print(json.dumps({'role':role,'diagnostics':json.loads(ssh(role,'python3 -',diagnostic))}),flush=True)
            if args.mode in ('deploy','verify','ai'):
                commit = subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip()
                provider = json.loads(os.environ['AUDIO_PROD_PROVIDER_ENV'])
                read_env = "python3 -c \"import pathlib,json; print(json.dumps(dict(l.split('=',1) for l in (pathlib.Path('/opt/audiomonastry/.env').read_text() if pathlib.Path('/opt/audiomonastry/.env').exists() else '').splitlines() if '=' in l and not l.startswith('#'))))\""
                environments = {role:json.loads(ssh(role,read_env)) for role in nodes}
                for name in ('STUDIO_ACCESS_TOKEN','SESSION_SECRET','SCRAPE_TOKEN','TURN_STATIC_AUTH_SECRET'):
                    value = next((environments[r].get(name,'').strip('\"\'') for r in ('app','sfu','media','edge') if environments[r].get(name)),None)
                    if value: provider[name]=value
                assert len(provider.get('STUDIO_ACCESS_TOKEN',''))>=32
                source = (ROOT/('scripts/production/ai-acceptance.py' if args.mode=='ai' else 'scripts/production/verify.py' if args.mode=='verify' else 'scripts/production/bootstrap.py')).read_text()
                def deploy_role(role):
                    config={'role':role,'commit':commit,'sourceToken':provider['GHCR_PASSWORD'],
                        'updates':provider,'seedEnv':environments['media'],'nodes':{r:n['public_net']['ipv4']['ip'] for r,n in nodes.items()}}
                    payload=json.dumps({'config':config,'source':source}).encode()
                    command="python3 -c \"import json,sys,pathlib,os;os.umask(0o077);p=json.load(sys.stdin);pathlib.Path('/root/audiomonastry-production.json').write_text(json.dumps(p['config']));pathlib.Path('/root/audiomonastry-production.py').write_text(p['source'])\" && umask 077 && python3 /root/audiomonastry-production.py > /var/log/audiomonastry-production-deploy.log 2>&1"
                    if args.mode in ('verify','ai'):
                        archive=subprocess.check_output(['git','archive','HEAD','scripts','deploy/vast'],cwd=ROOT)
                        ssh(role,'tar -xf - -C /opt/audiomonastry',archive)
                    ssh(role,command,payload,timeout=3000)
                    print(json.dumps({'role':role,'deployment':'services_started'}),flush=True)
                with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
                    futures=[pool.submit(deploy_role,role) for role in (('app',) if args.mode=='ai' else nodes)]
                    for future in concurrent.futures.as_completed(futures):future.result()

        finally:
            for fw in changed:
                api('POST', 'firewalls/'+str(fw['id'])+'/actions/set_rules', {'rules':fw['rules']})
            print('Original restricted SSH rules restored', flush=True)

if __name__ == '__main__':
    main()
