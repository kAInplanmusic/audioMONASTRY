"""Vast provider adapter. Models, revisions, hashes and base images remain SSOT.

API secrets, TLS keys, instance addresses and generated runtime env stay in a
private state directory. No live cutover until all eight role inventories pass.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import base64
import hashlib
import importlib.util
import ipaddress
import json
import math
import os
from pathlib import Path
import re
import shlex
import ssl
import subprocess
import time
import threading
import zlib
import urllib.error
import urllib.request
import urllib.parse

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('vast_plan', ROOT / 'scripts/vast-fleet-plan.py')
planner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(planner)
shared = planner.fleet_module
POLICY = ROOT / 'deploy/gpu-provider.json'
PREFIX = 'audiomonastry-vast-'
API = 'https://console.vast.ai'


def provider_failure(instance):
    message = str(instance.get('status_msg') or '').lower()
    failures = {'registry-auth-rejected': ('unauthorized', 'authentication required', 'pull access denied', 'denied:'),
                'image-pull-failed': ('failed to pull', 'manifest unknown', 'image not found'),
                'disk-full': ('no space left', 'disk full')}
    return next((code for code, phrases in failures.items() if any(p in message for p in phrases)), None)
_API_LOCK = threading.Lock()
_LAST_API_REQUEST = 0.0
_LAST_CREATE_REQUEST = 0.0


def fail_on_terminal_readiness(error, role):
    """A failed startup does not retry itself; avoid paying until the deadline."""
    if error.code != 503:
        return
    try:
        status = json.loads(error.read(65536))
    except (ValueError, OSError):
        return
    if isinstance(status, dict) and status.get('status') == 'failed':
        # Do not export loader messages: they can contain paths or signed URLs.
        code = status.get('errorCode')
        allowed = {'PERMISSION_DENIED', 'DISK_FULL', 'DISK_SPACE_INSUFFICIENT',
            'CHECKPOINT_HASH_MISMATCH', 'ARCHIVE_INVALID', 'DOWNLOAD_CONNECTION_FAILED',
            'DEPENDENCY_MISSING', 'BOOTSTRAP_FAILED', 'BOOTSTRAP_PROCESS_EXITED', 'DOWNLOAD_HTTP_ERROR', 'HOST_MEMORY_EXHAUSTED'}
        allowed.update('DOWNLOAD_HTTP_' + str(x) for x in (400,401,403,404,429,500,502,503,504))
        suffix = ' (' + code + ')' if isinstance(code, str) and code in allowed else ''
        exitcode = status.get('childExitCode')
        if type(exitcode) is int and -128 <= exitcode <= 255:
            suffix += ' exit=' + str(exitcode)
        raise RuntimeError('Terminal model readiness failure: ' + role + suffix)


def fail_on_terminal_instance(instance, role):
    """Preserve the observed provider state without exporting provider messages."""
    status = instance.get('actual_status')
    if status in ('exited', 'unknown', 'offline'):
        raise RuntimeError('Terminal instance status: ' + role + ' (' + status + ')')


def api(method, path, body=None, _attempt=0):
    global _LAST_API_REQUEST, _LAST_CREATE_REQUEST
    create = method == 'PUT' and path.startswith('/api/v0/asks/')
    with _API_LOCK:
        now = time.monotonic()
        delay = max(0, 1.1 - (now - _LAST_API_REQUEST), 5.0 - (now - _LAST_CREATE_REQUEST) if create else 0)
        time.sleep(delay)
        _LAST_API_REQUEST = time.monotonic()
        if create:
            _LAST_CREATE_REQUEST = _LAST_API_REQUEST
    key = os.environ.get('VAST_API_KEY', '')
    if not key:
        raise RuntimeError('VAST_API_KEY missing')
    req = urllib.request.Request(API + path, method=method,
        headers={'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'},
        data=None if body is None else json.dumps(body).encode())
    try:
        with urllib.request.urlopen(req, timeout=60) as response:
            return json.load(response) if response.status != 204 else {}
    except urllib.error.HTTPError as exc:
        if exc.code == 429 and _attempt < 3:
            try:
                pause = float(exc.headers.get('Retry-After') or 5)
            except ValueError:
                pause = 5
            if math.isfinite(pause) and 0 <= pause <= 30:
                time.sleep(max(5, pause))
                if create:
                    matches = [item for item in instances() if item.get('label') == (body or {}).get('label')]
                    if len(matches) == 1:
                        return {'success': True, 'new_contract': matches[0]['id']}
                    if len(matches) > 1:
                        raise RuntimeError('Ambiguous allocation label after rate limit')
                    raise RuntimeError('Vast API HTTP 429: create rate limited; no paid retry')
                return api(method, path, body, _attempt + 1)
        detail = ''
        try:
            error = json.loads(exc.read())
            detail = error.get('msg') or error.get('message') or error.get('detail') or error.get('error') or ''
            if not isinstance(detail, str):
                detail = ''
            for name, value in os.environ.items():
                if any(marker in name for marker in ('TOKEN', 'KEY', 'SECRET', 'PASSWORD')) and len(value) >= 8:
                    detail = detail.replace(value, '[redacted]')
            detail = re.sub(r'https?://[^\s]+', '[url]', detail)
            detail = re.sub(r'[A-Za-z0-9_./:@?&=%+\-]{24,}', '[identifier]', detail)[:240]
        except (ValueError, OSError):
            pass
        raise RuntimeError('Vast API HTTP ' + str(exc.code) + (': ' + detail if detail else '')) from None


def instances():
    data, cursor, seen = [], '', set()
    while True:
        result = api('GET', '/api/v1/instances?limit=25' +
                     ('&after_token=' + urllib.parse.quote(cursor, safe='') if cursor else ''))
        batch = result.get('instances', result.get('results', result.get('data', [])))
        if not isinstance(batch, list):
            raise RuntimeError('Unrecognized Vast instance list')
        ids = {x['id'] for x in batch}
        if ids & seen:
            raise RuntimeError('Repeated Vast instance page; refusing incomplete cost inventory')
        seen |= ids
        data += batch
        cursor = result.get('next_token') or ''
        if not cursor:
            return data


def cost_check(plan, policy, foreign_usd=0):
    choice = plan.get('boundedTestAssignment') or plan.get('lowTransferFastAssignment') or plan.get('fastExecutorAndSongAssignment')
    if not choice or len(choice['roles']) != 8:
        raise RuntimeError('No complete eight-role offer assignment')
    budget = plan['budget']
    if not math.isfinite(float(choice['usdPerHourIncludingDisk'])) or not math.isfinite(foreign_usd) or foreign_usd < 0:
        raise RuntimeError('Invalid hourly quote')
    total = (float(choice['usdPerHourIncludingDisk']) + foreign_usd) * budget['usdToEur'] * budget['taxMultiplier']
    total += budget['unbilledEurPerHourReserve'] + policy['otherServicesEurPerHourReserve']
    if not math.isfinite(total) or total >= policy['maxTotalEurPerHour']:
        raise RuntimeError('Total hourly estimate is not below authorized 8 EUR/h')
    return choice, total


def private_write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.touch(mode=0o600)
    path.chmod(0o600)
    path.write_text(value)


def certificate(directory, role, host):
    if not ipaddress.ip_address(host).is_global:
        raise RuntimeError('Vast host must have a public IP')
    cert, key = directory / (role + '.crt'), directory / (role + '.key')
    subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', str(key), '-out', str(cert), '-days', '30', '-subj', '/CN=audiomonastry-' + role,
        '-addext', 'subjectAltName=IP:' + host], capture_output=True, check=True)
    key.chmod(0o600)
    return cert, key


def compact_environment(env):
    env = dict(env)
    raw = env.pop('AI_WEIGHTS_URLS', '[]').encode('utf-8')
    if len(raw) > 2 * 1024 * 1024:
        raise RuntimeError('Weight manifest exceeds runtime decoding limit')
    env['VAST_WEIGHTS_ZLIB_B64'] = base64.b64encode(zlib.compress(raw, level=9)).decode('ascii')
    # Leave room for Vast's serialization/port flags beneath its 32 KB ceiling.
    if len(json.dumps(env).encode('utf-8')) > 28 * 1024:
        raise RuntimeError('Vast environment exceeds safe 28 KB payload limit')
    return env


def destroy(ident):
    if not str(ident).isdigit():
        raise RuntimeError('Invalid Vast instance ID')
    api('DELETE', '/api/v0/instances/' + str(ident) + '/')


def fresh_offer(pod, models, fleet, selected, reserved=None):
    """Refresh the ask ID on the same chosen physical host before its purchase."""
    query = planner.query(pod, models)
    query['machine_id'] = {'eq': selected['machineId']}
    found = [(offer, planner.candidate(offer, pod, fleet, models)) for offer in planner.search(query)]
    found = [(offer, quote) for offer, quote in found if quote and quote['gpu'] == selected['gpu']]
    if not found and reserved is not None:
        # Choose another *unbought* host for this role. No second contract is
        # purchased for an allocated role, and HTTP create failures still abort.
        alternatives = planner.search(planner.query(pod, models))
        found = [(offer, planner.candidate(offer, pod, fleet, models)) for offer in alternatives]
        found = [(offer, quote) for offer, quote in found if quote and quote['machineId'] not in reserved]
    if not found:
        raise RuntimeError('Selected offer no longer available: ' + pod['role'])
    return min(found, key=lambda pair: pair[1]['usdPerHourIncludingDisk'])


def run(args):
    policy = json.loads(POLICY.read_text())
    state_dir = args.state_dir.resolve()
    state_path = state_dir / 'state.json'
    if args.command == 'status':
        owned = [x for x in instances() if str(x.get('label', '')).startswith(PREFIX)]
        print(json.dumps({'instances': len(owned), 'roles': [x.get('label') for x in owned]}))
        return 0
    if args.command == 'down':
        if not args.yes:
            raise RuntimeError('--yes required')
        # Only IDs recorded by this deployment, never a provider-wide sweep.
        state = json.loads(state_path.read_text()) if state_path.exists() else {'instances': {}}
        live = {str(x['id']): x for x in instances()}
        recorded_ids = {str(item['id']) for item in state['instances'].values()}
        for ident, item in live.items():
            if ident not in recorded_ids and item.get('label') in state.get('pendingLabels', []):
                state['instances'].setdefault('reconciled-' + ident,
                    {'id': item['id'], 'label': item['label']})
        state['allocationsEverCreated'] = max(state.get('allocationsEverCreated', 0), len(state['instances']))
        for item in state['instances'].values():
            current = live.get(str(item['id']))
            if current:
                if current.get('label') != item['label'] or not item['label'].startswith(PREFIX):
                    raise RuntimeError('Instance ownership mismatch; refusing deletion')
                try:
                    destroy(item['id'])
                except RuntimeError:
                    # A lost response or concurrent independent cleanup can
                    # already have deleted it. Inventory below is authoritative.
                    pass
        remaining = {str(x['id']) for x in instances()}
        if any(str(x['id']) in remaining for x in state['instances'].values()):
            raise RuntimeError('Vast deletion not confirmed')
        state['instances'] = {}
        state['promoted'] = False
        private_write(state_path, json.dumps(state))
        (state_dir / 'runtime.env').unlink(missing_ok=True)
        return 0
    plan = json.loads(args.plan.read_text())
    # Plan freshness is checked again per host immediately before any allocation.
    account = api('GET', '/api/v0/users/current/')
    existing = instances()
    if existing:
        raise RuntimeError('Account already has instances; reconcile all storage and transfer costs first')
    choice, total = cost_check(plan, policy)
    credit = float(account.get('balance') or 0) + float(account.get('credit') or 0)
    summary = {'provider': 'vast', 'estimatedTotalEurPerHour': round(total, 4),
               'hourlyCeiling': policy['maxTotalEurPerHour'], 'positiveCredit': credit > 0,
               'instancesCreated': 0, 'modelsChanged': False, 'r2ObjectsModified': False}
    print(json.dumps(summary), flush=True)
    # No implicit topup and no allocation when the account cannot pay.
    if not math.isfinite(credit) or credit <= 0:
        raise RuntimeError('Vast account balance is zero; rental blocked')
    if args.command == 'preflight':
        return 0
    if not args.yes:
        raise RuntimeError('--yes required')
    if not args.images or not args.images.exists():
        raise RuntimeError('Digest-pinned Vast TLS image map missing')
    images = json.loads(args.images.read_text())
    token = shared.require('AI_POD_TOKEN', 32)
    username, password = shared.require('GHCR_USERNAME'), shared.require('GHCR_PASSWORD')
    registry_spec = importlib.util.spec_from_file_location('ghcr_probe', ROOT / 'scripts/ghcr-registry-probe.py')
    registry_probe = importlib.util.module_from_spec(registry_spec)
    registry_spec.loader.exec_module(registry_probe)
    access = registry_probe.probe(username, password, images)
    if not access.get('allEightImagesReadable'):
        raise RuntimeError('Registry image preflight failed; no GPU allocation authorized')
    print(json.dumps({'registryManifestsVerified': 8, 'instancesCreated': 0}), flush=True)
    fleet, models = shared.load_fleet(), shared.load_models()
    target = shared.s3lite.S3Target.from_r2_env()
    pods = fleet['pods'] + [fleet['visPod']]
    prepared = {}
    # Validate every image, weight set and fresh host quote before buying any GPU.
    def prepare(pod):
        role = pod['role']
        image = images.get(role, '')
        if not re.fullmatch(r'ghcr\.io/kainplanmusic/audiomonastry-ai-runtime-vast@sha256:[0-9a-f]{64}', image):
            raise RuntimeError('Unpinned Vast image: ' + role)
        entries, missing = shared.weight_entries(pod, models, target, fleet['weights']['prefix'],
                                                int(fleet['weights']['urlTtlSeconds']))
        if missing:
            raise RuntimeError('Existing R2 weights missing: ' + role)
        raw, fresh = fresh_offer(pod, models, fleet, choice['roles'][role])
        return role, fresh, (pod, raw, entries, image)
    with ThreadPoolExecutor(max_workers=4) as pool:
        for role, fresh, item in pool.map(prepare, pods):
            choice['roles'][role] = fresh
            prepared[role] = item
    choice['usdPerHourIncludingDisk'] = sum(c['usdPerHourIncludingDisk'] for c in choice['roles'].values())
    choice, total = cost_check({**plan, 'boundedTestAssignment': choice, 'lowTransferFastAssignment': choice}, policy)
    # Cold-start payload is not bounded by disk size (compressed layers and direct
    # upstream fetches differ). Fail closed until an explicit byte budget exists.
    from vast_transfer_budget import upper_eur
    if 'coldStartEvidence' not in plan:
        raise RuntimeError('Cold-start transfer estimate not verified; metadata evidence missing')
    startup_cap = upper_eur(plan, images, choice)
    manual_cap = float(os.environ.get('VAST_COLD_START_MAX_EUR', '-1'))
    if not math.isfinite(manual_cap) or (manual_cap >= 0 and startup_cap > manual_cap):
        raise RuntimeError('Cold-start transfer estimate exceeds additional operator cap')
    if total + startup_cap >= policy['maxTotalEurPerHour']:
        raise RuntimeError('Cold-start plus test run exceeds total hourly ceiling')
    print(json.dumps({'coldStartUpperEur': round(startup_cap, 4),
                     'firstHourUpperEur': round(total + startup_cap, 4),
                     'maxTestCostEur': round(total * policy['maxTestMinutes'] / 60 + startup_cap, 4)}), flush=True)
    state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    state_dir.chmod(0o700)
    if state_path.exists() and json.loads(state_path.read_text()).get('instances'):
        raise RuntimeError('Existing deployment state needs reconciliation')
    state = {'instances': {}, 'allocationsEverCreated': 0, 'promoted': False, 'startedAt': time.time(),
             'quotedHourlyEur': total, 'coldStartUpperEur': startup_cap,
             'manifestSha256': hashlib.sha256(shared.MANIFEST_PATH.read_bytes()).hexdigest()}
    label_timestamp = os.environ.get('VAST_LABEL_TIMESTAMP') or str(int(state['startedAt']))
    if not re.fullmatch(r'[0-9]{10,20}', label_timestamp):
        raise RuntimeError('Invalid deployment label timestamp')
    state['labelTimestamp'] = label_timestamp
    state['pendingLabels'] = [PREFIX + role + '-' + label_timestamp for role in prepared]
    private_write(state_path, json.dumps(state))
    try:
        bodies = {}
        for role, (pod, offer, entries, image) in prepared.items():
            host = offer['public_ipaddr']
            cert, key = certificate(state_dir, role, host)
            env = shared.pod_body(fleet, pod, image, token, entries)['env']
            env.update({'HF_HOME': '/data/hf-cache', 'AI_WEIGHTS_TMP': '/data/weights-tmp',
                'VAST_TLS_CERT_B64': base64.b64encode(cert.read_bytes()).decode(),
                'VAST_TLS_KEY_B64': base64.b64encode(key.read_bytes()).decode()})
            label = PREFIX + role + '-' + label_timestamp
            body = {'image': image, 'disk': pod['containerDiskGb'], 'label': label,
                    'runtype': 'args', 'target_state': 'running', 'cancel_unavail': True,
                    'env': {**compact_environment(env), '-p 8000:8000': '1'},
                    'image_login': '-u ' + shlex.quote(username) + ' -p ' + shlex.quote(password) + ' ghcr.io'}
            bodies[role] = (body, host, cert, offer['id'])
        print('All eight compressed role environments fit the Vast payload limit', flush=True)
        for role, (body, host, cert, offer_id) in sorted(bodies.items(), key=lambda item: item[0] != 'studio'):
            # Weight checks and certificates can outlive a marketplace ask ID.
            # Refresh once before purchase, without retrying any paid contract.
            time.sleep(max(0, 5.0 - (time.monotonic() - _LAST_CREATE_REQUEST)))
            reserved = {quote['machineId'] for other, quote in choice['roles'].items() if other != role}
            offer, quote = fresh_offer(prepared[role][0], models, fleet, choice['roles'][role], reserved)
            if offer['public_ipaddr'] != host:
                host = offer['public_ipaddr']
                cert, key = certificate(state_dir, role, host)
                body['env'].update(VAST_TLS_CERT_B64=base64.b64encode(cert.read_bytes()).decode(),
                                   VAST_TLS_KEY_B64=base64.b64encode(key.read_bytes()).decode())
            choice['roles'][role] = quote
            choice['usdPerHourIncludingDisk'] = sum(c['usdPerHourIncludingDisk'] for c in choice['roles'].values())
            _, total = cost_check({**plan, 'boundedTestAssignment':choice}, policy)
            startup_cap = upper_eur(plan, images, choice)
            if total + startup_cap >= policy['maxTotalEurPerHour'] or (manual_cap >= 0 and startup_cap > manual_cap):
                raise RuntimeError('Cold-start plus test run exceeds total hourly ceiling')
            state.update(quotedHourlyEur=total, coldStartUpperEur=startup_cap)
            private_write(state_path, json.dumps(state))
            offer_id = offer['id']
            label = body['label']
            result = api('PUT', '/api/v0/asks/' + str(offer_id) + '/', body)
            ident = result.get('new_contract')
            if not result.get('success') or not ident:
                raise RuntimeError('Allocation failed: ' + role)
            state['instances'][role] = {'id': ident, 'machineId': choice['roles'][role]['machineId'],
                'label': label, 'host': host, 'cert': str(cert)}
            state['allocationsEverCreated'] += 1
            state.setdefault('allocationHistory', []).append({'role':role, 'id':ident,
                'machineId':quote['machineId']})
            private_write(state_path, json.dumps(state))
            print(json.dumps({'roleAllocated': role}), flush=True)
            billed = instances()
            owned_labels = set(state['pendingLabels'])
            for instance in billed:
                failure = provider_failure(instance)
                if instance.get('label') in owned_labels and failure:
                    raise RuntimeError('Terminal instance status: provider-' + failure)
            if any(not isinstance(x.get('dph_total'), (int, float)) or not math.isfinite(x['dph_total']) or x['dph_total'] <= 0 for x in billed):
                raise RuntimeError('Actual instance price unavailable')
            actual = sum(x['dph_total'] for x in billed)
            b = plan['budget']
            state['observedAccountHourlyEur'] = actual * b['usdToEur'] * b['taxMultiplier'] + b['unbilledEurPerHourReserve'] + policy['otherServicesEurPerHourReserve']
            private_write(state_path, json.dumps(state))
            if actual * b['usdToEur'] * b['taxMultiplier'] + b['unbilledEurPerHourReserve'] + policy['otherServicesEurPerHourReserve'] + startup_cap >= policy['maxTotalEurPerHour']:
                raise RuntimeError('Actual account hourly price exceeds limit')
        deadline = state['startedAt'] + policy['maxTestMinutes'] * 60
        while time.time() < deadline - 120:
            live = {str(x['id']): x for x in instances()}
            good = True
            for role, item in state['instances'].items():
                inst = live.get(str(item['id']), {})
                failure = provider_failure(inst)
                if failure:
                    raise RuntimeError('Terminal instance status: ' + role + ' provider-' + failure)
                fail_on_terminal_instance(inst, role)
                ports = inst.get('ports', {}).get('8000/tcp', [])
                if not ports:
                    good = False
                    continue
                port = int(ports[0]['HostPort'])
                url = 'https://' + item['host'] + ':' + str(port)
                ctx = ssl.create_default_context(cafile=item['cert'])
                try:
                    req = urllib.request.Request(url + '/models', headers={'Authorization': 'Bearer ' + token})
                    with urllib.request.urlopen(req, context=ctx, timeout=15) as response:
                        data = json.load(response)
                    loaded = {m['id']: m for m in data.get('models', []) if m.get('loaded')}
                    expected = prepared[role][0]['models']
                    if set(expected) != set(loaded) or any(
                            loaded[mid].get('repository') != models[mid].get('repository') or
                            loaded[mid].get('revision') != models[mid].get('revision') for mid in expected if mid in loaded):
                        good = False
                    with urllib.request.urlopen(urllib.request.Request(url + '/ready', headers={
                        'Authorization': 'Bearer ' + token}), context=ctx, timeout=15) as ready:
                        good = good and ready.status == 200
                    item['url'] = url
                except urllib.error.HTTPError as exc:
                    fail_on_terminal_readiness(exc, role)
                    good = False
                except (OSError, ValueError):
                    good = False
            if good:
                ca = state_dir / 'ca.pem'
                private_write(ca, ''.join(Path(v['cert']).read_text() for v in state['instances'].values()))
                output = ['AI_GPU_PROVIDER=vast', 'AI_FLEET_MODE=pods', 'AI_MAX_AI_EUR_PER_HOUR=8',
                    'AI_MAX_FLEET_EUR_PER_HOUR=8', 'NODE_EXTRA_CA_CERTS=' + str(ca), 'AI_POD_TOKEN=' + token,
                    'VAST_API_KEY=' + os.environ['VAST_API_KEY']]
                for role, item in state['instances'].items():
                    name = role.upper().replace('-', '_')
                    output += ['VAST_POD_URL_' + name + '=' + item['url'],
                               'VAST_POD_ID_' + name + '=' + str(item['id']),
                               'VAST_POD_EUR_PER_HOUR_' + name + '=' + str(choice['roles'][role]['grossEurPerHourIncludingDisk'])]
                private_write(state_dir / 'runtime.env', '\n'.join(output) + '\n')
                state['promoted'] = True
                private_write(state_path, json.dumps(state))
                print('Eight role inventories ready; runtime.env generated privately')
                return 0
            time.sleep(10)
        raise RuntimeError('Readiness deadline exceeded')
    except BaseException:
        # Reconcile labels too: a timed-out create may have succeeded remotely.
        # Use the durable exact-run labels, including ambiguous creates.
        # Cleanup must never replace the original startup error.
        try:
            run(argparse.Namespace(command='down', yes=True, state_dir=state_dir))
        except Exception:
            pass  # QA finally + independent cleanup both retry reconciliation.
        raise


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('command', choices=['preflight', 'up', 'status', 'down'])
    p.add_argument('--plan', type=Path, default=ROOT / 'vast-plan.json')
    p.add_argument('--images', type=Path)
    p.add_argument('--state-dir', type=Path, default=Path(os.environ.get('VAST_STATE_DIR', '/data/vast-fleet')))
    p.add_argument('--yes', action='store_true')
    args = p.parse_args()
    try:
        return run(args)
    except Exception as exc:
        # Provider response bodies/URLs contain secrets; never print them.
        print(type(exc).__name__ + ': ' + str(exc)[:250])
        return 4


if __name__ == '__main__':
    raise SystemExit(main())
