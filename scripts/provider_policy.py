"""Read-only guard for retired provider-specific command-line tools."""
import json
import os
from pathlib import Path


def require_provider(provider):
    policy = Path(__file__).resolve().parents[1] / 'deploy/gpu-provider.json'
    selected = os.environ.get('AI_GPU_PROVIDER') or json.loads(policy.read_text())['provider']
    if selected != provider:
        raise SystemExit('Retired provider command blocked. Active provider: ' + selected
                         + '. Use scripts/gpu-pods.py or the Vast workflows.')
