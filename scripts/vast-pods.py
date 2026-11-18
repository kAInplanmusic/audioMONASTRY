"""Vast provider adapter. Models, revisions, hashes and base images remain SSOT.

API secrets, TLS keys, instance addresses and generated runtime env stay in a
private state directory. No live cutover until all eight role inventories pass.
"""
import argparse
import collections
import copy
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
spec = importlib.util.spec_from_file_location('vast_fleet', ROOT / 'scripts/vast-fleet-module.py')
shared = importlib.util.module_from_spec(spec)
spec.loader.exec_module(shared)
spec_plan = importlib.util.spec_from_file_location('vast_plan', ROOT / 'scripts/vast-fleet-plan.py')
planner = importlib.util.module_from_spec(spec_plan)
spec_plan.loader.exec_module(planner)
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
            'FILE_NOT_FOUND','ASSET_PACKAGE_VERSION_MISMATCH','ASSET_MISSING_OR_CORRUPT',
            'ASSET_OVERSIZED','ASSET_HASH_OR_SIZE_MISMATCH','ASSET_IDENTITY_MISMATCH',
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


def ghcr_token_problem(password):
    """GHCR unterstuetzt laut GitHub-Doku nur Personal Access Tokens (classic); fine-grained Token (`github_pat_...`) funktionieren dort nicht.
    Quelle: docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry."""
    if password.startswith('github_pat_'):
        return 'GHCR_PASSWORD is a fine-grained token; the Container registry only supports a classic personal access token (read:packages)'
    return None


def create_body(image, disk_gb, label, env, username, password):
    """Body fuer PUT /api/v0/asks/{id}/ (docs.vast.ai/api-reference/instances/create-instance, creating-instances-with-api):
    `runtype: args` behaelt den Image-Entrypoint; `env` ist ein Objekt, Ports als `-p`-Schluessel mit Wert `1`; `image_login` im Format
    `-u USER -p TOKEN REGISTRY`; `cancel_unavail` bricht ab, wenn die Instanz nicht sofort startet (kein Warten auf Hardware)."""
    return {'image': image, 'disk': disk_gb, 'label': label,
            'runtype': 'args', 'target_state': 'running', 'cancel_unavail': True,
            'env': {**compact_environment(env), '-p 8000:8000': '1'},
            'image_login': '-u ' + shlex.quote(username) + ' -p ' + shlex.quote(password) + ' ghcr.io'}


def destroy(ident):
    if not str(ident).isdigit():
        raise RuntimeError('Invalid Vast instance ID')
    api('DELETE', '/api/v0/instances/' + str(ident) + '/')


# Hosts, auf denen ein Pod seine Aufgabe nicht erfuellte (derzeit: vis ohne NVENC). `run` laedt sie aus <state_dir>/bad-hosts.json.
DENIED_MACHINES = {}      # machineId -> Rolle (None = jede Rolle), geladen aus <state_dir>/bad-hosts.json
BAD_HOSTS_TTL_SECONDS = 7 * 24 * 3600
ASK_UNAVAILABLE_TTL_SECONDS = 30 * 60


def load_bad_hosts(state_dir, now=None, role=None):
    """Noch gueltige gesperrte Maschinen-IDs (Eintraege verfallen nach 7 Tagen: Hosts und Treiber aendern sich).
    Eintrag mit `role` gilt nur fuer diese Rolle (z. B. vis ohne NVENC; alte Eintraege ohne Feld = vis); Eintrag mit
    `role: null` (Host unerreichbar) gilt fuer jede Rolle. Ohne `role`-Argument: alle Eintraege."""
    path = Path(state_dir) / 'bad-hosts.json'
    try:
        rows = json.loads(path.read_text())
    except (OSError, ValueError):
        return set()
    now = time.time() if now is None else now
    return {int(row['machineId']) for row in rows if isinstance(row, dict) and 'machineId' in row
            and now - float(row.get('at', 0)) < float(row.get('ttl', BAD_HOSTS_TTL_SECONDS))
            and (role is None or row.get('role', 'vis') in (None, role))}


def denied_scopes(state_dir, now=None):
    """machineId -> Rolle oder None (jede Rolle) fuer `fresh_offer`."""
    path = Path(state_dir) / 'bad-hosts.json'
    try:
        rows = json.loads(path.read_text())
    except (OSError, ValueError):
        return {}
    now = time.time() if now is None else now
    return {int(r['machineId']): r.get('role', 'vis') for r in rows if isinstance(r, dict) and 'machineId' in r
            and now - float(r.get('at', 0)) < float(r.get('ttl', BAD_HOSTS_TTL_SECONDS))}


def remember_bad_host(state_dir, machine_id, reason, now=None, role='vis', ttl=None):
    now = time.time() if now is None else now
    path = Path(state_dir) / 'bad-hosts.json'
    try:
        rows = json.loads(path.read_text())
    except (OSError, ValueError):
        rows = []
    rows = [row for row in rows if isinstance(row, dict) and row.get('machineId') != machine_id
            and now - float(row.get('at', 0)) < float(row.get('ttl', BAD_HOSTS_TTL_SECONDS))]
    row = {'machineId': machine_id, 'reason': str(reason)[:200], 'at': now, 'role': role}
    if ttl is not None:
        row['ttl'] = ttl                      # kurzlebige Sperre (z. B. Angebot nicht mietbar), sonst 7 Tage
    rows.append(row)
    private_write(path, json.dumps(rows))


