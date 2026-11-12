"""Bounded eight-role TLS/API test; always deletes its newly recorded instances."""
import argparse
import base64
from concurrent.futures import ThreadPoolExecutor
import importlib.util
import io
import json
import os
import re
from pathlib import Path
import ssl
import subprocess
import sys
import signal
import time
from types import SimpleNamespace
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('vast', ROOT / 'scripts/vast-pods.py')
vast = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vast)
sys.path.insert(0, str(ROOT / 'services/audiomonastry-ai-runtime'))
import runtime_probe


def production_request(model_id, definition):
    task, payload = runtime_probe.request(model_id, SimpleNamespace(task=definition['task']))
    for option in ('inferenceSteps', 'steps', 'maxTokens', 'maxSemanticTokens', 'planning', 'enableThinking', 'durationSeconds'):
        payload.pop(option, None)
    return task, payload


def allocation_summary(recorded):
    """Export only canonical roles and numeric IDs, never private state fields."""
    roles = {'brain', 'ears', 'voice', 'music', 'studio', 'audio-brain', 'song', 'vis'}
    return [{'role': role, **{key: item[key] for key in ('id', 'machineId')
                            if type(item.get(key)) is int and item[key] > 0}}
            for role, item in recorded.items() if role in roles]


def may_replan_without_paid_retry(error, statefile):
    message = str(error)
    vanished = message.startswith('Vast API HTTP 400:') and 'no_such_ask' in message
    preflight = message.startswith(('Selected offer no longer available:',
                                   'Cold-start transfer forecast exceeds readiness deadline:'))
    if not (vanished or preflight):
        return False
    if not statefile.exists():
        return preflight
    state = json.loads(statefile.read_text())
    if state.get('allocationsEverCreated') != 0 or state.get('instances') or state.get('promoted'):
        return False
    pending = set(state.get('pendingLabels', []))
    return not any(item.get('label') in pending for item in vast.instances())


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--plan', required=True, type=Path)
    p.add_argument('--images', required=True, type=Path)
    p.add_argument('--state-dir', required=True, type=Path)
    p.add_argument('--output', required=True, type=Path)
    p.add_argument('--production-app', action='store_true', help='Temporarily verify ready roles through this host application')
    args = p.parse_args()
    report = {'passed': False, 'roles': [], 'cleanupPassed': False,
              'parameterProfile': 'production-handler-defaults', 'responseByteLimit': None}
    statefile = args.state_dir / 'state.json'
    original_env = None
    compose_files = []
    def terminate(signum, frame):
        raise SystemExit(128+signum)
    signal.signal(signal.SIGTERM, terminate)
    def restart_app():
        command=['docker','compose']
        for item in compose_files:command+=['-f',item]
        subprocess.run(command+['up','-d','--no-build','audiomonastry'],cwd=ROOT,check=True,timeout=120)
    def app_request(path,payload=None):
        entries=dict(line.split('=',1) for line in (ROOT/'.env').read_text().splitlines() if '=' in line and not line.startswith('#'))
        token=entries['STUDIO_ACCESS_TOKEN'].strip('\"\'')
        request=urllib.request.Request('http://127.0.0.1:8080'+path,headers={'x-studio-token':token,'Content-Type':'application/json'},data=json.dumps(payload).encode() if payload is not None else None)
        with urllib.request.urlopen(request,timeout=180) as response:return json.load(response)
    if statefile.exists():
        raise RuntimeError('QA requires a new state directory; will not adopt an existing fleet')
    try:
        start = SimpleNamespace(command='up', yes=True, plan=args.plan, images=args.images, state_dir=args.state_dir)
        for attempt in range(3):
            try:
                if vast.run(start):
                    raise RuntimeError('Vast startup failed')
                break
            except RuntimeError as exc:
                # Replan only before any create could have happened; never repeat paid pulls.
                if attempt == 2 or not may_replan_without_paid_retry(exc, statefile):
                    raise
                inventory = args.plan.parent / 'vast-retry-inventory.json'
                inventory.write_text(json.dumps(json.loads(args.plan.read_text())['coldStartEvidence']['inventory']))
                subprocess.run([sys.executable, str(ROOT / 'scripts/vast-fleet-plan.py'),
                    '--region', json.loads(vast.POLICY.read_text())['regionPolicy'], '--output', str(args.plan), '--transfer-inventory', str(inventory),
                    '--image-sizes', str(ROOT / 'deploy/vast/image-sizes.json')], check=True)

        state = json.loads(statefile.read_text())
        if args.production_app:
            original_env=(ROOT/'.env').read_bytes()
            backup=args.state_dir/'app.env.before'
            vast.private_write(backup,original_env.decode())
            metadata=json.loads(subprocess.check_output(['docker','inspect','audiomonastry']))[0]
            compose_files=metadata['Config']['Labels']['com.docker.compose.project.config_files'].split(',')
            assert all(Path(x).resolve().is_relative_to(ROOT) for x in compose_files)
            trust=args.state_dir/'compose-trust.yml'
            trust.write_text('services:\n  audiomonastry:\n    volumes:\n      - /etc/audiomonastry-vast:/etc/audiomonastry-vast:ro\n')
            compose_files.append(str(trust))
            vast.private_write(args.state_dir/'app-compose.json',json.dumps(compose_files))
            promotion_spec=importlib.util.spec_from_file_location('vast_promotion',ROOT/'scripts/vast-promote-runtime.py')
            promotion=importlib.util.module_from_spec(promotion_spec)
            promotion_spec.loader.exec_module(promotion)
            promotion.promote(args.state_dir,ROOT/'.env',Path('/etc/audiomonastry-vast'))
            restart_app()
            for _ in range(40):
                try:
                    if app_request('/api/health').get('status')=='ok':break
                except (urllib.error.URLError,OSError):pass
                time.sleep(2)
            else:raise RuntimeError('Production app health failed after cutover')
            app_request('/api/ai/mode',{'mode':'on-with-visuals','source':'production-acceptance'})
            wake=app_request('/api/ai/fleet/wake',{})
            report['applicationWakeAccepted']=not wake.get('blocked')

        models = vast.shared.load_models()
        fleet = vast.shared.load_fleet()
        pods = fleet['pods'] + [fleet['visPod']]
        report['roles'] = [{'role': pod['role'], 'models': [], 'passed': False} for pod in pods]

        def validate_role(pod, row):
            item = state['instances'][pod['role']]
            ctx = ssl.create_default_context(cafile=item['cert'])

            response_bytes_read = 0

            def request(path, payload=None, token=None):
                nonlocal response_bytes_read
                remaining = state['startedAt'] + 26 * 60 - time.time()
                if remaining <= 0:
                    raise RuntimeError('QA time budget exhausted')
                headers = {'Authorization': 'Bearer ' + (token if token is not None else os.environ['AI_POD_TOKEN'])}
                if payload is not None:
                    headers['Content-Type'] = 'application/json'
                req = urllib.request.Request(item['url'] + path, headers=headers,
                    data=None if payload is None else json.dumps(payload).encode())
                try:
                    with urllib.request.urlopen(req, context=ctx, timeout=min(180, remaining)) as r:
                        raw = r.read()
                        response_bytes_read += len(raw)
                        return r.status, json.loads(raw)
                except urllib.error.HTTPError as exc:
                    return exc.code, {}

            status, _ = request('/models', token='invalid-qa-token')
            row['rejectsInvalidAuth'] = status == 401
            status, listing = request('/models')
            resident = {m['id']: m for m in listing.get('models', []) if m.get('loaded')}
            row['allResident'] = status == 200 and set(pod['models']) == set(resident) and all(
                resident[mid].get('repository') == models[mid].get('repository') and
                resident[mid].get('revision') == models[mid].get('revision') for mid in pod['models'] if mid in resident)
            for mid in pod['models']:
                if mid == 'acestep-v15-shared':
                    continue
                task, payload = production_request(mid, models[mid])
                status, output = request('/infer', {'task': task, 'model': mid, 'input': payload})
                result = output.get('result') or {}
                ok = status == 200 and output.get('status') == 'success' and bool(result)
                sources = result.get('stems') or ({'audio': result['audioBase64']} if result.get('audioBase64') else {})
                if sources:
                    import numpy as np
                    import soundfile as sf
                    for value in sources.values():
                        audio, rate = sf.read(io.BytesIO(base64.b64decode(value, validate=True)))
                        ok = ok and audio.size > 0 and bool(np.isfinite(audio).all()) and rate > 0
                row['models'].append({'id': mid, 'passed': bool(ok), 'httpStatus': status})
            row['responseBytesRead'] = response_bytes_read
            row['passed'] = row['allResident'] and row['rejectsInvalidAuth'] and all(m['passed'] for m in row['models'])
        # Eight independent GPUs can work concurrently. Each role still runs
        # its models serially, preserving the production per-role concurrency.
        with ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(lambda pair: validate_role(*pair), zip(pods, report['roles'])))
        report['passed'] = len(report['roles']) == 8 and all(r['passed'] for r in report['roles'])
        if args.production_app:
            completion=app_request('/api/ai/complete',{'prompt':'Reply with the word ready.'})
            report['applicationInferencePassed']=bool(completion) and not completion.get('error')
            report['passed']=report['passed'] and report['applicationWakeAccepted'] and report['applicationInferencePassed']
    except Exception as exc:
        report['errorType'] = type(exc).__name__
        # Only classified codes leave the runner; exception text may contain URLs.
        message = str(exc)
        if re.fullmatch(r'(GET|HEAD) [A-Za-z0-9/_.-]+: HTTP (401|403)', message):
            report['failureCode'] = 'R2_AUTH_REJECTED'
        elif message.startswith('Cold-start transfer estimate not verified'):
            report['failureCode'] = 'COLD_START_ESTIMATE_REQUIRED'
        elif message.startswith('Cold-start plus test run exceeds'):
            report['failureCode'] = 'COLD_START_BUDGET_EXCEEDED'
        elif message.startswith('Cold-start transfer forecast exceeds readiness deadline:'):
            report['failureCode'] = 'COLD_START_TOO_SLOW'
            report['failureDetail'] = message
        elif message.startswith('Existing R2 weights missing'):
            report['failureCode'] = 'R2_WEIGHTS_MISSING'
        elif message.startswith('Vast API HTTP '):
            report['failureCode'] = 'VAST_API_REJECTED'
            report['failureDetail'] = message
        elif message.startswith(('Selected offer no longer available:', 'Actual account hourly price exceeds limit', 'Terminal instance status:', 'Terminal model readiness failure:', 'Allocation failed:', 'Readiness deadline exceeded')):
            report['failureCode'] = 'VAST_STARTUP_BLOCKED'
            report['failureDetail'] = message
        else:
            report['failureCode'] = 'STARTUP_OR_INFERENCE_FAILED'
    finally:
        if statefile.exists():
            stored = json.loads(statefile.read_text())
            recorded = stored.get('instances', {})
            report['budgetEvidence'] = {key: stored[key] for key in
                ('quotedHourlyEur', 'coldStartUpperEur', 'observedAccountHourlyEur') if key in stored}
            report['hourlyCeilingEur'] = json.loads(vast.POLICY.read_text())['maxTotalEurPerHour']
            report['instancesAllocated'] = len(recorded)
            report['allocationsEverCreated'] = json.loads(statefile.read_text()).get('allocationsEverCreated', len(recorded))
            report['allocatedRoles'] = list(recorded)
            report['allocatedInstances'] = allocation_summary(recorded)
        else:
            report['instancesAllocated'] = 0
            report['allocatedRoles'] = []
        try:
            report['cleanupPassed'] = vast.run(SimpleNamespace(command='down', yes=True,
                state_dir=args.state_dir)) == 0
        except Exception:
            report['cleanupPassed'] = False
        if original_env is not None:
            try:
                (ROOT/'.env').write_bytes(original_env)
                (ROOT/'.env').chmod(0o600)
                restart_app()
                report['applicationEnvironmentRestored']=True
            except Exception:
                report['applicationEnvironmentRestored']=False
                report['passed']=False
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report))
    return 0 if report['passed'] and report['cleanupPassed'] else 4


if __name__ == '__main__':
    raise SystemExit(main())
