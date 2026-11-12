"""Read-only, TLS-verified model status; never reads or exports container logs."""
import argparse
import base64
from concurrent.futures import ThreadPoolExecutor
import importlib.util
import json
import math
import os
from pathlib import Path
import ssl
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('vast', ROOT / 'scripts/vast-pods.py')
vast = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vast)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--label-timestamp', required=True, type=int)
    args = parser.parse_args()
    fleet, models = vast.shared.load_fleet(), vast.shared.load_models()
    pods = {p['role']: p for p in fleet['pods'] + [fleet['visPod']]}
    labels = {vast.PREFIX + role + '-' + str(args.label_timestamp): role for role in pods}
    inventory=vast.instances()
    items = [item for item in inventory if item.get('label') in labels]

    def probe(item):
        role = labels[item['label']]
        result = {'role': role, 'containerStatus': item.get('actual_status')}
        message = str(item.get('status_msg') or '').lower()
        result['providerFailure'] = vast.provider_failure(item)
        result['providerReportedError'] = any(word in message for word in ('error', 'failed', 'denied'))
        ports = (item.get('ports') or {}).get('8000/tcp') or []
        if not ports:
            result['endpointStatus'] = 'port-not-published'
            return result
        try:
            env = dict(item.get('extra_env') or {})
            cert = base64.b64decode(env['VAST_TLS_CERT_B64'], validate=True).decode()
            context = ssl.create_default_context(cadata=cert)
            url = 'https://' + item['public_ipaddr'] + ':' + str(int(ports[0]['HostPort']))

            def get(path):
                request = urllib.request.Request(url + path, headers={
                    'Authorization': 'Bearer ' + os.environ['AI_POD_TOKEN']})
                try:
                    response = urllib.request.urlopen(request, context=context, timeout=8)
                except urllib.error.HTTPError as exc:
                    response = exc
                with response:
                    return response.code, json.load(response)

            status, listing = get('/models')
            expected = set(pods[role]['models'])
            resident = {m['id']: m for m in listing.get('models', []) if m.get('loaded')}
            result.update(modelsHttpStatus=status, loadedModels=sorted(expected & resident.keys()),
                allExpectedModelsLoaded=status == 200 and expected == set(resident),
                loadedIdentitiesMatch=all(resident[mid].get('repository') == models[mid].get('repository')
                    and resident[mid].get('revision') == models[mid].get('revision') for mid in expected & resident.keys()))
            status, ready = get('/ready')
            result['readyHttpStatus'] = status
            # Only allow known status values, never raw loader errors or paths.
            phase = ready.get('status')
            result['readinessPhase'] = phase if phase in ('ready', 'starting', 'loading_models', 'failed', 'shutting_down') else 'unknown'
            result['startupErrorCount'] = len(ready.get('errors', []))
            if ready.get('phase') in ('initializing', 'fetching_weights', 'verifying_assets', 'starting_runtime', 'failed'):
                result['bootstrapPhase'] = ready['phase']
        except Exception as exc:
            result['endpointStatus'] = type(exc).__name__
        return result

    with ThreadPoolExecutor(max_workers=8) as pool:
        result = list(pool.map(probe, items))
    account = vast.api('GET','/api/v0/users/current/')
    quotes = [item.get('dph_total') for item in items]
    valid_quotes = all(isinstance(value, (int,float)) and math.isfinite(value) and value >= 0 for value in quotes)
    budget = fleet['budget']
    gross = (sum(quotes) * budget['usdToEur'] * budget['taxMultiplier'] + budget['unbilledEurPerHourReserve']) if items and valid_quotes else (0 if not items else None)
    print(json.dumps({'readOnly': True, 'containerLogsRead': False, 'roles': result,
        'ownedInstanceCount':len(items),
        'projectInstanceCount':sum(str(item.get('label') or '').startswith(vast.PREFIX) for item in inventory),
        'accountInstanceCount':len(inventory),'observedBudgetEurPerHour':gross,
        'budgetAssumptions':{key:budget[key] for key in ('usdToEur','taxMultiplier','unbilledEurPerHourReserve')},
        'accountBalanceUsd':account.get('balance'),'accountCreditUsd':account.get('credit')}, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