def enforce_vis_encoder(state, state_dir, allow_fallback=False, mode=None):
    """NVENC-Pruefung des vis-Pods (`/visual/capabilities`). Ohne NVENC kodiert die CPU: die Ziel-fps sind dort nicht gesichert
    (docs/VIS_GPU_MESSUNG.md). Modus VAST_VIS_NVENC: `require` (Standard) bricht `up` kontrolliert ab, der Host kommt auf die Sperrliste
    und das bestehende Aufraeumen entfernt alle Instanzen; ein erneutes `up` waehlt einen anderen Host. `warn` meldet nur,
    `off` prueft nicht. Bei `resume` (gleicher Host, kein Tausch moeglich) wird nur gewarnt."""
    mode = (mode or os.environ.get('VAST_VIS_NVENC', 'require')).lower()
    item = state.get('instances', {}).get('vis')
    caps = (item or {}).get('capabilities')
    if mode == 'off' or not item or not isinstance(caps, dict) or caps.get('nvenc') is not False:
        return
    reason = caps.get('nvencReason') or 'unknown'
    if mode == 'require' and not allow_fallback:
        if item.get('machineId') is not None:
            remember_bad_host(state_dir, item['machineId'], reason)
        raise RuntimeError('vis host has no usable NVENC (machine %s): %s. Host excluded; run up again.' % (item.get('machineId'), reason))
    print(json.dumps({'warning': 'vis host has no NVENC; the CPU encoder (libx264) will be used', 'machineId': item.get('machineId'),
                      'reason': reason}), flush=True)


def fresh_offer(pod, models, fleet, selected, reserved=None, accept=None, rank=None, alternatives_only=False):
    """Refresh the ask ID on the same chosen physical host before its purchase."""
    denied = {mid for mid, scope in DENIED_MACHINES.items() if scope in (None, pod.get('role'))}
    query = planner.query(pod, models)
    found = []
    if selected['machineId'] not in denied and not alternatives_only:
        query['machine_id'] = {'eq': selected['machineId']}
        found = [(offer, planner.candidate(offer, pod, fleet, models)) for offer in planner.search(query)]
        found = [(offer, quote) for offer, quote in found if quote and quote['gpu'] == selected['gpu']]
    if not found and (reserved is not None or denied):
        # Choose another *unbought* host for this role. No second contract is
        # purchased for an allocated role, and HTTP create failures still abort.
        alternatives = planner.search(planner.query(pod, models))
        found = [(offer, planner.candidate(offer, pod, fleet, models)) for offer in alternatives]
        found = [(offer, quote) for offer, quote in found
                 if quote and quote['machineId'] not in (reserved or set()) and quote['machineId'] not in denied]
    if accept is not None:
        found = [(offer, quote) for offer, quote in found if accept(quote)]      # gleiche Zeit-/Preisgrenze wie der Planer
    if not found:
        raise RuntimeError('Selected offer no longer available: ' + pod['role'])
    return min(found, key=(lambda pair: rank(pair[1])) if rank else (lambda pair: pair[1]['usdPerHourIncludingDisk']))


def pod_log_text(ident, tail=400):
    """Container-Log (Vast request_logs -> vorsignierte URL), None wenn nicht abrufbar."""
    try:
        answer = api('PUT', '/api/v0/instances/request_logs/%d' % int(ident), {'tail': str(tail)})
        url = answer.get('result_url') if isinstance(answer, dict) else None
        if not url or not url.startswith('https://'):
            return None
        for _ in range(4):
            time.sleep(3)
            try:
                with urllib.request.urlopen(url, timeout=30) as response:
                    return response.read().decode('utf-8', errors='replace')
            except OSError:
                continue
    except Exception:       # noqa: BLE001  (Diagnose darf den eigentlichen Fehler nie ersetzen)
        return None
    return None


def pod_reports_listening(text):
    """Der Pod meldet im eigenen Log, dass uvicorn laeuft (dann liegt ein Verbindungsfehler am Host/Netz, nicht am Pod)."""
    return bool(text) and 'Uvicorn running' in text and 'Application startup complete' in text


def mark_unreachable_host(state_dir, item, role):
    """Nach einem Bereitschaftsfehler: laeuft der Pod laut Log, ist der Host (Portweiterleitung) unbrauchbar -> fuer jede Rolle sperren."""
    if item.get('machineId') is None or not pod_reports_listening(pod_log_text(item['id'])):
        return False
    remember_bad_host(state_dir, item['machineId'], 'unreachable: pod listening per its log, but connection from outside failed (%s)' % role, role=None)
    return True


def verify_executor_before_other_rentals(item, models, deadline):
    """Prove the priority executor can start before buying the other seven."""
    expected = {'qwen3-4b'}
    context = ssl.create_default_context(cafile=item['cert'])
    while time.time() < deadline:
        instance = next((row for row in instances() if str(row['id']) == str(item['id'])), {})
        failure = provider_failure(instance)
        if failure:raise RuntimeError('Terminal instance status: audio-brain provider-' + failure)
        fail_on_terminal_instance(instance,'audio-brain')
        ports=(instance.get('ports') or {}).get('8000/tcp') or []
        if ports:
            url='https://'+item['host']+':'+str(int(ports[0]['HostPort']))
            def get(path):
                request=urllib.request.Request(url+path,headers={'Authorization':'Bearer '+os.environ['AI_POD_TOKEN']})
                with urllib.request.urlopen(request,context=context,timeout=15) as response:return json.load(response)
            try:
                listing=get('/models')
                loaded={row['id']:row for row in listing.get('models',[]) if row.get('loaded')}
                if set(loaded)==expected and all(loaded[mid].get('repository')==models[mid].get('repository')
                        and loaded[mid].get('revision')==models[mid].get('revision') for mid in expected):
                    get('/ready')
                    item['url']=url
                    return
            except urllib.error.HTTPError as exc:
                fail_on_terminal_readiness(exc,'audio-brain')
            except (OSError,ValueError):pass
        time.sleep(5)
    raise RuntimeError('Readiness deadline exceeded: priority executor before remaining rentals')


