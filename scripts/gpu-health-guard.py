"""Read-only health and pinned-identity guard for the eight Vast roles."""
import argparse
import json
import os
from pathlib import Path
import ssl
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


def check(roles=None):
    fleet = json.loads((ROOT / 'deploy/gpu/pod-fleet.json').read_text())
    models = {m['id']: m for m in json.loads((ROOT / 'services/audiomonastry-ai-runtime/model_manifest.json').read_text())['models']}
    token = os.environ.get('AI_POD_TOKEN', '')
    if len(token) < 32:
        raise RuntimeError('AI_POD_TOKEN missing')
    ca = os.environ.get('NODE_EXTRA_CA_CERTS')
    context = ssl.create_default_context(cafile=ca) if ca else ssl.create_default_context()
    rows = []
    for pod in fleet['pods'] + [fleet['visPod']]:
        if roles and pod['role'] not in roles:
            continue
        name = pod['role'].upper().replace('-', '_')
        url = os.environ.get('VAST_POD_URL_' + name, '').rstrip('/')
        row = {'role': pod['role'], 'ready': False, 'identityMatched': False}
        rows.append(row)
        if not url.startswith('https://'):
            row['error'] = 'Vast TLS endpoint missing'
            continue
        try:
            def get(path):
                req = urllib.request.Request(url + path, headers={'Authorization': 'Bearer ' + token})
                with urllib.request.urlopen(req, context=context, timeout=15) as response:
                    return json.load(response)
            get('/ready')
            row['ready'] = True
            resident = {m['id']: m for m in get('/models')['models'] if m.get('loaded')}
            row['identityMatched'] = set(resident) == set(pod['models']) and all(
                resident[mid].get('repository') == models[mid].get('repository') and
                resident[mid].get('revision') == models[mid].get('revision') for mid in pod['models'])
        except Exception as exc:
            row['error'] = type(exc).__name__
    return {'provider': 'vast', 'roles': rows, 'passed': bool(rows) and all(r['ready'] and r['identityMatched'] for r in rows)}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--roles', default='')
    parser.add_argument('--group', choices=['all', 'core', 'generation'], default='all')
    args = parser.parse_args()
    selected = args.roles.split(',') if args.roles else {'all': None, 'core': ['brain', 'ears'],
        'generation': ['voice', 'music', 'studio', 'song']}[args.group]
    try:
        result = check(selected)
        print(json.dumps(result))
        raise SystemExit(0 if result['passed'] else 4)
    except RuntimeError as exc:
        print(str(exc))
        raise SystemExit(4)
