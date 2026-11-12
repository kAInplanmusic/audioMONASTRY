"""Independent runner cleanup; requires no state or SSH from the CPU host."""
import importlib.util
import json
import os
from pathlib import Path
import re
import argparse

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('vast_cleanup_run', ROOT / 'scripts/vast-pods.py')
vast = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vast)
ROLES = ('brain', 'ears', 'voice', 'music', 'studio', 'audio-brain', 'song', 'vis')


def cleanup(label_timestamp):
    if not re.fullmatch(r'[0-9]{10,20}', label_timestamp):
        raise RuntimeError('Invalid deployment label timestamp')
    labels = {vast.PREFIX + role + '-' + label_timestamp for role in ROLES}
    owned = [row for row in vast.instances() if row.get('label') in labels]
    failures = 0
    for row in owned:
        try:
            vast.destroy(row['id'])
        except Exception:
            failures += 1
    remaining = [row for row in vast.instances() if row.get('label') in labels]
    report = {'runLabel': label_timestamp, 'matchedInstances': len(owned),
              'remainingOwnedInstances': len(remaining), 'cleanupPassed': not remaining and not failures}
    print(json.dumps(report), flush=True)
    if not report['cleanupPassed']:
        raise RuntimeError('OWNED_VAST_DELETION_NOT_CONFIRMED')
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run-id', default=os.environ.get('GITHUB_RUN_ID',''))
    cleanup(parser.parse_args().run_id)
