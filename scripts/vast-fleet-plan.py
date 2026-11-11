"""Read-only Vast.ai live offer preflight for the existing eight-role fleet.

Does not rent instances. Rates are quotes, not reservations or inference proof.
All model/image identities and resource limits come from the existing fleet.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import importlib.util
import json
import os
from pathlib import Path
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('runpod_fleet', ROOT / 'scripts/runpod-pods.py')
fleet_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fleet_module)
URL = 'https://console.vast.ai/api/v0/bundles/'
EUROPE = ['AT', 'BE', 'BG', 'CH', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR',
          'GB', 'GR', 'HR', 'HU', 'IE', 'IS', 'IT', 'LT', 'LU', 'LV', 'NL',
          'NO', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK']

# Exact provider aliases; unknown GPUs fail closed even when VRAM is sufficient.
ALIASES = {
    'RTX 6000Ada': 'NVIDIA RTX 6000 Ada Generation',
    'RTX 6000 Ada': 'NVIDIA RTX 6000 Ada Generation',
    'RTX A6000': 'NVIDIA RTX A6000',
    'A40': 'NVIDIA A40', 'L40': 'NVIDIA L40', 'L40S': 'NVIDIA L40S',
    'RTX 4090': 'NVIDIA GeForce RTX 4090',
    'RTX 5090': 'NVIDIA GeForce RTX 5090',
    'RTX 3090': 'NVIDIA GeForce RTX 3090',
    'RTX 3090 Ti': 'NVIDIA GeForce RTX 3090 Ti',
    'RTX A5000': 'NVIDIA RTX A5000', 'L4': 'NVIDIA L4',
    'RTX 5000Ada': 'NVIDIA RTX 5000 Ada Generation',
    'RTX 5000 Ada': 'NVIDIA RTX 5000 Ada Generation',
    'A100 PCIE': 'NVIDIA A100 80GB PCIe',
    'A100 SXM4': 'NVIDIA A100-SXM4-80GB',
    'A100 SXM4 80GB': 'NVIDIA A100-SXM4-80GB',
    'RTX PRO 6000 WS': 'NVIDIA RTX PRO 6000 Blackwell Workstation Edition',
    'RTX PRO 6000 S': 'NVIDIA RTX PRO 6000 Blackwell Server Edition',
    'RTX PRO 6000 MaxQ': 'NVIDIA RTX PRO 6000 Blackwell Max-Q Workstation Edition',
    'RTX PRO 5000': 'NVIDIA RTX PRO 5000 Blackwell',
}


def memory_required(pod, models):
    return (sum(float(models[m].get('estimatedVRAM', 0)) for m in pod['models'])
            + pod.get('vramReserveGb', 0) + pod.get('vramSafetyMarginGb', 6)
            + (pod.get('estimatedVRAM', 0) if pod['role'] == 'vis' else 0))


def query(pod, models, region='global'):
    result = {
        'limit': 1000, 'type': 'ondemand', 'allocated_storage': pod['containerDiskGb'],
        'verified': {'eq': True}, 'rentable': {'eq': True},
        'num_gpus': {'eq': 1}, 'gpu_ram': {'gte': memory_required(pod, models) * 1024},
        'cpu_ram': {'gte': pod['minRamPerGpu'] * 1024},
        'cpu_cores_effective': {'gte': pod['minVcpuCountPerGpu']},
        'cuda_max_good': {'gte': float(pod['minCudaVersion'])},
        'reliability': {'gte': 0.99}, 'direct_port_count': {'gte': 1},
        'disk_space': {'gte': pod['containerDiskGb']},
        'order': [['dph_total', 'asc']],
    }
    if region == 'europe':
        result['geolocation'] = {'in': EUROPE}
    return result


def search(q):
    headers = {'Content-Type': 'application/json'}
    if os.environ.get('VAST_API_KEY'):
        headers['Authorization'] = 'Bearer ' + os.environ['VAST_API_KEY']
    req = urllib.request.Request(URL, data=json.dumps(q).encode(), headers=headers)
    with urllib.request.urlopen(req, timeout=60) as response:
        return json.load(response)['offers']


def candidate(offer, pod, fleet, models):
    canonical = ALIASES.get(offer.get('gpu_name'))
    if offer.get('gpu_name') == 'A100 SXM4' and float(offer.get('gpu_ram', 0)) < 60000:
        canonical = 'NVIDIA A100-SXM4-40GB'
    if canonical not in pod['gpuPriority']:
        return None
    checks = (
        offer.get('num_gpus') == 1,
        offer.get('verification') == 'verified', offer.get('rentable') is True,
        float(offer.get('gpu_ram', 0)) >= memory_required(pod, models) * 1024,
        # cpu_ram is already the offer's allocation, not the host's full RAM.
        float(offer.get('cpu_ram', 0)) >= pod['minRamPerGpu'] * 1024,
        float(offer.get('cpu_cores_effective', 0)) >= pod['minVcpuCountPerGpu'],
        float(offer.get('cuda_max_good', 0)) >= float(pod['minCudaVersion']),
        float(offer.get('reliability2', offer.get('reliability', 0))) >= .99,
        float(offer.get('disk_space', 0)) >= pod['containerDiskGb'],
        int(offer.get('direct_port_count', 0)) >= 1,
    )
    if not all(checks):
        return None
    # search.totalHour includes disk for allocated_storage; never add disk twice.
    hourly = offer.get('search', {}).get('totalHour', offer.get('dph_total'))
    if hourly is None or float(hourly) <= 0:
        return None
    factor = fleet['budget']['usdToEur'] * fleet['budget']['taxMultiplier']
    if float(hourly) * factor > fleet['budget']['maxGpuGrossEurPerHour']:
        return None
    # Existing Vis image lacks sm_120. Do not claim Blackwell portability yet.
    if pod['role'] == 'vis' and ('Blackwell' in canonical or offer['gpu_name'] == 'RTX 5090'):
        return None
    return {
        'offerId': offer['id'], 'machineId': offer['machine_id'],
        'gpu': offer['gpu_name'], 'canonicalGpu': canonical,
        'vramGiB': round(offer['gpu_ram'] / 1024, 2),
        'allocatedRamGiB': round(offer['cpu_ram'] / 1024, 2),
        'effectiveVcpus': offer['cpu_cores_effective'],
        'cudaMax': offer['cuda_max_good'], 'location': offer.get('geolocation'),
        'reliability': offer.get('reliability2', offer.get('reliability')),
        'usdPerHourIncludingDisk': float(hourly),
        'grossEurPerHourIncludingDisk': round(float(hourly) * factor, 6),
        'diskGb': pod['containerDiskGb'],
        'ingressUsdPerGb': offer.get('inet_down_cost'),
        'egressUsdPerGb': offer.get('inet_up_cost'),
        'downloadReported': offer.get('inet_down'), 'uploadReported': offer.get('inet_up'),
    }


def assignment(rows):
    """Minimum-cost complete matching, with eight distinct physical hosts.

    A host appears once per DP iteration so overlapping offers cannot double book
    one physical GPU. This is deliberately stricter than multi-GPU co-location.
    """
    hosts = {}
    for i, row in enumerate(rows):
        for c in row['candidates']:
            best = hosts.setdefault(c['machineId'], {})
            if i not in best or c['usdPerHourIncludingDisk'] < best[i]['usdPerHourIncludingDisk']:
                best[i] = c
    states = {0: (0.0, {})}
    for options in hosts.values():
        updated = dict(states)
        for mask, (cost, choices) in states.items():
            for i, c in options.items():
                if mask & (1 << i):
                    continue
                key = mask | (1 << i)
                value = cost + c['usdPerHourIncludingDisk']
                if key not in updated or value < updated[key][0]:
                    updated[key] = (value, {**choices, rows[i]['role']: c})
        states = updated
    match = states.get((1 << len(rows)) - 1)
    return None if match is None else {'usdPerHourIncludingDisk': match[0], 'roles': match[1]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--region', choices=['global', 'europe', 'hybrid'], default='global')
    args = parser.parse_args()
    fleet, models = fleet_module.load_fleet(), fleet_module.load_models()
    pods = fleet['pods'] + [fleet['visPod']]

    def fetch(pod):
        # Keep GUI execution and visual output near the European core. For
        # asynchronous roles include both searches; a global response need not
        # contain every European offer returned by a narrower query.
        regions = ([ 'europe' ] if pod['role'] in ('audio-brain', 'vis') else
                   [ 'global', 'europe' ]) if args.region == 'hybrid' else [args.region]
        queries = [query(pod, models, region) for region in regions]
        batches = [search(q) for q in queries]
        offers = list({o['id']: o for batch in batches for o in batch}.values())
        candidates = [c for o in offers if (c := candidate(o, pod, fleet, models))]
        return {'role': pod['role'], 'models': pod['models'], 'image': pod['image'],
                'requiredVramGiB': memory_required(pod, models),
                'requiredRamGiB': pod['minRamPerGpu'], 'queries': queries,
                'returnedOffers': len(offers), 'queryLimitReached': any(
                    len(batch) >= q['limit'] for batch, q in zip(batches, queries)),
                'candidates': sorted(candidates, key=lambda c: c['usdPerHourIncludingDisk'])}

    with ThreadPoolExecutor(max_workers=4) as pool:
        rows = list(pool.map(fetch, pods))
    selected = assignment(rows)
    fast_rows = [{**r, 'candidates': [c for c in r['candidates']
                 if r['role'] not in ('audio-brain', 'song')
                 or c['gpu'] in ('RTX 4090', 'RTX 5090')]} for r in rows]
    balanced = assignment(fast_rows)
    low_transfer_rows = [{**r, 'candidates': [c for c in r['candidates']
                         if c['ingressUsdPerGb'] is not None
                         and c['egressUsdPerGb'] is not None
                         and c['ingressUsdPerGb'] <= .005
                         and c['egressUsdPerGb'] <= .005]} for r in fast_rows]
    low_transfer = assignment(low_transfer_rows)
    for choice in (selected, balanced, low_transfer):
        if not choice:
            continue
        b = fleet['budget']
        choice['grossEurPerHourWithReserve'] = round(
            choice['usdPerHourIncludingDisk'] * b['usdToEur'] * b['taxMultiplier']
            + b['unbilledEurPerHourReserve'], 4)
        choice['fitsHourlyTestBudget'] = choice['grossEurPerHourWithReserve'] <= b['maxEurPerHour']
    result = {
        'observedAt': datetime.now(timezone.utc).isoformat(), 'provider': 'vast.ai',
        'region': args.region,
        'mode': 'read-only-live-offers', 'instancesCreated': 0, 'inferenceTestRun': False,
        'budget': fleet['budget'], 'distinctPhysicalHosts': True,
        'warning': 'Quotes are not reservations. Traffic and image pulls are additional. '
                   'Budget reserve is an estimate, not a transfer-cost guarantee. '
                   'GPU suitability requires real inference and latency measurements.',
        'roles': rows, 'cheapestCompleteAssignment': selected,
        'fastExecutorAndSongAssignment': balanced,
        'lowTransferFastAssignment': low_transfer,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'output': str(args.output), 'candidateCounts': {
        r['role']: len(r['candidates']) for r in rows}, 'selected': selected}, indent=2))
    return 0 if selected and selected['fitsHourlyTestBudget'] else 2


if __name__ == '__main__':
    raise SystemExit(main())
