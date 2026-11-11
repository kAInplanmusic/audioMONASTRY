"""Cold-start-aware assignment and fail-closed transfer proof validation."""
import copy
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def positive(value, zero=False):
    return isinstance(value, (int, float)) and math.isfinite(value) and (value >= 0 if zero else value > 0)


def payloads(evidence, images):
    inventory = evidence['inventory']
    for key, filename in [('manifestSha256', 'model_manifest.json'), ('lockSha256', 'weight_assets.lock.json')]:
        expected = hashlib.sha256((ROOT / 'services/audiomonastry-ai-runtime' / filename).read_bytes()).hexdigest()
        if inventory[key] != expected:
            raise RuntimeError('Cold-start model inventory changed')
    age = (datetime.now(timezone.utc) - datetime.fromisoformat(inventory['observedAt'])).total_seconds()
    if not 0 <= age <= 86400:
        raise RuntimeError('Cold-start inventory stale')
    result = {}
    if set(inventory['roles']) != set(images) or set(evidence['images']) != set(images):
        raise RuntimeError('Incomplete cold-start inventory')
    for role, image in images.items():
        size = evidence['images'][role]
        weights = inventory['roles'][role]['weightBytesUpperBound']
        if size['image'] != image or not positive(size['compressedBytes']) or not positive(weights, zero=True):
            raise RuntimeError('Cold-start byte proof invalid')
        result[role] = (size['compressedBytes'] + weights) / 1e9
    return result


def upper_eur(plan, images, choice):
    sizes = payloads(plan['coldStartEvidence'], images)
    total = 0.0
    for role, candidate in choice['roles'].items():
        rate = candidate.get('ingressUsdPerGb')
        if not positive(rate, zero=True):
            raise RuntimeError('Cold-start ingress quote missing')
        egress_rate = candidate.get('egressUsdPerGb')
        if not positive(egress_rate, zero=True):
            raise RuntimeError('Test egress quote missing')
        total += sizes[role] * rate * 1.10
    budget = plan['budget']
    # Outbound production traffic is measured, not truncated. The fleet's hourly
    # operating reserve remains an estimate for that variable usage.
    # 10% protocol margin plus one cent for registry/metadata/Class-B operations.
    return total * budget['usdToEur'] * budget['taxMultiplier'] + .01


def select(plan, inventory, image_sizes, assignment):
    images = {role: value['image'] for role, value in image_sizes.items()}
    evidence = {'inventory': inventory, 'images': image_sizes}
    sizes = payloads(evidence, images)
    rows = copy.deepcopy(plan['roles'])
    minutes = json.loads((ROOT / 'deploy/gpu-provider.json').read_text())['maxTestMinutes']
    for row in rows:
        role = row['role']
        candidates = []
        for candidate in row['candidates']:
            if not positive(candidate.get('ingressUsdPerGb'), zero=True) or not positive(candidate.get('egressUsdPerGb'), zero=True):
                continue
            candidate['runtimeUsdPerHour'] = candidate['usdPerHourIncludingDisk']
            candidate['usdPerHourIncludingDisk'] += sizes[role] * candidate['ingressUsdPerGb'] * 1.10
            candidates.append(candidate)
        row['candidates'] = candidates
    choice = assignment(rows)
    if choice is None:
        raise RuntimeError('No cold-start-bounded assignment')
    for candidate in choice['roles'].values():
        candidate['usdPerHourIncludingDisk'] = candidate.pop('runtimeUsdPerHour')
    choice['usdPerHourIncludingDisk'] = sum(c['usdPerHourIncludingDisk'] for c in choice['roles'].values())
    plan['coldStartEvidence'] = evidence
    budget = plan['budget']
    choice['grossEurPerHourWithReserve'] = choice['usdPerHourIncludingDisk'] * budget['usdToEur'] * budget['taxMultiplier'] + budget['unbilledEurPerHourReserve']
    choice['coldStartUpperEur'] = upper_eur(plan, images, choice)
    choice['firstHourUpperEur'] = choice['grossEurPerHourWithReserve'] + choice['coldStartUpperEur']
    choice['maxTestCostEur'] = choice['grossEurPerHourWithReserve'] * minutes / 60 + choice['coldStartUpperEur']
    choice['effectiveTestEurPerHour'] = choice['maxTestCostEur'] * 60 / minutes
    choice['fitsHourlyTestBudget'] = choice['firstHourUpperEur'] < budget['maxEurPerHour']
    plan['boundedTestAssignment'] = choice
    return choice
