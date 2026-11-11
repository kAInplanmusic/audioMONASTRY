"""Active-provider dispatcher. Legacy Runpod remains explicit, not a fallback."""
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]


def main():
    provider = json.loads((ROOT / 'deploy/gpu-provider.json').read_text())['provider']
    args = sys.argv[1:]
    command = args[0] if args else 'status'
    if provider == 'runpod' or command == 'weights':
        return subprocess.call([sys.executable, str(ROOT / 'scripts/runpod-pods.py'), *args])
    if provider != 'vast':
        raise RuntimeError('Unknown GPU provider')
    state = Path(os.environ.get('VAST_STATE_DIR', '/data/vast-fleet'))
    plan = state / 'plan.json'
    if command in ('plan', 'preflight', 'up', 'capacity'):
        state.mkdir(parents=True, exist_ok=True, mode=0o700)
        extra = []
        if command == 'up':
            inventory = state / 'transfer-inventory.json'
            code = subprocess.call([sys.executable, str(ROOT / 'scripts/vast-transfer-inventory.py'), '--output', str(inventory)])
            if code:
                return code
            extra = ['--transfer-inventory', str(inventory), '--image-sizes', str(ROOT / 'deploy/vast/image-sizes.json')]
        code = subprocess.call([sys.executable, str(ROOT / 'scripts/vast-fleet-plan.py'),
            '--region', 'hybrid', '--output', str(plan), *extra])
        if code:
            return code
        if command in ('plan', 'capacity'):
            return 0
    forwarded = [sys.executable, str(ROOT / 'scripts/vast-pods.py'), command,
                 '--plan', str(plan), '--state-dir', str(state)]
    if '--yes' in args:
        forwarded += ['--yes']
    if command == 'up':
        forwarded += ['--images', os.environ.get('VAST_IMAGES_FILE', str(ROOT / 'deploy/vast/images.json'))]
    return subprocess.call(forwarded)


if __name__ == '__main__':
    raise SystemExit(main())