def executor_functional_probe(item,state_dir,label_timestamp):
    source=Path(os.environ['VAST_EXECUTOR_PROBE_FILE'])
    node=os.environ.get('VAST_EXECUTOR_PROBE_NODE')
    if node:
        if not Path(node).is_absolute() or Path(node).name!='node':raise RuntimeError('Executor CPU probe Node path invalid')
        env={key:os.environ[key] for key in ('PATH','HOME','RUNNER_TRACKING_ID','AI_POD_TOKEN') if key in os.environ}
        env.update(EXECUTOR_POD_URL=item['url'],NODE_EXTRA_CA_CERTS=str(Path(item['cert']).resolve()))
        result=subprocess.run([node,'--input-type=module','-'],input=source.read_bytes(),
            capture_output=True,env=env,timeout=300)
        if result.returncode:raise RuntimeError('Executor functional probe process failed')
        return json.loads(result.stdout.decode().strip().splitlines()[-1])
    image=os.environ['VAST_EXECUTOR_PROBE_IMAGE']
    if not re.fullmatch(r'sha256:[0-9a-f]{64}',image):raise RuntimeError('Executor CPU probe image not content-addressed')
    public_ca=state_dir/'executor-public-ca.pem'
    public_ca.write_bytes(Path(item['cert']).read_bytes());public_ca.chmod(0o644)
    name='audiomonastry-executor-proof-'+label_timestamp
    env=dict(os.environ,EXECUTOR_POD_URL=item['url'])
    try:
        result=subprocess.run(['docker','run','--rm','-i','--name',name,'--network','host',
            '--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--memory=1g',
            '-v',str(public_ca)+':/executor-ca.pem:ro','-e','NODE_EXTRA_CA_CERTS=/executor-ca.pem',
            '-e','EXECUTOR_POD_URL','-e','AI_POD_TOKEN','--entrypoint','node',image,'--input-type=module','-'],
            input=source.read_bytes(),capture_output=True,env=env,timeout=300)
        if result.returncode:raise RuntimeError('Executor functional probe process failed')
        return json.loads(result.stdout.decode().strip().splitlines()[-1])
    finally:
        subprocess.run(['docker','rm','-f',name],capture_output=True,timeout=30)


HEDGE_WINDOW_MINUTES_DEFAULT = 15.0


def hedged_roles(roles):
    """Rollen mit Zweit-Host (Betreiber 2026-11-18). Standard AUS: `VAST_HEDGE_ROLES=all` oder eine kommagetrennte Rollenliste."""
    raw = os.environ.get('VAST_HEDGE_ROLES', '').strip().lower()
    if not raw:
        return []
    if raw == 'all':
        return list(roles)
    wanted = {part.strip() for part in raw.split(',') if part.strip()}
    return [role for role in roles if role in wanted]


def hedge_window_minutes():
    value = float(os.environ.get('VAST_HEDGE_WINDOW_MINUTES', HEDGE_WINDOW_MINUTES_DEFAULT))
    if not 1 <= value <= 30:
        raise RuntimeError('VAST_HEDGE_WINDOW_MINUTES must be between 1 and 30')
    return value


def rent_hedges(state, state_path, state_dir, roles, bodies, prepared, models, fleet, plan, images, choice, policy, label_timestamp,
                certificate_fn=None):
    """Je Rolle einen zweiten Host auf einer ANDEREN Maschine mieten; der zuerst bereite gewinnt, der andere wird in wait_ready() zerstoert.

    Kostenwaechter: der Zweit-Host zaehlt nur fuer sein Zeitfenster (`VAST_HEDGE_WINDOW_MINUTES`, Standard 15) plus seine Ingress-Gebuehr in die
    erste Stunde; passt er nicht unter die Stundenobergrenze, wird dieser Zweit-Host uebersprungen (kein Abbruch). Fehler beim Zweit-Host brechen
    den Lauf nie ab: der Primaerpfad bleibt unveraendert."""
    certificate_fn = certificate_fn or certificate
    from vast_transfer_budget import payloads, transfer_minutes, transfer_deadline_minutes
    window = hedge_window_minutes()
    budget = plan['budget']
    factor = budget['usdToEur'] * budget['taxMultiplier']
    state.setdefault('hedges', {})
    taken = {quote['machineId'] for quote in choice['roles'].values()}
    taken |= {item.get('machineId') for item in state['hedges'].values()}
    hedge_hourly_usd = 0.0
    hedge_ingress_eur = 0.0
    sizes = payloads(plan['coldStartEvidence'], images)
    for role in roles:
        if role not in state['instances'] or role in state['hedges']:
            continue
        gb = sizes[role]

        def within_cold_start(candidate, gb=gb, role=role):
            return (isinstance(candidate.get('ingressUsdPerGb'), (int, float)) and isinstance(candidate.get('egressUsdPerGb'), (int, float))
                    and transfer_minutes(gb, candidate) < transfer_deadline_minutes(role))

        def hourly_with_ingress(candidate, gb=gb):
            return candidate['usdPerHourIncludingDisk'] + gb * candidate['ingressUsdPerGb'] * 1.10

        time.sleep(max(0, 5.0 - (time.monotonic() - _LAST_CREATE_REQUEST)))
        try:
            offer, quote = fresh_offer(prepared[role][0], models, fleet, {'machineId': None, 'gpu': None}, taken,
                                       accept=within_cold_start, rank=hourly_with_ingress, alternatives_only=True)
        except RuntimeError:
            print(json.dumps({'hedgeSkipped': role, 'reason': 'no second host within the cold-start bounds'}), flush=True)
            continue
        ingress_eur = gb * quote['ingressUsdPerGb'] * 1.10 * factor
        spend = (hedge_hourly_usd + quote['usdPerHourIncludingDisk']) * factor * window / 60.0 + hedge_ingress_eur + ingress_eur
        if state['quotedHourlyEur'] + state['coldStartUpperEur'] + spend >= policy['maxTotalEurPerHour']:
            print(json.dumps({'hedgeSkipped': role, 'reason': 'first-hour budget', 'hedgeSpendEur': round(spend, 3)}), flush=True)
            continue
        host = offer['public_ipaddr']
        cert, key = certificate_fn(state_dir, role + '-hedge', host)
        body = copy.deepcopy(bodies[role][0])
        label = PREFIX + role + '-hedge-' + label_timestamp
        body['label'] = label
        body['env'].update(VAST_TLS_CERT_B64=base64.b64encode(Path(cert).read_bytes()).decode(),
                           VAST_TLS_KEY_B64=base64.b64encode(Path(key).read_bytes()).decode())
        state['pendingLabels'].append(label)               # `down` findet auch einen unklaren Kauf
        private_write(state_path, json.dumps(state))
        try:
            result = api('PUT', '/api/v0/asks/' + str(offer['id']) + '/', body)
        except RuntimeError as exc:
            print(json.dumps({'hedgeSkipped': role, 'reason': 'offer unavailable' if 'no_such_ask' in str(exc) else 'create failed'}), flush=True)
            continue
        ident = result.get('new_contract')
        if not result.get('success') or not ident:
            continue
        state['hedges'][role] = {'id': ident, 'machineId': quote['machineId'], 'label': label, 'host': host, 'cert': str(cert),
                                 'image': body['image'], 'eurPerHour': quote.get('grossEurPerHourIncludingDisk'),
                                 'gpu': quote.get('gpu'), 'downloadReported': quote.get('downloadReported')}
        state['allocationsEverCreated'] += 1
        taken.add(quote['machineId'])
        hedge_hourly_usd += quote['usdPerHourIncludingDisk']
        hedge_ingress_eur += ingress_eur
        private_write(state_path, json.dumps(state))
        print(json.dumps({'hedgeAllocated': role, 'machineId': quote['machineId']}), flush=True)
    return state['hedges']


