"""Active-provider dispatcher. Legacy Runpod remains explicit, not a fallback.

Commands: plan | preflight | capacity | up | status | stop | resume | down | weights
  up      fresh rental of all eight roles (image pull + weight download)
  stop    shutdown with snapshot: GPUs stopped, disks kept (disk still billed)
  resume  warm start from the snapshot (no image pull, cached weights reused)
  down    delete everything (0 EUR/h)
With VAST_APP_ENV set, up/resume wire the ready pod URLs into the app env.
"""
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
    if command == 'weights':
        # R2-Gewichte-Check der Flotte (providerunabhängig, vast-fleet-module.py).
        return subprocess.call([sys.executable, str(ROOT / 'scripts/vast-fleet-module.py'), 'weights'])
    if provider == 'runpod':
        raise RuntimeError('RunPod ist abgeschaltet (Vast-Migration) - deploy/gpu-provider.json auf vast setzen')
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
            '--region', json.loads((ROOT / 'deploy/gpu-provider.json').read_text())['regionPolicy'], '--output', str(plan), *extra])
        if code:
            return code
        if command in ('plan', 'capacity'):
            return 0
    forwarded = [sys.executable, str(ROOT / 'scripts/vast-pods.py'), command,
                 '--plan', str(plan), '--state-dir', str(state)]
    if '--yes' in args:
        forwarded += ['--yes']
    if command in ('up', 'resume'):
        forwarded += ['--images', os.environ.get('VAST_IMAGES_FILE', str(ROOT / 'deploy/vast/images.json'))]
    code = subprocess.call(forwarded)
    if code == 0 and command in ('up', 'resume'):
        code = wire_app(state)
    return code


def wire_app(state):
    """Install the verified pod URLs/CA into the app env when VAST_APP_ENV is set.

    Uses the existing guarded promotion (eight ready roles, unchanged manifest,
    live /ready re-check). Without VAST_APP_ENV nothing changes; Node still
    needs a restart to load the CA bundle.
    """
    app_env = os.environ.get('VAST_APP_ENV', '').strip()
    if not app_env:
        print('VAST_APP_ENV not set; run scripts/vast-promote-runtime.py to wire the app', flush=True)
        return 0
    return subprocess.call([sys.executable, str(ROOT / 'scripts/vast-promote-runtime.py'),
                            '--state-dir', str(state), '--app-env', app_env,
                            '--ca-dir', os.environ.get('VAST_CA_DIR', '/etc/audiomonastry-vast')])


if __name__ == '__main__':
    raise SystemExit(main())
