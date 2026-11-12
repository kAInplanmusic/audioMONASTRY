"""Read-only survey safety, price provenance and compatibility regressions."""
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('gpu_survey', ROOT / 'scripts/vast-gpu-alternatives.py')
survey = importlib.util.module_from_spec(spec)
spec.loader.exec_module(survey)


class SurveyTests(unittest.TestCase):
    def setUp(self):
        survey._quota_exhausted.clear()
        survey._retry_after_seconds = 0

    def test_daily_quota_stops_without_retry_and_records_retry_after(self):
        error = HTTPError('https://example.test', 429, 'rate limit', {'Retry-After': '123'},
                          io.BytesIO(b'{"detail":"Daily search row quota exhausted"}'))
        with patch.dict('os.environ', {'VAST_API_KEY': 'test-only'}), \
             patch.object(survey.time, 'sleep'), \
             patch.object(survey.urllib.request, 'urlopen', side_effect=error) as request:
            with self.assertRaisesRegex(RuntimeError, 'DailyQuotaExhausted'):
                survey.get_json('https://example.test')
            with self.assertRaises(RuntimeError):
                survey.get_json('https://example.test')
        self.assertEqual(1, request.call_count)
        self.assertEqual(123, survey._retry_after_seconds)

    def test_unknown_gpu_price_is_excluded_and_disk_does_not_count_as_gpu(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'survey.json'
            offer = {'gpu_name': 'RTX 4090', 'gpu_ram': 24 * 1024, 'cpu_ram': 128 * 1024,
                     'cpu_cores_effective': 32, 'compute_cap': 890, 'cuda_max_good': 13,
                     'dph_base': .5, 'dph_total': 3, 'search': {'gpuCostPerHour': .5}}
            unknown = {**offer, 'dph_base': None, 'search': {}}
            with patch.object(survey, 'get_json', side_effect=[{'success': True, 'gpu_names': ['RTX 4090']},
                                                            {'offers': [offer, unknown]}]), \
                 patch('sys.argv', ['survey', '--output', str(output)]), patch('builtins.print'):
                self.assertEqual(0, survey.main())
            data = json.loads(output.read_text())
            self.assertEqual(1, data['variants'][0]['offers'])
            self.assertAlmostEqual(.5 * .92 * 1.19, data['variants'][0]['minGpuGrossEurPerHour'])
            self.assertTrue(data['allGpuTypesQuoted'])

    def test_cooldown_makes_no_provider_request(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'survey.json'
            output.with_name('gpu-survey-progress.json').write_text(json.dumps({
                'retryNotBefore': '2099-01-01T00:00:00+00:00'}))
            with patch.object(survey, 'get_json') as request, \
                 patch('sys.argv', ['survey', '--output', str(output)]), patch('builtins.print'):
                self.assertEqual(1, survey.main())
            request.assert_not_called()

    def test_failed_query_stops_and_does_not_claim_full_coverage(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'survey.json'
            def provider(url, body=None):
                if body is None:
                    return {'success': True, 'gpu_names': ['A10', 'A40', 'L40']}
                if body['gpu_name']['eq'] == 'A10':
                    return {'offers': []}
                survey._quota_exhausted.set()
                survey._retry_after_seconds = 120
                raise RuntimeError('DailyQuotaExhausted')
            with patch.object(survey, 'get_json', side_effect=provider) as request, \
                 patch('sys.argv', ['survey', '--output', str(output)]), patch('builtins.print'):
                self.assertEqual(1, survey.main())
            data = json.loads(output.read_text())
            self.assertEqual(3, request.call_count)  # Catalog, A10, A40; never L40.
            self.assertEqual(['A10'], data['completedGpuTypes'])
            self.assertFalse(data['allGpuTypesQuoted'])
            self.assertTrue(data['dailyQuotaExhausted'])
            self.assertIsNotNone(data['retryNotBefore'])

    def test_a100_pcie_40gb_does_not_inherit_the_80gb_profile_entry(self):
        fleet, models = survey.planner.fleet_module.load_fleet(), survey.planner.fleet_module.load_models()
        pod = next(p for p in fleet['pods'] if p['role'] == 'music')
        offer = {'gpu_name': 'A100 PCIE', 'gpu_ram': 40 * 1024, 'cuda_max_good': 13,
                 'compute_cap': 800, 'cpu_ram': 256 * 1024, 'cpu_cores_effective': 32}
        self.assertEqual('theoretical-vram-cuda-fit-unverified', survey.role_assessment(offer, pod, models))

    def test_modified_4090_is_experimental_even_when_profile_lists_4090(self):
        fleet, models = survey.planner.fleet_module.load_fleet(), survey.planner.fleet_module.load_models()
        pod = next(p for p in fleet['pods'] if p['role'] == 'audio-brain')
        offer = {'gpu_name': 'RTX 4090', 'gpu_ram': 48 * 1024, 'cuda_max_good': 13,
                 'compute_cap': 890, 'cpu_ram': 256 * 1024, 'cpu_cores_effective': 32}
        self.assertEqual('experimental-vram-modification-unverified', survey.role_assessment(offer, pod, models))


if __name__ == '__main__':
    unittest.main()
