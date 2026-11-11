"""Bounded eight-role TLS/API test; always deletes its newly recorded instances."""
import argparse
import base64
import importlib.util
import io
import json
import os
import re
from pathlib import Path
import ssl
import subprocess
import sys
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
from vast_transfer_budget import MAX_ROLE_RESPONSE_BYTES


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--plan', required=True, type=Path)
    p.add_argument('--images', required=True, type=Path)
    p.add_argument('--state-dir', required=True, type=Path)
    p.add_argument('--output', required=True, type=Path)
    args = p.parse_args()
    report = {'passed': False, 'roles': [], 'cleanupPassed': False}
    statefile = args.state_dir / 'state.json'
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
                if statefile.exists() or not str(exc).startswith('Selected offer no longer available:') or attempt == 2:
                    raise
                inventory = args.plan.parent / 'vast-retry-inventory.json'
                inventory.write_text(json.dumps(json.loads(args.plan.read_text())['coldStartEvidence']['inventory']))
                subprocess.run([sys.executable, str(ROOT / 'scripts/vast-fleet-plan.py'),
                    '--region', json.loads(vast.POLICY.read_text())['regionPolicy'], '--output', str(args.plan), '--transfer-inventory', str(inventory),
                    '--image-sizes', str(ROOT / 'deploy/vast/image-sizes.json')], check=True)

        state = json.loads(statefile.read_text())
        models = vast.shared.load_models()
        fleet = vast.shared.load_fleet()
        for pod in fleet['pods'] + [fleet['visPod']]:
            item = state['instances'][pod['role']]
            ctx = ssl.create_default_context(cafile=item['cert'])

            response_bytes_remaining = MAX_ROLE_RESPONSE_BYTES

            def request(path, payload=None, token=None):
                nonlocal response_bytes_remaining
                if response_bytes_remaining <= 0:
                    raise RuntimeError('Role response-byte budget exhausted')
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
                        length = r.headers.get('Content-Length')
                        if length and int(length) > response_bytes_remaining:
                            raise RuntimeError('Role response-byte budget exceeded')
                        raw = r.read(response_bytes_remaining + 1)
                        response_bytes_remaining -= len(raw)
                        if response_bytes_remaining < 0:
                            raise RuntimeError('Role response-byte budget exceeded')
                        return r.status, json.loads(raw)
                except urllib.error.HTTPError as exc:
                    return exc.code, {}

            row = {'role': pod['role'], 'models': [], 'passed': False}
            report['roles'].append(row)
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
                task, payload = runtime_probe.request(mid, SimpleNamespace(task=models[mid]['task']))
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
            row['responseBytesRead'] = MAX_ROLE_RESPONSE_BYTES - response_bytes_remaining
            row['passed'] = row['allResident'] and row['rejectsInvalidAuth'] and all(m['passed'] for m in row['models'])
        report['passed'] = len(report['roles']) == 8 and all(r['passed'] for r in report['roles'])
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
        elif message.startswith('Existing R2 weights missing'):
            report['failureCode'] = 'R2_WEIGHTS_MISSING'
        elif message.startswith('Vast API HTTP '):
            report['failureCode'] = 'VAST_API_REJECTED'
            report['failureDetail'] = message
        elif message.startswith(('Selected offer no longer available:', 'Actual account hourly price exceeds limit', 'Terminal instance status:', 'Allocation failed:', 'Readiness deadline exceeded')):
            report['failureCode'] = 'VAST_STARTUP_BLOCKED'
            report['failureDetail'] = message
        else:
            report['failureCode'] = 'STARTUP_OR_INFERENCE_FAILED'
    finally:
        if statefile.exists():
            recorded = json.loads(statefile.read_text()).get('instances', {})
            report['instancesAllocated'] = len(recorded)
            report['allocatedRoles'] = list(recorded)
        else:
            report['instancesAllocated'] = 0
            report['allocatedRoles'] = []
        try:
            report['cleanupPassed'] = vast.run(SimpleNamespace(command='down', yes=True,
                state_dir=args.state_dir)) == 0
        except Exception:
            report['cleanupPassed'] = False
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report))
    return 0 if report['passed'] and report['cleanupPassed'] else 4


if __name__ == '__main__':
    raise SystemExit(main())
