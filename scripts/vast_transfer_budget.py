"""Cold-start-aware assignment and fail-closed transfer proof validation."""
import copy
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_EXECUTOR_STARTUP_MINUTES = 8


MAX_TEST_WINDOW_MINUTES = 90


def test_window_minutes(environ=None):
    """Gesamtfenster eines Flotten-Tests. Standard: `maxTestMinutes` aus deploy/gpu-provider.json (28). Messung 2026-11-18: Image-Pull allein
    ~8 Minuten je Rolle, Gewichte kommen danach; fuer einen Gesamtlauf mit realen Zeiten darf `VAST_TEST_WINDOW_MINUTES` das Fenster
    verlaengern, nie unter den Standard und nie ueber 90 Minuten. Die Stundenobergrenze (maxTotalEurPerHour) bleibt unberuehrt;
    die ausgewiesene Testkosten-Schranke waechst mit dem Fenster."""
    environ = os.environ if environ is None else environ
    base = json.loads((ROOT / 'deploy/gpu-provider.json').read_text())['maxTestMinutes']
    raw = environ.get('VAST_TEST_WINDOW_MINUTES')
    if raw is None:
        return base
    try:
        value = float(raw)
    except ValueError:
        raise RuntimeError('VAST_TEST_WINDOW_MINUTES must be a number') from None
    if not math.isfinite(value) or not base <= value <= MAX_TEST_WINDOW_MINUTES:
        raise RuntimeError('VAST_TEST_WINDOW_MINUTES must be between %s and %s' % (base, MAX_TEST_WINDOW_MINUTES))
    return value


def executor_startup_minutes(environ=None):
    """Frist bis der Prioritaets-Pod (audio-brain) bereit sein muss, bevor sieben weitere Rollen gemietet werden.
    Standard 8 Minuten. Messung 2026-11-18: allein der Image-Pull (4,15 GB) dauerte ~7,9 Minuten (~70 Mbit/s trotz gemeldeter 873 Mbit/s),
    die Frist reicht dafuer nicht. `VAST_EXECUTOR_STARTUP_MINUTES` darf sie verlaengern, aber nur bis `maxTestMinutes - 2` und nie unter 2."""
    environ = os.environ if environ is None else environ
    raw = environ.get('VAST_EXECUTOR_STARTUP_MINUTES')
    if raw is None:
        return DEFAULT_EXECUTOR_STARTUP_MINUTES
    limit = test_window_minutes(environ) - 2
    try:
        value = float(raw)
    except ValueError:
        raise RuntimeError('VAST_EXECUTOR_STARTUP_MINUTES must be a number') from None
    if not math.isfinite(value) or not 2 <= value <= limit:
        raise RuntimeError('VAST_EXECUTOR_STARTUP_MINUTES must be between 2 and %s' % limit)
    return value


EXECUTOR_STARTUP_MINUTES = executor_startup_minutes()


def positive(value, zero=False):
    return isinstance(value, (int, float)) and math.isfinite(value) and (value >= 0 if zero else value > 0)


def transfer_minutes(gigabytes, candidate):
    """Optimistic transfer forecast; reported Mbps is no throughput guarantee."""
    speed = candidate.get('downloadReported')
    if not positive(speed):
        return math.inf
    return gigabytes * 1e9 * 8 / (speed * 1e6 * 60)


def transfer_deadline_minutes(role=None):
    # Preserve the existing two-minute cleanup reserve. Model loading and
    # inference still need additional time, so passing is necessary, not enough.
    fleet_limit=test_window_minutes() - 2
    # The priority executor must pass a shorter gate before seven more rentals.
    # Reserve two minutes for verification/model loading inside that gate.
    return min(fleet_limit,EXECUTOR_STARTUP_MINUTES-2) if role=='audio-brain' else fleet_limit


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
        if transfer_minutes(sizes[role], candidate) >= transfer_deadline_minutes(role):
            raise RuntimeError('Cold-start transfer forecast exceeds readiness deadline: ' + role)
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
    minutes = test_window_minutes()
    for row in rows:
        role = row['role']
        candidates = []
        for candidate in row['candidates']:
            if not positive(candidate.get('ingressUsdPerGb'), zero=True) or not positive(candidate.get('egressUsdPerGb'), zero=True):
                continue
            duration = transfer_minutes(sizes[role], candidate)
            if duration >= transfer_deadline_minutes(role):
                continue
            candidate['estimatedTransferMinutesAtReportedSpeed'] = round(duration, 3)
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
