"""Read pinned R2/HF byte metadata only; never downloads model payloads."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import fnmatch
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('vast', ROOT / 'scripts/vast-pods.py')
vast = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vast)


def hf_bytes(repo, revision, patterns=None):
    request = urllib.request.Request('https://huggingface.co/api/models/' + repo + '/revision/' + revision + '?blobs=true',
        headers={'Authorization': 'Bearer ' + os.environ['HF_TOKEN']})
    with urllib.request.urlopen(request, timeout=60) as response:
        data = json.load(response)
    files = [entry for entry in data['siblings'] if patterns is None or
             any(fnmatch.fnmatch(entry['rfilename'], pattern) for pattern in patterns)]
    if data['sha'] != revision or not files or any(not isinstance(entry.get('size'), int) for entry in files):
        raise RuntimeError('Pinned Hugging Face byte inventory incomplete')
    return sum(entry['size'] for entry in files)


def r2_objects(target, prefix):
    result, continuation = {}, ''
    while True:
        query = {'list-type': '2', 'max-keys': '1000', 'prefix': prefix + '/'}
        if continuation:
            query['continuation-token'] = continuation
        status, _, body = target._request('GET', '', query=query)
        if status != 200:
            raise RuntimeError('R2 inventory HTTP ' + str(status))
        doc = ET.fromstring(body)
        for item in doc.findall('{*}Contents'):
            result[item.findtext('{*}Key')] = {
                'size': int(item.findtext('{*}Size')),
                'storageClass': item.findtext('{*}StorageClass') or 'STANDARD'}
        if doc.findtext('{*}IsTruncated') != 'true':
            return result
        next_token = doc.findtext('{*}NextContinuationToken')
        if not next_token or next_token == continuation:
            raise RuntimeError('R2 inventory pagination incomplete')
        continuation = next_token


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    fleet, models = vast.shared.load_fleet(), vast.shared.load_models()
    target = vast.shared.s3lite.S3Target.from_r2_env()
    runtime = ROOT / 'services/audiomonastry-ai-runtime'
    manifest = json.loads((runtime / 'model_manifest.json').read_text())
    lock = json.loads((runtime / 'weight_assets.lock.json').read_text())['models']
    objects = r2_objects(target, fleet['weights']['prefix'])

    def one(pod):
        entries, missing = vast.shared.weight_entries(pod, models, target, fleet['weights']['prefix'], 3600)
        if missing:
            raise RuntimeError('Existing R2 weights missing: ' + pod['role'])
        for entry in entries:
            path = urllib.parse.unquote(urllib.parse.urlsplit(entry['url']).path).lstrip('/')
            if target.bucket:
                path = path.removeprefix(target.bucket + '/')
            actual = objects.get(path)
            if not actual or actual['size'] != entry['size']:
                raise RuntimeError('R2 object missing or changed: ' + pod['role'])
            if actual['storageClass'] != 'STANDARD':
                raise RuntimeError('R2 retrieval fee must be included before rental')
        parts = {'r2Bytes': sum(entry['size'] for entry in entries)}
        for mid in pod['models']:
            model = models[mid]
            if model.get('directRepo') and mid not in lock and model.get('revision') != 'cpu-only':
                parts[mid] = hf_bytes(model['repository'], model['revision'])
            components = list(model.get('weightComponents', []))
            if mid == 'sonicmaster':
                components += ['sonicmaster-text', 'sonicmaster-vae']
            for component in components:
                if component not in lock:
                    definition = manifest['weightComponents'][component]
                    parts[component] = hf_bytes(definition['repository'], definition['revision'], definition.get('allowPatterns'))
            # Count auxiliary lock files even if present in R2: conservative double counting.
            for component in [mid, *model.get('weightComponents', [])]:
                definition = lock.get(component, {})
                if not definition.get('package'):
                    parts['locked:' + component] = sum(item['size'] for item in definition.get('files', []))
        return pod['role'], {'parts': parts, 'weightBytesUpperBound': sum(parts.values()),
                             'r2ObjectsVerified': len(entries), 'r2StorageClass': 'STANDARD'}

    with ThreadPoolExecutor(max_workers=4) as pool:
        roles = dict(pool.map(one, fleet['pods'] + [fleet['visPod']]))
    result = {'observedAt': datetime.now(timezone.utc).isoformat(),
        'manifestSha256': hashlib.sha256((runtime / 'model_manifest.json').read_bytes()).hexdigest(),
        'lockSha256': hashlib.sha256((runtime / 'weight_assets.lock.json').read_bytes()).hexdigest(), 'roles': roles}
    args.output.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({role: round(value['weightBytesUpperBound'] / 1e9, 3) for role, value in roles.items()}))


if __name__ == '__main__':
    main()