def _destroy_quietly(ident):
    try:
        destroy(ident)
    except RuntimeError:
        pass          # schon weg oder verlorene Antwort; der Bestand wird von `down` abgeglichen


def resolve_hedge(state, state_path, role, winner):
    """Gewinner festlegen: 'primary' zerstoert den Zweit-Host, 'hedge' ersetzt den Primaerhost und zerstoert ihn."""
    hedge = state['hedges'].pop(role)
    if winner == 'hedge':
        loser = state['instances'][role]
        state['instances'][role] = hedge
    else:
        loser = hedge
    _destroy_quietly(loser['id'])
    state.setdefault('hedgeResults', {})[role] = winner
    private_write(state_path, json.dumps(state))
    print(json.dumps({'hedgeResolved': role, 'winner': winner}), flush=True)


def probe_role(item, role, live, token, models, expected_models, grace_until):
    """Eine Instanz auf Modellinventar und /ready pruefen. True = bereit. Endgueltige Fehler werden als RuntimeError geworfen."""
    inst = live.get(str(item['id']), {})
    failure = provider_failure(inst)
    if failure:
        raise RuntimeError('Terminal instance status: ' + role + ' provider-' + failure)
    if time.time() >= grace_until:
        fail_on_terminal_instance(inst, role)
    ports = inst.get('ports', {}).get('8000/tcp', [])
    if not ports:
        return False
    ok = True
    port = int(ports[0]['HostPort'])
    url = 'https://' + item['host'] + ':' + str(port)
    ctx = ssl.create_default_context(cafile=item['cert'])
    try:
        req = urllib.request.Request(url + '/models', headers={'Authorization': 'Bearer ' + token})
        with urllib.request.urlopen(req, context=ctx, timeout=15) as response:
            data = json.load(response)
        loaded = {m['id']: m for m in data.get('models', []) if m.get('loaded')}
        expected = expected_models[role]
        if set(expected) != set(loaded) or any(
                loaded[mid].get('repository') != models[mid].get('repository') or
                loaded[mid].get('revision') != models[mid].get('revision') for mid in expected if mid in loaded):
            ok = False
        with urllib.request.urlopen(urllib.request.Request(url + '/ready', headers={
            'Authorization': 'Bearer ' + token}), context=ctx, timeout=15) as ready:
            ok = ok and ready.status == 200
        item['url'] = url
        if role == 'vis' and ok and 'capabilities' not in item:
            try:
                with urllib.request.urlopen(urllib.request.Request(url + '/visual/capabilities', headers={
                        'Authorization': 'Bearer ' + token}), context=ctx, timeout=30) as caps:
                    item['capabilities'] = json.load(caps)
            except (urllib.error.HTTPError, OSError, ValueError):
                item['capabilities'] = None      # aelteres Image ohne den Endpunkt: nicht pruefbar, kein Abbruch
    except urllib.error.HTTPError as exc:
        fail_on_terminal_readiness(exc, role)
        ok = False
    except (OSError, ValueError):
        ok = False
    return ok


def cold_start_deadlines(state, policy):
    """(Ziel, Hoechstgrenze) als Zeitpunkte: Ziel `coldStartTargetMinutes` (15); eine einzelne Rolle darf bis Ziel + `coldStartGraceMinutes` laufen."""
    import cold_start_report as csr
    target, hard = csr.limits_seconds(policy)
    return state['startedAt'] + target, state['startedAt'] + hard


def write_cold_start_report(state, state_dir, outcome):
    """Bericht je Rolle (Zeit bis bereit, ueber dem Ziel?) in <state_dir>/cold-start-report.json; bei Ueberschreitung mit Hinweisen zur Optimierung."""
    import cold_start_report as csr
    policy = json.loads(POLICY.read_text())
    report = csr.build_report(state, time.time(), policy, outcome)
    private_write(Path(state_dir) / 'cold-start-report.json', csr.dump(report))
    print(json.dumps({'coldStart': {'targetMet': report['targetMet'], 'rolesOverTarget': report['rolesOverTarget'],
                                    'elapsedMinutes': report['elapsedMinutes']}}), flush=True)
    if report.get('notice'):
        print(json.dumps({'coldStartNotice': report['notice'], 'hints': report.get('hints', [])}, ensure_ascii=False), flush=True)
    return report


