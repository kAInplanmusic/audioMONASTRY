"""Read-only complete GPU-type survey below 1 EUR/h; never changes runtime selection."""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import importlib.util
import json
import math
import os
from pathlib import Path
import time
import threading
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('planner', ROOT / 'scripts/vast-fleet-plan.py')
planner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(planner)


_request_lock = threading.Lock()
_last_request = 0.0
_quota_exhausted = threading.Event()
_retry_after_seconds = 0


def get_json(url, body=None):
    global _last_request, _retry_after_seconds
    for attempt in range(3):
        with _request_lock:
            time.sleep(max(0, 1.1 - (time.monotonic() - _last_request)))
            _last_request = time.monotonic()
        request = urllib.request.Request(url, data=None if body is None else json.dumps(body).encode(),
            headers={'Authorization': 'Bearer ' + os.environ['VAST_API_KEY'], 'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                return json.load(response)
        except urllib.error.HTTPError as exc:
            if exc.code == 429:
                try:
                    error = json.loads(exc.read())
                except ValueError:
                    error = {}
                if 'Daily search row quota exhausted' in str(error.get('detail', '')):
                    _quota_exhausted.set()
                    _retry_after_seconds = int(exc.headers.get('Retry-After') or 3600)
                    raise RuntimeError('Daily search quota exhausted') from None
            if exc.code != 429 or attempt == 2:
                raise RuntimeError('Catalog HTTP ' + str(exc.code)) from None
            time.sleep(2 ** attempt)


def role_assessment(offer, pod, models):
    vram = offer.get('gpu_ram', 0) / 1024
    if vram < planner.memory_required(pod, models):
        return 'insufficient-vram'
    if float(offer.get('cuda_max_good') or 0) < float(pod['minCudaVersion']):
        return 'cuda-driver-or-platform-incompatible'
    if float(offer.get('cpu_ram') or 0) < pod['minRamPerGpu'] * 1024 or float(offer.get('cpu_cores_effective') or 0) < pod['minVcpuCountPerGpu']:
        return 'insufficient-host-resources'
    name = offer['gpu_name']
    canonical = planner.ALIASES.get(name)
    if canonical in pod['gpuPriority'] and not (pod['role'] == 'vis' and ('Blackwell' in canonical or name == 'RTX 5090')):
        return 'listed-in-current-profile'
    compute = float(offer.get('compute_cap') or 0)
    if pod['role'] == 'brain' and compute < 890:
        return 'not-approved-for-current-fp8-brain'
    if pod['role'] == 'vis' and ('170HX' in name or name.startswith(('A100', 'H100', 'H200', 'B100', 'B200', 'B300'))):
        return 'not-approved-for-complete-graphics-nvenc-role'
    if pod['role'] == 'vis' and compute >= 1200:
        return 'current-vis-image-lacks-sm120'
    if compute < 800:
        return 'older-architecture-needs-separate-validation'
    if '170HX' in name:
        return 'experimental-cmp-requires-real-model-benchmark'
    return 'theoretical-vram-cuda-fit-unverified'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--refresh', action='store_true', help='Refresh every GPU type after quota reset')
    args = parser.parse_args()
    fleet, models = planner.fleet_module.load_fleet(), planner.fleet_module.load_models()
    factor = fleet['budget']['usdToEur'] * fleet['budget']['taxMultiplier']
    catalog = get_json('https://console.vast.ai/api/v0/gpu_names/unique/')
    names = sorted(set(catalog['gpu_names']))
    discovery_complete = bool(catalog.get('success') and names)

    progress_path = args.output.with_name('gpu-survey-progress.json')
    seed = json.loads(progress_path.read_text()) if progress_path.exists() else (json.loads(args.output.read_text()) if args.output.exists() else {})
    groups = {(g['gpu'], g['vramGiB']): g for g in seed.get('variants', [])}
    completed = set(seed.get('completedGpuTypes', [g['gpu'] for g in seed.get('variants', [])]))
    output_observation = json.loads(args.output.read_text()).get('observedAt') if args.output.exists() else None
    # Old cached prices must not count as fresh after the provider quota resets.
    now = datetime.now(timezone.utc)
    for group in groups.values():
        group.setdefault('quoteObservedAt', seed.get('observedAt') or output_observation or now.isoformat())
    stale = {g['gpu'] for g in groups.values() if (now - datetime.fromisoformat(g['quoteObservedAt'])).total_seconds() > 3600}
    completed -= stale
    if args.refresh:
        completed = set()
    failed, limited = [], list(seed.get('queryLimitReachedGpuTypes', []))

    def search(name):
        if _quota_exhausted.is_set():
            return name, [], 'DailyQuotaExhausted'
        query = {'gpu_name': {'eq': name}, 'num_gpus': {'eq': 1}, 'rentable': {'eq': True},
            'type': 'ondemand', 'limit': 5,
            'order': [['dph_total', 'asc']]}
        try:
            offers = get_json(planner.URL, query)['offers']
            return name, offers, None
        except Exception as exc:
            return name, [], type(exc).__name__

    batches = []
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = {pool.submit(search, name): name for name in names if name not in completed}
        for future in as_completed(futures):
            name, offers, error = future.result()
            if error:
                failed.append(name)
            else:
                batches.append((name, offers, error))
                completed.add(name)
            # Persist each completed type so a timeout never discards the survey.
            progress_path.write_text(json.dumps({'completedGpuTypes': sorted(completed),
                'variants': list(groups.values()), 'pendingBatches': batches,
                'queryLimitReachedGpuTypes': limited}, indent=2) + '\n')
    pods = fleet['pods'] + [fleet['visPod']]
    batches = seed.get('pendingBatches', []) + batches
    for name, offers, error in batches:
        groups = {key: value for key, value in groups.items() if key[0] != name}
        if len(offers) >= 5:
            limited.append(name)
        for offer in offers:
            price = float(offer.get('dph_total') or 0) * factor
            if not math.isfinite(price) or not 0 < price < 1:
                continue
            vram = round(float(offer.get('gpu_ram') or 0) / 1024, 1)
            key = (name, vram)
            group = groups.setdefault(key, {'gpu': name, 'vramGiB': vram, 'minGpuGrossEurPerHour': price,
                'offers': 0, 'verifiedOffers': 0, 'quoteObservedAt': datetime.now(timezone.utc).isoformat(), 'hostingTypes': {}, 'roles': {}})
            group['offers'] += 1
            group['verifiedOffers'] += int(offer.get('verification') == 'verified')
            group['minGpuGrossEurPerHour'] = min(group['minGpuGrossEurPerHour'], price)
            hosting = offer.get('hosting_type') or ('datacenter' if offer.get('datacenter') else 'unspecified')
            group['hostingTypes'][hosting] = group['hostingTypes'].get(hosting, 0) + 1
            for pod in pods:
                assessment = role_assessment(offer, pod, models)
                value = group['roles'].setdefault(pod['role'], {})
                value[assessment] = min(value.get(assessment, float('inf')), price)
    result = {'observedAt': datetime.now(timezone.utc).isoformat(), 'provider': 'vast', 'mode': 'theoretical-read-only',
        'gpuPriceCeilingGrossEurPerHour': 1, 'budgetConversion': fleet['budget'],
        'priceExcludes': ['role-disk-allocation', 'traffic', 'persistent-storage'],
        'gpuTypeDiscoveryComplete': discovery_complete, 'gpuCatalogTypeCount': len(names), 'gpuCatalogNames': names,
        'allGpuTypesQuoted': set(names).issubset(completed), 'retryAfterSeconds': _retry_after_seconds, 'completedGpuTypes': sorted(completed), 'gpuTypesQueried': len(completed), 'failedGpuTypes': failed, 'queryLimitReachedGpuTypes': limited,
        'runtimeProfileChanged': False, 'instancesCreated': 0,
        'variants': sorted(groups.values(), key=lambda group: (group['gpu'], group['vramGiB']))}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    progress_path.write_text(json.dumps(result, indent=2) + '\n')
    args.output.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'gpuTypesQueried': len(names), 'variantsUnderOneEuro': len(groups),
        'failedQueries': failed, 'limitedQueries': limited}))
    return int(bool(failed))


if __name__ == '__main__':
    raise SystemExit(main())
