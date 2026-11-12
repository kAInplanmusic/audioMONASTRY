"""Vast fleet module - SSOT for fleet and model definitions.

Reads from deploy/gpu/pod-fleet.json (authoritative eight-role inventory).
Provides load_fleet() and load_models() for Vast planner and tests.
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FLEET_PATH = ROOT / 'deploy/gpu/pod-fleet.json'
MODEL_MANIFEST_PATH = ROOT / 'deploy/gpu/model_manifest.json'


def load_fleet():
    """Load fleet configuration from pod-fleet.json."""
    with open(FLEET_PATH, 'r', encoding='utf-8') as f:
        fleet = json.load(f)
    # Ensure backwards-compatible structure
    if 'visPod' not in fleet and 'vis_pod' in fleet:
        fleet['visPod'] = fleet['vis_pod']
    return fleet


def load_models():
    """Load model manifest with revision pins.

    Falls back to empty dict if model_manifest.json doesn't exist yet.
    """
    if MODEL_MANIFEST_PATH.exists():
        with open(MODEL_MANIFEST_PATH, 'r', encoding='utf-8') as f:
            data = json.load(f)
            # Support both {"models": {...}} and direct {...} format
            return data.get('models', data)
    # Fallback: derive from fleet pods
    fleet = load_fleet()
    models = {}
    for pod in fleet.get('pods', []):
        for model in pod.get('models', []):
            models[model] = {'revision': 'main', 'handler': 'default'}
    if 'visPod' in fleet:
        for model in fleet['visPod'].get('models', []):
            models[model] = {'revision': 'main', 'handler': 'default'}
    return models


if __name__ == '__main__':
    import sys
    if len(sys.argv) > 1 and sys.argv[1] == 'fleet':
        print(json.dumps(load_fleet(), indent=2))
    elif len(sys.argv) > 1 and sys.argv[1] == 'models':
        print(json.dumps(load_models(), indent=2))
    else:
        print(json.dumps({'fleet': load_fleet(), 'models': load_models()}, indent=2))