def wait_ready(state, state_dir, state_path, token, models, expected_models, eur_by_role, deadline, grace_until=0.0,
               allow_encoder_fallback=False, soft_deadline=None):
    """Poll all recorded roles until model identity and /ready pass, then write runtime.env.

    Shared by a fresh `up` and a snapshot `resume`. `grace_until` tolerates the
    transient exited status of a stopped instance that is still being restarted.
    `soft_deadline` = Kaltstart-Ziel (15 min): danach darf nur noch EINE Rolle bis `deadline` (Ziel + 15 min) weiterlaufen; sind
    zwei oder mehr zu spaet, bricht der Lauf am Ziel ab (cold_start_report.decision). Immer wird ein Bericht geschrieben.
    """
    import cold_start_report as csr
    ready_at = state.setdefault('readyAtSeconds', {})
    warned = False
    while True:
        live = {str(x['id']): x for x in instances()}
        good = True
        for role in list(state['instances']):
            item = state['instances'][role]
            hedge = state.get('hedges', {}).get(role)
            primary_error = None
            try:
                ok = probe_role(item, role, live, token, models, expected_models, grace_until)
            except RuntimeError as exc:
                if hedge is None:
                    raise
                primary_error, ok = exc, False
            hedge_ok = False
            if hedge is not None:
                try:
                    hedge_ok = probe_role(hedge, role, live, token, models, expected_models, grace_until)
                except RuntimeError:
                    _destroy_quietly(hedge['id'])                    # Zweit-Host endgueltig fehlgeschlagen: verwerfen, Primaerpfad bleibt
                    state['hedges'].pop(role, None)
                    private_write(state_path, json.dumps(state))
                    hedge = None
            if hedge is not None:
                if primary_error is None and ok:
                    resolve_hedge(state, state_path, role, 'primary')
                elif hedge_ok:
                    resolve_hedge(state, state_path, role, 'hedge')
                    ok = True
                elif primary_error is not None:
                    resolve_hedge(state, state_path, role, 'hedge')      # Primaerhost endgueltig tot, Zweit-Host laedt noch
                    ok = False
            elif primary_error is not None:
                raise primary_error
            if ok and role not in ready_at:
                ready_at[role] = time.time() - state['startedAt']      # erste Bereitschaft; Messwert fuer den Kaltstart-Bericht
            good = good and ok
        pending = [role for role in state['instances'] if role not in ready_at]
        verdict = csr.decision(pending, time.time(), soft_deadline, deadline)
        if good and verdict == 'ready':
            enforce_vis_encoder(state, state_dir, allow_encoder_fallback)
            ca = state_dir / 'ca.pem'
            private_write(ca, ''.join(Path(v['cert']).read_text() for v in state['instances'].values()))
            output = ['AI_GPU_PROVIDER=vast', 'AI_FLEET_MODE=pods', 'AI_MAX_AI_EUR_PER_HOUR=8',
                'AI_MAX_FLEET_EUR_PER_HOUR=8', 'NODE_EXTRA_CA_CERTS=' + str(ca), 'AI_POD_TOKEN=' + token,
                'VAST_API_KEY=' + os.environ['VAST_API_KEY']]
            for role, item in state['instances'].items():
                name = role.upper().replace('-', '_')
                output += ['VAST_POD_URL_' + name + '=' + item['url'],
                           'VAST_POD_ID_' + name + '=' + str(item['id']),
                           'VAST_POD_EUR_PER_HOUR_' + name + '=' + str(eur_by_role[role])]
            private_write(state_dir / 'runtime.env', '\n'.join(output) + '\n')
            state['promoted'] = True
            private_write(state_path, json.dumps(state))
            write_cold_start_report(state, state_dir, 'ready')
            print('Eight role inventories ready; runtime.env generated privately')
            return 0
        if verdict == 'grace' and not warned:
            warned = True
            print(json.dumps({'coldStartGrace': pending, 'note': 'Ziel ueberschritten; diese eine Rolle darf bis zur Hoechstgrenze weiterlaufen'}), flush=True)
        if verdict in ('abort_multiple', 'abort_hard'):
            write_cold_start_report(state, state_dir, verdict)
            raise RuntimeError('Cold-start target exceeded (%s): %s' % (verdict, ','.join(pending)))
        time.sleep(10)


SNAPSHOT_STOP_SECONDS = 180
RESUME_SCHEDULING_SECONDS = 300


def set_instance_state(ident, target):
    """Vast warm stop/start: the container disk (image layers + weights) is kept."""
    if not str(ident).isdigit() or target not in ('stopped', 'running'):
        raise RuntimeError('Invalid Vast instance state change')
    api('PUT', '/api/v0/instances/' + str(ident) + '/', {'state': target})


def is_stopped(instance):
    return (instance.get('intended_status') == 'stopped' and
            instance.get('actual_status') in ('exited', 'stopped', 'offline', None))


def cold_start_deadline(state, policy):
    """Zeitpunkt, bis zu dem alle Rollen bereit sein muessen (Vorgabe: unter `coldStartTargetMinutes`, derzeit 15)."""
    from vast_transfer_budget import cold_start_target_minutes
    return state['startedAt'] + cold_start_target_minutes(policy) * 60


