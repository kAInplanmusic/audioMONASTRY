"""Recover and deploy owned production roles through a temporary /32 SSH rule.

Full mode restores missing roles, wires DNS, verifies CPU/RT, then tests Vast.
Idle timers remain active; raw remote output never leaves the private runner.
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
import time
import shlex
import hashlib

ROOT = Path(__file__).resolve().parents[2]
NAMES = {r: 'audiomonastry-' + r + '-1' for r in ('app', 'sfu', 'media', 'edge')}
TOKEN = os.environ.get('HETZNER_PRODUCTION_TOKEN', '')


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
    parser.add_argument('--mode', choices=['inspect', 'restore', 'diagnose', 'deploy', 'verify', 'ai', 'full', 'rt', 'rtp', 'policy'], default='inspect')
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
    if args.mode in ('restore', 'full'):
        with tempfile.TemporaryDirectory(prefix='audio-recovery-') as temp:
            key = Path(temp) / 'key'
            key.write_text(os.environ['AUDIO_PROD_SSH_KEY'] + '\n')
            key.chmod(0o600)
            public = subprocess.check_output(['ssh-keygen', '-y', '-f', str(key)], text=True).strip()
            nodes = provision.restore(api, public)
            print(json.dumps({'restoredRoles': list(nodes), 'existingDataPreserved': True}), flush=True)
        if args.mode == 'restore':
            return
        dns = subprocess.run([sys.executable,ROOT/'scripts/production/wire-dns.py','--apply'],
            cwd=ROOT,capture_output=True)
        if dns.returncode:
            raise RuntimeError('PRODUCTION_DNS_RECONCILIATION_FAILED')
        print(json.dumps({'productionDnsVerified':True}),flush=True)
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
        guardians = []
        def ssh_args(role, tty=False):
            return ['ssh', '-F', '/dev/null', '-i', str(key), '-o', 'BatchMode=yes',
                '-o', 'StrictHostKeyChecking=accept-new', '-o', 'UserKnownHostsFile=' + str(private/'known_hosts'),
                '-o', 'ConnectTimeout=20', '-tt' if tty else '-T',
                '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
                'root@' + nodes[role]['public_net']['ipv4']['ip']]
        def ssh(role, command, data=None, timeout=60):
            # Secret-bearing stdin always uses -T. Only the separate, empty
            # maintenance connection gets a PTY to be visible to `who`.
            result = subprocess.run(ssh_args(role) + [command], input=data, capture_output=True, timeout=timeout)
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
            def maintenance_session(role):
                deadline = time.monotonic() + 300
                while True:
                    try:
                        ssh(role, 'true')
                        break
                    except (RuntimeError, subprocess.TimeoutExpired) as exc:
                        if time.monotonic() >= deadline or 'Permission denied' in str(exc):
                            raise
                        time.sleep(5)
                maintenance = (ROOT / 'scripts/production/maintenance-session.py').read_text()
                guardian = subprocess.Popen(ssh_args(role, tty=True) + ['exec python3 -u -c ' + shlex.quote(maintenance)],
                    stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                guardians.append(guardian)
                for _ in range(10):
                    if guardian.poll() is not None:
                        raise RuntimeError('MAINTENANCE_SSH_SESSION_FAILED:' + role)
                    if int(ssh(role, 'who | wc -l').strip()) > 0 and ssh(role,
                            'python3 -c ' + shlex.quote("import pathlib,os;p=int(pathlib.Path('/tmp/audiomonastry-deploy.lock').read_text());os.kill(p,0);print('live')")).strip() == b'live':
                        print(json.dumps({'role': role, 'maintenanceSessionVerified': True}), flush=True)
                        return
                    time.sleep(2)
                raise RuntimeError('MAINTENANCE_SESSION_NOT_VISIBLE_TO_IDLE_POLICY:' + role)
            with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
                list(pool.map(maintenance_session, nodes))
            for role in nodes:
                result = ssh(role, "python3 - <<'CHECK'\nimport json,pathlib,subprocess\np=pathlib.Path('/opt/audiomonastry/.env')\ne=dict(l.split('=',1) for l in p.read_text().splitlines() if '=' in l and not l.startswith('#')) if p.exists() else {}\nr=subprocess.run(['docker','ps','--format','{{.Names}} {{.Status}}'],capture_output=True,text=True)\nprint(json.dumps({'envPresent':p.exists(),'studioAuthPresent':bool(e.get('STUDIO_ACCESS_TOKEN')),'supabaseUrlPresent':bool(e.get('SUPABASE_URL') or e.get('VITE_SUPABASE_URL') or e.get('VITE_SB_URL')),'containers':r.stdout.splitlines()}))\nCHECK")
                print(json.dumps({'role':role,'inventory':json.loads(result)}), flush=True)
                if args.mode=='diagnose':
                    diagnostic=(ROOT/'scripts/production/build-diagnostics.py').read_bytes()
                    print(json.dumps({'role':role,'diagnostics':json.loads(ssh(role,'python3 -',diagnostic))}),flush=True)
            if args.mode in ('deploy','verify','ai','full','rt','rtp','policy'):
                commit = subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip()
                provider = json.loads(os.environ['AUDIO_PROD_PROVIDER_ENV'])
                source_token = provider['GHCR_PASSWORD']
                # Source checkout and GHCR package pulls have separate scopes.
                # CPU-only registry QA verified this dedicated credential.
                if os.environ.get('GHCR_PASSWORD'):
                    provider['GHCR_PASSWORD'] = os.environ['GHCR_PASSWORD']
                    provider['GHCR_USERNAME'] = os.environ.get('GHCR_USERNAME') or provider['GHCR_USERNAME']
                read_env = "python3 -c \"import pathlib,json; print(json.dumps(dict(l.split('=',1) for l in (pathlib.Path('/opt/audiomonastry/.env').read_text() if pathlib.Path('/opt/audiomonastry/.env').exists() else '').splitlines() if '=' in l and not l.startswith('#'))))\""
                environments = {role:json.loads(ssh(role,read_env)) for role in nodes}
                for name in ('STUDIO_ACCESS_TOKEN','SESSION_SECRET','SCRAPE_TOKEN','TURN_STATIC_AUTH_SECRET'):
                    value = next((environments[r].get(name,'').strip('\"\'') for r in ('app','sfu','media','edge') if environments[r].get(name)),None)
                    if value: provider[name]=value
                assert len(provider.get('STUDIO_ACCESS_TOKEN',''))>=32
                provider['HCLOUD_TOKEN']=TOKEN
                rt_bundle = None
                if args.mode in ('rt','full'):
                    build_env = {key: value for key, value in os.environ.items() if key not in (
                        'HETZNER_PRODUCTION_TOKEN','AUDIO_PROD_SSH_KEY','AUDIO_PROD_PROVIDER_ENV','GHCR_PASSWORD')}
                    rt_bundle = subprocess.check_output(['npm','exec','--yes','--package=esbuild@0.25.12','--',
                        'esbuild','scripts/audit/rt-bench.ts','--bundle','--platform=node','--format=esm','--log-level=error'],
                        cwd=ROOT,env=build_env,timeout=180)
                def verify_rtp():
                    # Dependencies and browser installation run without provider
                    # credentials. Only the fixed SFU probe receives studio auth.
                    allowed = ('PATH','HOME','RUNNER_TEMP','CI','GITHUB_RUN_ID','GITHUB_SHA',
                        'RUNNER_TRACKING_ID',
                        'HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','no_proxy',
                        'NODE_EXTRA_CA_CERTS','SSL_CERT_FILE')
                    safe_env = {key:os.environ[key] for key in allowed if key in os.environ}
                    for command in (['npm','ci','--ignore-scripts'],
                                    ['npx','playwright','install','--with-deps','chromium'],
                                    ['npm','run','build:sfu-test']):
                        result = subprocess.run(command,cwd=ROOT,env=safe_env,capture_output=True,timeout=600)
                        if result.returncode:raise RuntimeError('RTP_PROBE_DEPENDENCIES_FAILED')
                    output = ROOT/'production-evidence'
                    output.mkdir(exist_ok=True)
                    probe_env = dict(safe_env,STUDIO_ACCESS_TOKEN=provider['STUDIO_ACCESS_TOKEN'])
                    result = subprocess.run(['node','scripts/production/sfu-rtp-acceptance.mjs'],
                        cwd=ROOT,env=probe_env,capture_output=True,timeout=300)
                    report = json.loads((output/'rtp.json').read_text())
                    sys.path.insert(0,str(ROOT/'scripts'))
                    from s3lite import S3Target
                    target = S3Target(endpoint=provider['CFS3_ENDPOINT'],bucket=provider['CFS3_BUCKET'],
                        access_key=provider['CFS3_ACCESS_KEY'],secret_key=provider['CFS3_SECRET_KEY'])
                    key = 'deployment/runs/'+os.environ['GITHUB_RUN_ID']+'/'+os.environ.get('GITHUB_RUN_ATTEMPT','1')+'/rtp.json'
                    target.put_bytes(key,json.dumps(report).encode(),content_type='application/json')
                    print(json.dumps({'publicSfuRtpStage':report['stage']}),flush=True)
                    if result.returncode or report['stage'] != 'passed':raise RuntimeError('PRODUCTION_RTP_ACCEPTANCE_FAILED')
                def deploy_role(role, mode):
                    source = (ROOT/('scripts/production/idle-policy.py' if mode=='policy' else 'scripts/production/rt-acceptance.py' if mode=='rt' else 'scripts/production/ai-acceptance.py' if mode=='ai' else 'scripts/production/verify.py' if mode=='verify' else 'scripts/production/bootstrap.py')).read_text()
                    updates = dict(provider)
                    if mode == 'ai':
                        updates['VAST_LABEL_TIMESTAMP'] = os.environ['GITHUB_RUN_ID']
                    config={'role':role,'commit':commit,'sourceToken':source_token,
                        'evidencePrefix':'deployment/runs/'+os.environ['GITHUB_RUN_ID']+'/'+os.environ.get('GITHUB_RUN_ATTEMPT','1'),
                        'updates':updates,'seedEnv':environments['media'],'nodes':{r:n['public_net']['ipv4']['ip'] for r,n in nodes.items()}}
                    if rt_bundle is not None:
                        config.update(rtBundleB64=base64.b64encode(rt_bundle).decode(),rtBundleSha256=hashlib.sha256(rt_bundle).hexdigest())
                    payload=json.dumps({'config':config,'source':source}).encode()
                    command="python3 -c \"import json,sys,pathlib,os;os.umask(0o077);p=json.load(sys.stdin);pathlib.Path('/root/audiomonastry-production.json').write_text(json.dumps(p['config']));pathlib.Path('/root/audiomonastry-production.py').write_text(p['source'])\" && umask 077 && python3 /root/audiomonastry-production.py > /var/log/audiomonastry-production-deploy.log 2>&1"
                    if mode in ('verify','ai','rt','policy'):
                        archive=subprocess.check_output(['git','archive','HEAD','scripts','deploy/vast'],cwd=ROOT)
                        ssh(role,'tar -xf - -C /opt/audiomonastry',archive)
                    ssh(role,command,payload,timeout=3000)
                    print(json.dumps({'role':role,'phase':mode,'phasePassed':True}),flush=True)
                for mode in (('deploy', 'policy', 'verify', 'rt', 'rtp', 'ai') if args.mode == 'full' else (args.mode,)):
                    if mode == 'rtp':
                        verify_rtp()
                        continue
                    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
                        futures=[pool.submit(deploy_role,role,mode) for role in (('app',) if mode in ('ai','rt') else nodes)]
                        for future in concurrent.futures.as_completed(futures):future.result()

        finally:
            for guardian in guardians:
                guardian.terminate()
                try:
                    guardian.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    guardian.kill()
            for fw in changed:
                api('POST', 'firewalls/'+str(fw['id'])+'/actions/set_rules', {'rules':fw['rules']})
            print('Original restricted SSH rules restored', flush=True)

if __name__ == '__main__':
    main()
