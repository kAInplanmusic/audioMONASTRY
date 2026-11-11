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
                {'machineId': index * 2, 'usdPerHourIncludingDisk': .3, 'ingressUsdPerGb': .05, 'egressUsdPerGb': .001},
                {'machineId': index * 2 + 1, 'usdPerHourIncludingDisk': .4, 'ingressUsdPerGb': .001, 'egressUsdPerGb': .001}]})
        plan = {'budget': {'usdToEur': .92, 'taxMultiplier': 1.19, 'unbilledEurPerHourReserve': .4, 'maxEurPerHour': 8}, 'roles': rows}
        return plan, inventory, images

    def test_selects_lower_total_test_cost_and_restores_hourly_quotes(self):
        plan, inventory, images = self.fixture()
        selected = budget.select(plan, inventory, images, planner.assignment)
        self.assertTrue(all(c['ingressUsdPerGb'] == .001 for c in selected['roles'].values()))
        self.assertAlmostEqual(3.2, selected['usdPerHourIncludingDisk'])
        self.assertGreater(selected['effectiveTestEurPerHour'], selected['grossEurPerHourWithReserve'])
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


if __name__ == '__main__':
    unittest.main()
