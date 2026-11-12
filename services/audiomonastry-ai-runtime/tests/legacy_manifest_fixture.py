"""Scoped historical data for retired adapter regression tests only."""
import json
from pathlib import Path
import registry

FIXTURE = Path(__file__).resolve().parent / 'fixtures/legacy-model-manifest.json'
_previous = []


def read_legacy_manifest():
    return json.loads(FIXTURE.read_text())


def set_up_legacy_manifest():
    _previous.append(registry.MANIFEST_PATH)
    registry.MANIFEST_PATH = FIXTURE


def tear_down_legacy_manifest():
    registry.MANIFEST_PATH = _previous.pop()