def snapshot_stop(args, state_dir, state_path):
    """Shutdown with snapshot: stop (not destroy) every recorded role.

    GPU billing ends; Vast keeps billing the container disk. The snapshot is the
    stopped disk itself (pulled image + verified weights) plus the recorded
    identity in state.json, so `resume` skips image pull and weight download.
    `down` remains the 0-EUR/h path that deletes everything.
    """
    if not args.yes:
        raise RuntimeError('--yes required')
    state = json.loads(state_path.read_text()) if state_path.exists() else {}
    recorded = state.get('instances') or {}
    if len(recorded) != 8:
        raise RuntimeError('No complete eight-role deployment recorded; nothing to snapshot')
    live = {str(x['id']): x for x in instances()}
    missing = []
    for role, item in recorded.items():
        current = live.get(str(item['id']))
        if not current:
            missing.append(role)
            continue
        if current.get('label') != item['label'] or not item['label'].startswith(PREFIX):
            raise RuntimeError('Instance ownership mismatch; refusing stop')
        if not is_stopped(current):
            set_instance_state(item['id'], 'stopped')
    deadline = time.monotonic() + SNAPSHOT_STOP_SECONDS
    while True:
        live = {str(x['id']): x for x in instances()}
        pending = [role for role, item in recorded.items()
                   if role not in missing and not is_stopped(live.get(str(item['id']), {}))]
        if not pending or time.monotonic() >= deadline:
            break
        time.sleep(5)
    if pending:
        raise RuntimeError('Vast stop not confirmed: ' + ','.join(sorted(pending)))
    storage = [live[str(item['id'])].get('storage_total_cost') for role, item in recorded.items() if role not in missing]
    state['snapshot'] = {'stoppedAt': time.time(), 'missingRoles': sorted(missing),
                         'manifestSha256': state.get('manifestSha256'),
                         'diskGb': sum(float(live[str(i['id'])].get('disk_space') or 0)
                                       for r, i in recorded.items() if r not in missing)}
    state['promoted'] = False
    private_write(state_path, json.dumps(state))
    (state_dir / 'runtime.env').unlink(missing_ok=True)
    summary = {'snapshotStopped': 8 - len(missing), 'missingRoles': sorted(missing),
               'gpuBillingStopped': True, 'diskStillBilled': True}
    if storage and all(isinstance(x, (int, float)) and math.isfinite(x) for x in storage):
        summary['reportedStorageUsdPerHour'] = round(sum(storage), 4)
    print(json.dumps(summary), flush=True)
    if missing:
        raise RuntimeError('Snapshot incomplete; missing roles need down + up: ' + ','.join(sorted(missing)))
    return 0


def snapshot_resume(args, policy, state_dir, state_path):
    """Warm start from the stopped snapshot; identity gates match a fresh `up`."""
    if not args.yes:
        raise RuntimeError('--yes required')
    state = json.loads(state_path.read_text()) if state_path.exists() else {}
    recorded = state.get('instances') or {}
    if not state.get('snapshot') or len(recorded) != 8:
        raise RuntimeError('No complete stopped snapshot; use up')
    if state.get('manifestSha256') != hashlib.sha256(shared.MANIFEST_PATH.read_bytes()).hexdigest():
        raise RuntimeError('Model identity manifest changed since snapshot; use down + up')
    if not args.images or not args.images.exists():
        raise RuntimeError('Digest-pinned Vast TLS image map missing')
    images = json.loads(args.images.read_text())
    from vast_image_attestation import verify as verify_image_attestation
    attestation_path = args.images.with_name('image-attestation.json')
    if not attestation_path.exists():
        raise RuntimeError('Seven-image source/digest attestation missing; no GPU allocation authorized')
    verify_image_attestation(images, json.loads(attestation_path.read_text()))
    if any(item.get('image') != images.get(role) for role, item in recorded.items()):
        raise RuntimeError('Snapshot image differs from attested image map; use down + up')
    token = shared.require('AI_POD_TOKEN', 32)
    if state.get('tokenSha256') != hashlib.sha256(token.encode()).hexdigest():
        raise RuntimeError('AI_POD_TOKEN differs from the snapshot environment; use down + up')
    account = api('GET', '/api/v0/users/current/')
    credit = float(account.get('balance') or 0) + float(account.get('credit') or 0)
    if not math.isfinite(credit) or credit <= 0:
        raise RuntimeError('Vast account balance is zero; resume blocked')
    live = {str(x['id']): x for x in instances()}
    own = {str(item['id']) for item in recorded.values()}
    if any(ident not in own for ident in live):
        raise RuntimeError('Account has unrecorded instances; reconcile costs before resume')
    missing = [role for role, item in recorded.items() if str(item['id']) not in live]
    if missing:
        raise RuntimeError('Snapshot instance gone (deleted by provider or autostop); use down + up: ' +
                           ','.join(sorted(missing)))
    for role, item in recorded.items():
        if live[str(item['id'])].get('label') != item['label']:
            raise RuntimeError('Instance ownership mismatch; refusing resume')
    eur_by_role = {role: float(item['eurPerHour']) for role, item in recorded.items()}
    budget = shared.load_fleet()['budget']
    total = sum(eur_by_role.values()) + budget['unbilledEurPerHourReserve'] + policy['otherServicesEurPerHourReserve']
    if not math.isfinite(total) or total >= policy['maxTotalEurPerHour']:
        raise RuntimeError('Total hourly estimate is not below authorized 8 EUR/h')
    print(json.dumps({'provider': 'vast', 'resume': True, 'estimatedTotalEurPerHour': round(total, 4),
                      'hourlyCeiling': policy['maxTotalEurPerHour']}), flush=True)
    models = shared.load_models()
    pods = {pod['role']: pod for pod in shared.load_fleet()['pods'] + [shared.load_fleet()['visPod']]}
    state['startedAt'] = time.time()
    state['snapshot']['resumeStartedAt'] = state['startedAt']
    private_write(state_path, json.dumps(state))
    try:
        # Priority order as in `up`: the executor first, then everything at once.
        for role in sorted(recorded, key=lambda r: {'audio-brain': 0, 'studio': 1}.get(r, 2)):
            set_instance_state(recorded[role]['id'], 'running')
        # Vast docs: a restart waits in SCHEDULING for its original GPU, possibly
        # forever if another renter took it. Fail fast instead of paying the rest.
        deadline = time.monotonic() + RESUME_SCHEDULING_SECONDS
        while True:
            live = {str(x['id']): x for x in instances()}
            waiting = [role for role, item in recorded.items()
                       if live.get(str(item['id']), {}).get('actual_status') != 'running']
            if not waiting:
                break
            if time.monotonic() >= deadline:
                raise RuntimeError('GPU not regained after resume (likely rented by others); '
                                   'snapshot kept, use down + up: ' + ','.join(sorted(waiting)))
            time.sleep(5)
        result = wait_ready(state, state_dir, state_path, token, models,
            {role: pods[role]['models'] for role in recorded}, eur_by_role,
            cold_start_deadlines(state, policy)[1],
            grace_until=state['startedAt'] + SNAPSHOT_STOP_SECONDS, allow_encoder_fallback=True,
            soft_deadline=cold_start_deadlines(state, policy)[0])
    except BaseException:
        # Keep the snapshot: stop again instead of deleting the warm disks.
        try:
            snapshot_stop(argparse.Namespace(yes=True), state_dir, state_path)
        except Exception:
            pass
        raise
    state['snapshot'] = None
    private_write(state_path, json.dumps(state))
    return result


