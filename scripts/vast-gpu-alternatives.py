"""Read-only complete GPU-type survey below 1 EUR/h; never changes runtime selection."""
import argparse
from datetime import datetime, timezone, timedelta
from email.utils import parsedate_to_datetime
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
    if _quota_exhausted.is_set():
        raise RuntimeError('Daily search quota exhausted')
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
            raw = exc.headers.get('Retry-After')
            try:
                _retry_after_seconds = max(0, int(raw))
            except (TypeError, ValueError):
                try:
                    _retry_after_seconds = max(0, math.ceil((parsedate_to_datetime(raw) - datetime.now(timezone.utc)).total_seconds()))
                except (TypeError, ValueError, OverflowError):
                    _retry_after_seconds = 3600
            try:
                detail = str(json.loads(exc.read()).get('detail', ''))
            except ValueError:
                detail = ''
            if 'Daily search row quota exhausted' in detail:
                _quota_exhausted.set()
            # Stop on every 429. A subsequent run must respect the persisted cooldown.
            raise RuntimeError('DailyQuotaExhausted' if _quota_exhausted.is_set() else 'RateLimited') from None
        raise RuntimeError('Catalog HTTP ' + str(exc.code)) from None


def hardware_validation(name, vram):
    if 'CMP' in name:
        return 'cmp-unverified'
    if vram > {'RTX 4090': 25, 'RTX 3090': 25, 'RTX 3090 Ti': 25, 'RTX 3080': 12,
               'RTX 2080 Ti': 12, 'Titan V': 13}.get(name, float('inf')):
        return 'vram-modification-unverified'
    return 'provider-reported-hardware-not-benchmarked'


