"""Bind real registry build outputs to the exact tracked build sources.

No image is built or invented here. CI supplies Docker build-push-action digests;
allocation must match this map and source fingerprint before any provider write.
"""
import hashlib
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
CONFIG = ROOT / 'deploy/vast/build-contract.json'


def source_sha():
    config = json.loads(CONFIG.read_text())
    names = subprocess.check_output(['git', 'ls-files', '-z', config['context']], cwd=ROOT).decode().split('\0')
    names += ['deploy/vast/build-contract.json', '.github/workflows/vast-fleet-images.yml', 'scripts/vast_image_attestation.py']
    rows = {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in sorted(set(names)) if name and (ROOT / name).is_file()}
    return hashlib.sha256(json.dumps(rows, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def attest(images, build_url):
    expected = set(json.loads(CONFIG.read_text())['roles']) | {'music'}
    if set(images) != expected or images['music'] != images['voice'] or len(set(images.values())) != 7:
        raise ValueError('Expected eight roles sharing exactly seven built images')
    if not all(re.fullmatch(r'ghcr\.io/kainplanmusic/audiomonastry-ai-runtime-vast@sha256:[a-f0-9]{64}', x) for x in images.values()):
        raise ValueError('Build output must contain immutable registry digests')
    if not re.fullmatch(r'https://github\.com/[^/]+/[^/]+/actions/runs/\d+', build_url):
        raise ValueError('Actual CI build run URL required')
    return {'schemaVersion': 1, 'buildSourceSha256': source_sha(), 'buildUrl': build_url, 'images': images}


def verify(images, record):
    # Re-validate cardinality, hashes, provenance and all exact image identities.
    validated = attest(images, record.get('buildUrl', ''))
    if record != validated:
        raise ValueError('Image attestation stale, mismatched or incomplete; rebuild seven images before allocation')
    return validated


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--images', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--build-url', required=True)
    args = parser.parse_args()
    args.output.write_text(json.dumps(attest(json.loads(args.images.read_text()), args.build_url), indent=2) + '\n')
