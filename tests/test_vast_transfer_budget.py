"""Budget regressions: identical weights, different transfer prices and refresh."""
import hashlib
import importlib.util
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import vast_transfer_budget as budget
spec = importlib.util.spec_from_file_location('planner', ROOT / 'scripts/vast-fleet-plan.py')
planner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(planner)


class TransferBudgetTests(unittest.TestCase):
    def fixture(self):
        inventory = {'observedAt': datetime.now(timezone.utc).isoformat(), 'roles': {}}
        for key, name in [('manifestSha256', 'model_manifest.json'), ('lockSha256', 'weight_assets.lock.json')]:
            inventory[key] = hashlib.sha256((ROOT / 'services/audiomonastry-ai-runtime' / name).read_bytes()).hexdigest()
        images, rows = {}, []
        for index in range(8):
            role = str(index)
            images[role] = {'image': 'image-' + role, 'compressedBytes': 5_000_000_000}
            inventory['roles'][role] = {'weightBytesUpperBound': 20_000_000_000}
            rows.append({'role': role, 'candidates': [
                {'machineId': index * 2, 'usdPerHourIncludingDisk': .3, 'ingressUsdPerGb': .05, 'egressUsdPerGb': .001, 'downloadReported': 1000},
                {'machineId': index * 2 + 1, 'usdPerHourIncludingDisk': .4, 'ingressUsdPerGb': .001, 'egressUsdPerGb': .001, 'downloadReported': 1000}]})
        plan = {'budget': {'usdToEur': .92, 'taxMultiplier': 1.19, 'unbilledEurPerHourReserve': .4, 'maxEurPerHour': 8}, 'roles': rows}
        return plan, inventory, images

    def test_selects_lower_total_test_cost_and_restores_hourly_quotes(self):
        plan, inventory, images = self.fixture()
        selected = budget.select(plan, inventory, images, planner.assignment)
        self.assertTrue(all(c['ingressUsdPerGb'] == .001 for c in selected['roles'].values()))
        self.assertAlmostEqual(3.2, selected['usdPerHourIncludingDisk'])
        self.assertGreater(selected['effectiveTestEurPerHour'], selected['grossEurPerHourWithReserve'])
        self.assertAlmostEqual(selected['firstHourUpperEur'], selected['grossEurPerHourWithReserve'] + selected['coldStartUpperEur'])
        self.assertAlmostEqual(selected['maxTestCostEur'], selected['grossEurPerHourWithReserve'] * 28 / 60 + selected['coldStartUpperEur'])
        selected['roles']['0']['ingressUsdPerGb'] = .05
        self.assertGreater(budget.upper_eur(plan, {r: v['image'] for r, v in images.items()}, selected), selected['coldStartUpperEur'])

    def test_refuses_changed_pins_stale_metadata_and_image_mismatch(self):
        for case in ('pin', 'age', 'image'):
            plan, inventory, images = self.fixture()
            if case == 'pin': inventory['manifestSha256'] = 'wrong'
            if case == 'age': inventory['observedAt'] = '2020-01-01T00:00:00+00:00'
            if case == 'image': images['0']['compressedBytes'] = float('nan')
            with self.assertRaises(RuntimeError):
                budget.select(plan, inventory, images, planner.assignment)

    def test_no_assignment_with_unpriced_ingress(self):
        plan, inventory, images = self.fixture()
        for row in plan['roles']:
            for candidate in row['candidates']: candidate['ingressUsdPerGb'] = None
        with self.assertRaises(RuntimeError):
            budget.select(plan, inventory, images, planner.assignment)

    def test_rejects_cheap_host_too_slow_for_complete_payload_and_rechecks_fresh_speed(self):
        plan, inventory, images = self.fixture()
        plan['roles'][0]['candidates'][1]['downloadReported'] = 50
        selected = budget.select(plan, inventory, images, planner.assignment)
        self.assertEqual(0, selected['roles']['0']['machineId'])
        selected['roles']['0']['downloadReported'] = 50
        with self.assertRaisesRegex(RuntimeError, 'transfer forecast exceeds readiness deadline: 0'):
            budget.upper_eur(plan, {r: v['image'] for r, v in images.items()}, selected)

    def test_missing_or_nonfinite_bandwidth_cannot_authorize_cold_start(self):
        for speed in (None, 0, -1, float('nan'), float('inf')):
            self.assertEqual(float('inf'), budget.transfer_minutes(45, {'downloadReported': speed}))

    def test_priority_executor_forecast_must_fit_its_actual_eight_minute_start_gate(self):
        plan,inventory,images=self.fixture()
        plan['roles'][0]['role']='audio-brain'
        inventory['roles']['audio-brain']=inventory['roles'].pop('0')
        images['audio-brain']=images.pop('0')
        cheap,fast=plan['roles'][0]['candidates']
        cheap.update(usdPerHourIncludingDisk=.1,ingressUsdPerGb=.001,downloadReported=161.1)
        selected=budget.select(plan,inventory,images,planner.assignment)
        self.assertEqual(fast['machineId'],selected['roles']['audio-brain']['machineId'])
        selected['roles']['audio-brain']['downloadReported']=161.1
        with self.assertRaisesRegex(RuntimeError,'readiness deadline: audio-brain'):
            budget.upper_eur(plan,{role:value['image'] for role,value in images.items()},selected)


if __name__ == '__main__':
    unittest.main()
