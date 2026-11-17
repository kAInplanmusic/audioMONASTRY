"""Append real CI build outputs as audit records; historical records are never build inputs."""
import datetime
import json
import os
from pathlib import Path
import subprocess
import sys
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
from vast_image_attestation import verify


def main():
    record = json.loads((ROOT / 'deploy/vast/image-attestation.json').read_text())
    images = json.loads((ROOT / 'deploy/vast/images.json').read_text())
    verify(images, record)
    path = ROOT / 'EVIDENCE_REGISTRY.json'
    records = json.loads(path.read_text())
    commit = os.environ['GITHUB_SHA']
    if record['buildUrl'] != os.environ['BUILD_URL']:
        raise ValueError('Evidence build URL must identify the actual current CI run')
    for role, image in images.items():
        if role == 'music':
            continue
        ident = 'R5-IMAGE-' + role + '-' + commit[:12]
        if any(r['id'] == ident for r in records):
            raise ValueError('Duplicate build evidence ID')
        records.append({'id': ident, 'task': 'M2',
            'claim': 'Actual registry build output; buildSourceSha256=' + record['buildSourceSha256'],
            'command': 'docker/build-push-action canonical role target; model identity/import checks',
            'output': image, 'date': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'source': record['buildUrl']})
    tmp = path.with_suffix('.json.tmp')
    tmp.write_text(json.dumps(records, ensure_ascii=False, indent=2) + '\n')
    tmp.replace(path)
    if '--stage' in sys.argv:
        subprocess.run(['git', 'add', str(path)], cwd=ROOT, check=True)


if __name__ == '__main__': main()