def role_assessment(offer, pod, models):
    if offer.get('cpu_arch') in ('arm64', 'aarch64'):
        return 'current-images-require-amd64'
    vram = offer.get('gpu_ram', 0) / 1024
    if vram < planner.memory_required(pod, models):
        return 'insufficient-vram'
    if float(offer.get('cuda_max_good') or 0) < float(pod['minCudaVersion']):
        return 'cuda-driver-or-platform-incompatible'
    name = offer['gpu_name']
    if name.startswith(('Radeon', 'RX ', 'MI', 'AMD', 'Intel')):
        return 'current-images-require-nvidia-cuda'
    canonical = planner.ALIASES.get(name)
    if name == 'A100 SXM4' and vram < 60:
        canonical = 'NVIDIA A100-SXM4-40GB'
    if name == 'A100 PCIE' and vram < 60:
        canonical = 'NVIDIA A100 40GB PCIe'
    listed = canonical in pod['gpuPriority']
    compute = float(offer.get('compute_cap') or 0)
    if pod['role'] == 'brain' and not listed and compute < 890:
        return 'not-approved-for-current-fp8-brain'
    if pod['role'] == 'vis' and ('170HX' in name or name.startswith(('A100', 'H100', 'H200', 'B100', 'B200', 'B300'))):
        return 'not-approved-for-complete-graphics-nvenc-role'
    if pod['role'] == 'vis' and (compute >= 1200 or 'Blackwell' in (canonical or '') or name == 'RTX 5090'):
        return 'current-vis-image-lacks-sm120'
    if not listed and compute < 800:
        return 'older-architecture-needs-separate-validation'
    if float(offer.get('cpu_ram') or 0) < pod['minRamPerGpu'] * 1024 or float(offer.get('cpu_cores_effective') or 0) < pod['minVcpuCountPerGpu']:
        return 'insufficient-host-resources'
    if hardware_validation(name, vram) == 'vram-modification-unverified':
        return 'experimental-vram-modification-unverified'
    if listed:
        return 'listed-in-current-profile'
    if 'CMP' in name:
        return 'experimental-cmp-requires-real-model-benchmark'
    return 'theoretical-vram-cuda-fit-unverified'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--refresh', action='store_true', help='Refresh every GPU type after quota reset')
    args = parser.parse_args()
    fleet, models = planner.fleet_module.load_fleet(), planner.fleet_module.load_models()
    factor = fleet['budget']['usdToEur'] * fleet['budget']['taxMultiplier']
    progress_path = args.output.with_name('gpu-survey-progress.json')
    previous = json.loads(progress_path.read_text()) if progress_path.exists() else (json.loads(args.output.read_text()) if args.output.exists() else {})
    if previous.get('retryNotBefore') and datetime.fromisoformat(previous['retryNotBefore']) > datetime.now(timezone.utc):
        print(json.dumps({'status': 'cooldown-active', 'retryNotBefore': previous['retryNotBefore']}))
        return 1
    catalog = get_json('https://console.vast.ai/api/v0/gpu_names/unique/')
    names = sorted(set(catalog['gpu_names']))
    discovery_complete = bool(catalog.get('success') and names)

    progress_path = args.output.with_name('gpu-survey-progress.json')
    seed = json.loads(progress_path.read_text()) if progress_path.exists() else (json.loads(args.output.read_text()) if args.output.exists() else {})
    existing = json.loads(args.output.read_text()) if args.output.exists() else {}
    groups = {(g['gpu'], g['vramGiB']): g for g in existing.get('variants', []) + seed.get('variants', [])}
    completed = set(seed.get('completedGpuTypes', [g['gpu'] for g in seed.get('variants', [])]))
    output_observation = json.loads(args.output.read_text()).get('observedAt') if args.output.exists() else None
    # Old cached prices must not count as fresh after the provider quota resets.
    now = datetime.now(timezone.utc)
    for group in groups.values():
        group.setdefault('quoteObservedAt', seed.get('observedAt') or output_observation or now.isoformat())
    observations = dict(seed.get('typeObservations', {}))
    completed = {name for name in completed if name in observations
        and observations[name].get('status') == 'quoted'
        and (now - datetime.fromisoformat(observations[name]['checkedAt'])).total_seconds() <= 3600}
    if args.refresh:
        completed = set()
    failed, limited = [], list(seed.get('queryLimitReachedGpuTypes', []))
    observations = dict(seed.get('typeObservations', {}))
    for group in groups.values():
        group['priceStatus'] = 'confirmed-in-this-survey' if group['gpu'] in completed else 'historical-not-currently-confirmed'

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
            return name, [], str(exc) if isinstance(exc, RuntimeError) else type(exc).__name__

    batches = list(seed.get('pendingBatches', []))
    for name in names:
        if name in completed:
            continue
        name, offers, error = search(name)
        observations[name] = {'checkedAt': datetime.now(timezone.utc).isoformat(),
                              'status': error or 'quoted', 'offersReturned': len(offers)}
        if error:
            failed.append(name)
        else:
            batches.append((name, offers, error))
            completed.add(name)
            limited = [item for item in limited if item != name]
        checkpoint = {'observedAt': datetime.now(timezone.utc).isoformat(),
            'completedGpuTypes': sorted(completed), 'variants': list(groups.values()),
            'pendingBatches': batches, 'queryLimitReachedGpuTypes': limited,
            'typeObservations': observations}
        if _retry_after_seconds or _quota_exhausted.is_set():
            checkpoint['retryNotBefore'] = (datetime.now(timezone.utc) + timedelta(seconds=_retry_after_seconds)).isoformat()
        progress_path.write_text(json.dumps(checkpoint, indent=2) + '\n')
        print(json.dumps({'gpu': name, 'status': error or 'quoted', 'offers': len(offers)}), flush=True)
        if error:  # No retries or further provider calls after quota/auth/network errors.
            break
    pods = fleet['pods'] + [fleet['visPod']]
    for name, offers, error in batches:
        groups = {key: value for key, value in groups.items() if key[0] != name}
        if len(offers) >= 5:
            limited.append(name)
        for offer in offers:
            gpu_usd = offer.get('search', {}).get('gpuCostPerHour', offer.get('dph_base'))
            try:
                price = float(gpu_usd or 0) * factor
            except (TypeError, ValueError):
                continue
            if not math.isfinite(price) or not 0 < price < 1:
                continue
            vram = round(float(offer.get('gpu_ram') or 0) / 1024, 1)
            key = (name, vram)
            group = groups.setdefault(key, {'gpu': name, 'vramGiB': vram, 'minGpuGrossEurPerHour': price, 'priceBasis': 'gpu-only-search.gpuCostPerHour-or-dph_base',
                'offers': 0, 'verifiedOffers': 0, 'quoteObservedAt': observations.get(name, {}).get('checkedAt', now.isoformat()), 'priceStatus': 'confirmed-in-this-survey', 'hostingTypes': {}, 'roles': {}, 'offerEvidence': []})
            group['offerEvidence'].append({k: offer.get(k) for k in ('id', 'gpu_name', 'gpu_ram', 'cpu_arch', 'compute_cap', 'cuda_max_good', 'cpu_ram', 'cpu_cores_effective', 'verification', 'dph_base', 'dph_total', 'storage_cost', 'storage_total_cost', 'inet_up_cost', 'inet_down_cost', 'search')})
            group['offers'] += 1
            group['verifiedOffers'] += int(offer.get('verification') == 'verified')
            group['minGpuGrossEurPerHour'] = min(group['minGpuGrossEurPerHour'], price)
            hosting = offer.get('hosting_type') or ('datacenter' if offer.get('datacenter') else 'unspecified')
            group['hostingTypes'][hosting] = group['hostingTypes'].get(hosting, 0) + 1
            for pod in pods:
                assessment = role_assessment(offer, pod, models)
                value = group['roles'].setdefault(pod['role'], {})
                value[assessment] = min(value.get(assessment, float('inf')), price)
    retry_not_before = (datetime.now(timezone.utc) + timedelta(seconds=_retry_after_seconds)).isoformat() if _retry_after_seconds else None
    result = {'dailyQuotaExhausted': _quota_exhausted.is_set(), 'retryNotBefore': retry_not_before, 'typeObservations': observations, 'observedAt': datetime.now(timezone.utc).isoformat(), 'provider': 'vast', 'mode': 'theoretical-read-only',
        'gpuPriceCeilingGrossEurPerHour': 1, 'budgetConversion': fleet['budget'],
        'priceExcludes': ['role-disk-allocation', 'traffic', 'persistent-storage'],
        'gpuTypeDiscoveryComplete': discovery_complete, 'gpuCatalogTypeCount': len(names), 'gpuCatalogNames': names,
        'allGpuTypesQuoted': set(names).issubset(completed), 'retryAfterSeconds': _retry_after_seconds, 'completedGpuTypes': sorted(completed), 'gpuTypesQueried': len(completed), 'failedGpuTypes': failed, 'queryLimitReachedGpuTypes': sorted(set(limited)),
        'runtimeProfileChanged': False, 'instancesCreated': 0,
        'variants': sorted([{**group, 'hardwareValidation': hardware_validation(group['gpu'], group['vramGiB'])} for group in groups.values()], key=lambda group: (group['gpu'], group['vramGiB']))}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    progress_path.write_text(json.dumps(result, indent=2) + '\n')
    args.output.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'gpuTypesQueried': len(completed), 'variantsUnderOneEuro': sum(g.get('priceStatus') == 'confirmed-in-this-survey' for g in groups.values()),
        'failedQueries': failed, 'limitedQueries': limited}))
    return int(bool(failed))


if __name__ == '__main__':
    raise SystemExit(main())
