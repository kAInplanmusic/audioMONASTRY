"""Provider offer semantics and complete-fleet assignment regressions."""
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('vast_plan', ROOT / 'scripts/vast-fleet-plan.py')
vast = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vast)


class VastPlanTests(unittest.TestCase):
    def setUp(self):
        self.fleet = vast.fleet_module.load_fleet()
        self.models = vast.fleet_module.load_models()
        self.roles = {p['role']: p for p in self.fleet['pods'] + [self.fleet['visPod']]}

    def offer(self, **overrides):
        return {'id': 1, 'machine_id': 2, 'gpu_name': 'RTX 6000Ada',
                'gpu_ram': 48 * 1024, 'cpu_ram': 96 * 1024,
                'cpu_cores_effective': 8, 'gpu_frac': .125,
                'num_gpus': 1, 'cuda_max_good': 13, 'verification': 'verified',
                'rentable': True, 'reliability2': .999, 'disk_space': 500,
                'direct_port_count': 12, 'dph_total': .9,
                'search': {'totalHour': 1.0}, **overrides}

    def test_bounded_test_can_include_verified_98_percent_hosts(self):
        with patch.dict('os.environ', {'VAST_MIN_RELIABILITY': '.99'}):
            self.assertIsNone(vast.candidate(self.offer(reliability2=.985), self.roles['brain'], self.fleet, self.models))
        with patch.dict('os.environ', {'VAST_MIN_RELIABILITY': '.98'}):
            self.assertIsNotNone(vast.candidate(self.offer(reliability2=.985), self.roles['brain'], self.fleet, self.models))
        with patch.dict('os.environ', {'VAST_MIN_RELIABILITY': 'nan'}):
            with self.assertRaises(RuntimeError):
                vast.minimum_reliability()

    def test_resource_requirements_follow_current_model_manifest(self):
        expected = {'brain': 47, 'ears': 42, 'voice': 45, 'music': 33,
                    'studio': 69, 'audio-brain': 19, 'song': 23, 'vis': 27}
        self.assertEqual(expected, {r: vast.memory_required(p, self.models) for r, p in self.roles.items()})

    def test_offer_ram_is_allocated_ram_not_host_total(self):
        self.assertIsNotNone(vast.candidate(self.offer(), self.roles['brain'], self.fleet, self.models))
        self.assertIsNone(vast.candidate(self.offer(cpu_ram=63 * 1024), self.roles['brain'], self.fleet, self.models))

    def test_disk_quote_is_not_added_twice(self):
        c = vast.candidate(self.offer(), self.roles['brain'], self.fleet, self.models)
        self.assertEqual(1.0, c['usdPerHourIncludingDisk'])

    def test_expensive_offers_and_unknown_cards_are_rejected(self):
        for offer in [self.offer(search={'totalHour': 2}), self.offer(gpu_name='Tesla V100')]:
            self.assertIsNone(vast.candidate(offer, self.roles['brain'], self.fleet, self.models))

    def test_vis_does_not_use_sm120_with_original_image(self):
        self.assertIsNone(vast.candidate(self.offer(gpu_name='RTX 5090', gpu_ram=32 * 1024),
                                         self.roles['vis'], self.fleet, self.models))

    def test_brain_does_not_assume_ampere_fp8_compatibility(self):
        self.assertIsNone(vast.candidate(self.offer(gpu_name='A100 PCIE', gpu_ram=80 * 1024),
                                         self.roles['brain'], self.fleet, self.models))

    def test_complete_assignment_avoids_greedy_host_conflict(self):
        def c(host, price):
            return {'machineId': host, 'usdPerHourIncludingDisk': price}
        rows = [{'role': 'a', 'candidates': [c(1, .1), c(2, .3)]},
                {'role': 'b', 'candidates': [c(1, .2)]}]
        result = vast.assignment(rows)
        self.assertAlmostEqual(.5, result['usdPerHourIncludingDisk'])
        self.assertEqual(2, result['roles']['a']['machineId'])
        rows[0]['candidates'] = [c(1, .1)]
        self.assertIsNone(vast.assignment(rows))

    def test_europe_query_retains_disk_and_reliability_guards(self):
        q = vast.query(self.roles['studio'], self.models, 'europe')
        self.assertEqual(250, q['allocated_storage'])
        self.assertEqual({'gte': 88 * 1024}, q['cpu_ram'])
        self.assertEqual({'gte': .99}, q['reliability'])
        self.assertIn('DE', q['geolocation']['in'])
        self.assertNotIn('US', q['geolocation']['in'])


if __name__ == '__main__':
    unittest.main()