def run(args):
    if args.command=='up' and getattr(args,'executor_only',False) and not os.environ.get('VAST_EXECUTOR_PROBE_FILE'):
        raise RuntimeError('Executor functional probe must be prepared before any rental')
    policy = json.loads(POLICY.read_text())
    state_dir = args.state_dir.resolve()
    state_path = state_dir / 'state.json'
    DENIED_MACHINES.clear()
    DENIED_MACHINES.update(denied_scopes(state_dir))      # z. B. vis-Hosts ohne NVENC aus frueheren Laeufen
    if args.command == 'status':
        owned = [x for x in instances() if str(x.get('label', '')).startswith(PREFIX)]
        print(json.dumps({'instances': len(owned), 'roles': [x.get('label') for x in owned],
                          'states': {x.get('label'): x.get('actual_status') for x in owned},
                          'snapshot': bool(state_path.exists() and json.loads(state_path.read_text()).get('snapshot'))}))
        return 0
    if args.command == 'down':
        if not args.yes:
            raise RuntimeError('--yes required')
        # Only IDs recorded by this deployment, never a provider-wide sweep.
        state = json.loads(state_path.read_text()) if state_path.exists() else {'instances': {}}
        live = {str(x['id']): x for x in instances()}
        recorded_ids = {str(item['id']) for item in state['instances'].values()} | {str(item['id']) for item in state.get('hedges', {}).values()}
        for ident, item in live.items():
            if ident not in recorded_ids and item.get('label') in state.get('pendingLabels', []):
                state['instances'].setdefault('reconciled-' + ident,
                    {'id': item['id'], 'label': item['label']})
        state['allocationsEverCreated'] = max(state.get('allocationsEverCreated', 0), len(state['instances']))
        for item in list(state['instances'].values()) + list(state.get('hedges', {}).values()):
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
        if any(str(x['id']) in remaining for x in list(state['instances'].values()) + list(state.get('hedges', {}).values())):
            raise RuntimeError('Vast deletion not confirmed')
        state['instances'] = {}
        state['hedges'] = {}
        state['promoted'] = False
        state['snapshot'] = None
        private_write(state_path, json.dumps(state))
        (state_dir / 'runtime.env').unlink(missing_ok=True)
        return 0
    if args.command == 'stop':
        return snapshot_stop(args, state_dir, state_path)
    if args.command == 'resume':
        return snapshot_resume(args, policy, state_dir, state_path)
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
    from vast_image_attestation import verify as verify_image_attestation
    attestation_path = args.images.with_name('image-attestation.json')
    if not attestation_path.exists():
        raise RuntimeError('Seven-image source/digest attestation missing; no GPU allocation authorized')
    verify_image_attestation(images, json.loads(attestation_path.read_text()))
    token = shared.require('AI_POD_TOKEN', 32)
    username, password = shared.require('GHCR_USERNAME'), shared.require('GHCR_PASSWORD')
    problem = ghcr_token_problem(password)
    if problem:
        raise RuntimeError(problem)
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
    from vast_transfer_budget import upper_eur, EXECUTOR_STARTUP_MINUTES
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
                     'maxTestCostEur': round(total * (policy['maxTestMinutes'] - 2) / 60 + startup_cap, 4),
                     'coldStartTargetMinutes': policy.get('coldStartTargetMinutes')}), flush=True)
    state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    state_dir.chmod(0o700)
    if state_path.exists() and json.loads(state_path.read_text()).get('instances'):
        raise RuntimeError('Existing deployment state needs reconciliation')
    state = {'instances': {}, 'allocationsEverCreated': 0, 'promoted': False, 'startedAt': time.time(),
             'quotedHourlyEur': total, 'coldStartUpperEur': startup_cap,
             'manifestSha256': hashlib.sha256(shared.MANIFEST_PATH.read_bytes()).hexdigest(),
             'tokenSha256': hashlib.sha256(token.encode()).hexdigest()}
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
            body = create_body(image, pod['containerDiskGb'], label, env, username, password)
            bodies[role] = (body, host, cert, offer['id'])
        print('All eight compressed role environments fit the Vast payload limit', flush=True)
        priority={'audio-brain':0,'studio':1}
        queue = collections.deque(sorted(bodies.items(), key=lambda item: priority.get(item[0],2)))
        ask_retries = {}
        while queue:
            role, (body, host, cert, offer_id) = queue.popleft()
            # Weight checks and certificates can outlive a marketplace ask ID.
            # Refresh once before purchase, without retrying any paid contract.
            time.sleep(max(0, 5.0 - (time.monotonic() - _LAST_CREATE_REQUEST)))
            reserved = {quote['machineId'] for other, quote in choice['roles'].items() if other != role}
            from vast_transfer_budget import payloads as _payloads, transfer_minutes as _minutes, transfer_deadline_minutes as _deadline
            gb = _payloads(plan['coldStartEvidence'], images)[role]

            def within_cold_start(candidate, gb=gb, role=role):
                rate = candidate.get('ingressUsdPerGb')
                return (isinstance(rate, (int, float)) and isinstance(candidate.get('egressUsdPerGb'), (int, float))
                        and _minutes(gb, candidate) < _deadline(role))

            def hourly_with_ingress(candidate, gb=gb):
                return candidate['usdPerHourIncludingDisk'] + gb * candidate['ingressUsdPerGb'] * 1.10

            offer, quote = fresh_offer(prepared[role][0], models, fleet, choice['roles'][role], reserved,
                                       accept=within_cold_start, rank=hourly_with_ingress)
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
            from vast_transfer_budget import payloads, transfer_minutes, transfer_deadline_minutes
            state.setdefault('payloadGbByRole', {})[role] = payloads(plan['coldStartEvidence'], images).get(role)
            if role=='audio-brain':
                gb=payloads(plan['coldStartEvidence'],images)[role]
                state['executorStartupForecast']={'payloadGb':gb,'reportedDownloadMbps':quote['downloadReported'],
                    'estimatedTransferMinutes':transfer_minutes(gb,quote),
                    'maximumTransferMinutes':transfer_deadline_minutes(role),'readyDeadlineMinutes':EXECUTOR_STARTUP_MINUTES}
            private_write(state_path, json.dumps(state))
            offer_id = offer['id']
            label = body['label']
            try:
                result = api('PUT', '/api/v0/asks/' + str(offer_id) + '/', body)
            except RuntimeError as exc:
                # no_such_ask: das Angebot steht in der Suche, ist aber nicht mietbar. Es entsteht kein Vertrag, also ist ein
                # anderer, noch nicht gekaufter Host fuer genau diese Rolle zulaessig (hoechstens zweimal je Rolle).
                if 'no_such_ask' not in str(exc) or ask_retries.get(role, 0) >= 2:
                    raise
                ask_retries[role] = ask_retries.get(role, 0) + 1
                DENIED_MACHINES[choice['roles'][role]['machineId']] = role
                remember_bad_host(state_dir, choice['roles'][role]['machineId'], 'ask not rentable (no_such_ask)', role=role, ttl=ASK_UNAVAILABLE_TTL_SECONDS)
                print(json.dumps({'askUnavailable': role, 'machineId': choice['roles'][role]['machineId'],
                                  'retry': ask_retries[role]}), flush=True)
                queue.appendleft((role, (body, host, cert, offer_id)))
                continue
            ident = result.get('new_contract')
            if not result.get('success') or not ident:
                raise RuntimeError('Allocation failed: ' + role)
            state['instances'][role] = {'id': ident, 'machineId': choice['roles'][role]['machineId'],
                'label': label, 'host': host, 'cert': str(cert), 'image': body['image'],
                'eurPerHour': choice['roles'][role]['grossEurPerHourIncludingDisk'],
                'gpu': choice['roles'][role].get('gpu'), 'downloadReported': choice['roles'][role].get('downloadReported')}
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
            if role=='audio-brain' and os.environ.get('VAST_EXECUTOR_GATE') == 'parallel':
                # Messmodus (Betreiber 2026-11-18: reale Zeit aller Rollen): die uebrigen Rollen werden sofort gemietet, der Executor
                # wird erst in wait_ready() mitgeprueft. Mehrkosten bei schlechtem Host: hoechstens ein Kaltstartfenster der Flotte.
                state['executorGateMode'] = 'parallel'
                private_write(state_path, json.dumps(state))
                print(json.dumps({'executorGate': 'parallel', 'note': 'remaining roles are rented without waiting'}), flush=True)
            elif role=='audio-brain':
                verify_executor_before_other_rentals(state['instances'][role],models,
                    min(state['startedAt']+EXECUTOR_STARTUP_MINUTES*60,cold_start_deadlines(state, policy)[0]))
                state['executorPreallocationPassed']=True
                if os.environ.get('VAST_EXECUTOR_PROBE_FILE'):
                    state['executorFunctionalPreflight']=executor_functional_probe(state['instances'][role],state_dir,label_timestamp)
                    private_write(state_path,json.dumps(state))
                    if state['executorFunctionalPreflight'].get('passed') is not True:
                        raise RuntimeError('Executor functional commands failed before remaining rentals')
                private_write(state_path,json.dumps(state))
                print(json.dumps({'priorityExecutorReady':True,'instancesCreated':1,
                                  'remainingRolesNotYetRented':7}),flush=True)
                if os.environ.get('VAST_OBSERVE_EXECUTOR_TIMELINE') == '1':
                    # Reiner Messmodus: nach dem Prioritaets-Pod anhalten, keine weitere Rolle mieten. `down` entfernt die Instanz.
                    state['executorTimelineObservation'] = True
                    private_write(state_path, json.dumps(state))
                    print(json.dumps({'observationOnly': True, 'instancesCreated': 1}), flush=True)
                    return 0
                if getattr(args,'executor_only',False):
                    if state.get('executorFunctionalPreflight',{}).get('passed') is not True:
                        raise RuntimeError('Executor functional probe required for executor-only acceptance')
                    state['executorOnly']=True
                    private_write(state_path,json.dumps(state))
                    return 0
        hedge_list = hedged_roles(list(state['instances']))
        if hedge_list:
            rent_hedges(state, state_path, state_dir, hedge_list, bodies, prepared, models, fleet, plan, images, choice, policy, label_timestamp)
        return wait_ready(state, state_dir, state_path, token, models,
            {role: prepared[role][0]['models'] for role in state['instances']},
            {role: choice['roles'][role]['grossEurPerHourIncludingDisk'] for role in state['instances']},
            cold_start_deadlines(state, policy)[1], soft_deadline=cold_start_deadlines(state, policy)[0])
    except BaseException as startup_error:
        try:
            if state.get('instances'):
                write_cold_start_report(state, state_dir, 'failed: ' + str(startup_error)[:160])
        except Exception:
            pass          # Bericht darf den eigentlichen Fehler und das Aufraeumen nie verhindern
        for role_name, row in list(state.get('instances', {}).items()):
            try:
                if role_name not in state.get('readyAtSeconds', {}) and mark_unreachable_host(state_dir, row, role_name):
                    print(json.dumps({'hostExcluded': row.get('machineId'), 'role': role_name,
                                      'reason': 'pod listening per its log but unreachable from outside'}), flush=True)
            except Exception:  # noqa: BLE001
                pass
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
    p.add_argument('command', choices=['preflight', 'up', 'status', 'stop', 'resume', 'down'])
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
