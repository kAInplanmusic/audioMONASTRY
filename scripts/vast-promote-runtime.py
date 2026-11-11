"""Install verified Vast role URLs/CA into an existing server-side app env.

Run on the orchestrator after the bounded API test and a production up. This
does not copy model data, change DNS, or silently restart the application.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import ssl
import urllib.request

MANIFEST = Path(__file__).resolve().parents[1] / 'services/audiomonastry-ai-runtime/model_manifest.json'


def promote(state_dir, app_env, ca_dir):
    state = json.loads((state_dir / 'state.json').read_text())
    if not state.get('promoted') or len(state.get('instances', {})) != 8:
        raise RuntimeError('Eight verified role endpoints required')
    if state.get('manifestSha256') != hashlib.sha256(MANIFEST.read_bytes()).hexdigest():
        raise RuntimeError('Model identity manifest changed since readiness verification')
    if not app_env.is_file():
        raise RuntimeError('Existing complete application env required; refusing replacement with partial configuration')
    entries = dict(line.split('=', 1) for line in (state_dir / 'runtime.env').read_text().splitlines() if '=' in line)
    if entries.get('AI_GPU_PROVIDER') != 'vast':
        raise RuntimeError('Not a Vast runtime environment')
    for item in state['instances'].values():
        ctx = ssl.create_default_context(cafile=item['cert'])
        req = urllib.request.Request(item['url'] + '/ready', headers={'Authorization': 'Bearer ' + entries['AI_POD_TOKEN']})
        with urllib.request.urlopen(req, context=ctx, timeout=30) as response:
            if response.status != 200:
                raise RuntimeError('Readiness changed; no application cutover')
    ca_dir.mkdir(parents=True, exist_ok=True, mode=0o755)
    ca_dir.chmod(0o755)
    ca = ca_dir / 'ca.pem'
    ca.write_bytes((state_dir / 'ca.pem').read_bytes())
    ca.chmod(0o644)  # Public certificates only; never mount controller keys/state.
    entries['NODE_EXTRA_CA_CERTS'] = '/etc/audiomonastry-vast/ca.pem'
    original = app_env.read_text()
    retained = [line for line in original.splitlines() if line.partition('=')[0] not in entries]
    replacement = app_env.with_name(app_env.name + '.vast-new')
    replacement.touch(mode=0o600)
    replacement.chmod(0o600)
    replacement.write_text('\n'.join(retained + [key + '=' + value for key, value in entries.items()]) + '\n')
    os.replace(replacement, app_env)


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--state-dir', required=True, type=Path)
    p.add_argument('--app-env', required=True, type=Path)
    p.add_argument('--ca-dir', required=True, type=Path)
    args = p.parse_args()
    promote(args.state_dir, args.app_env, args.ca_dir)
    print('Vast runtime environment installed; restart Node to load the CA bundle')
