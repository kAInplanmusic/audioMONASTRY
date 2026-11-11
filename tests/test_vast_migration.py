import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


vast = load('vast_migration', 'scripts/vast-pods.py')
startup = load('startup_cache', 'services/audiomonastry-ai-runtime/pod_start.py')


class MigrationTests(unittest.TestCase):
    def test_budget_excludes_hetzner_and_supabase_but_includes_disk_and_reserve(self):
        policy = json.loads(vast.POLICY.read_text())
        self.assertEqual(0, policy['otherServicesEurPerHourReserve'])
        self.assertEqual(8, policy['maxTotalEurPerHour'])
        plan = {'budget': {'usdToEur': .92, 'taxMultiplier': 1.19,
                          'unbilledEurPerHourReserve': .4},
                'fastExecutorAndSongAssignment': {'roles': {str(i): {} for i in range(8)},
                                                  'usdPerHourIncludingDisk': 6}}
        self.assertAlmostEqual(6.9688, vast.cost_check(plan, policy)[1])
        with self.assertRaises(RuntimeError):
            vast.cost_check(plan, policy, foreign_usd=1)
        broken = copy.deepcopy(plan)
        broken['fastExecutorAndSongAssignment']['usdPerHourIncludingDisk'] = float('nan')
        with self.assertRaises(RuntimeError):
            vast.cost_check(broken, policy)

    def test_no_partial_fleet_approval(self):
        plan = {'fastExecutorAndSongAssignment': {'roles': {}, 'usdPerHourIncludingDisk': .1}}
        with self.assertRaises(RuntimeError):
            vast.cost_check(plan, json.loads(vast.POLICY.read_text()))

    def test_instance_cursor_is_consumed_without_dropping_later_costs(self):
        with patch.object(vast, 'api', side_effect=[{'instances': [{'id': 1}], 'next_token': 'next'},
                                                   {'instances': [{'id': 2}]}]) as api:
            self.assertEqual([1, 2], [x['id'] for x in vast.instances()])
            self.assertIn('after_token=next', api.call_args_list[1].args[1])

    def test_models_revisions_and_original_base_images_are_reused(self):
        fleet = vast.shared.load_fleet()
        for pod in fleet['pods'] + [fleet['visPod']]:
            self.assertRegex(pod['image'], r'@sha256:[0-9a-f]{64}$')
        docker = (ROOT / 'services/audiomonastry-ai-runtime/Dockerfile.vast').read_text()
        self.assertIn('FROM ${BASE_IMAGE}', docker)
        self.assertNotIn('pip install', docker)
        self.assertEqual(next(p['image'] for p in fleet['pods'] if p['role'] == 'voice'),
                         next(p['image'] for p in fleet['pods'] if p['role'] == 'music'))

    def test_verified_hf_file_is_reused_without_network(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory) / 'hf'
            model = Path(startup.hub_model_dir(str(home), 'org/model'))
            file = model / 'snapshots' / ('a' * 40) / 'weights.bin'
            file.parent.mkdir(parents=True)
            file.write_bytes(b'weights')
            entry = {'path': 'weights.bin', 'repo': 'org/model', 'commit': 'a' * 40,
                     'sha256': hashlib.sha256(b'weights').hexdigest(), 'size': 7,
                     'url': 'https://example.test/weights'}
            with patch.object(startup.urllib.request, 'urlopen', side_effect=AssertionError('network')):
                startup.fetch_weights([entry], str(home), str(Path(directory) / 'work'))
            file.write_bytes(b'corrupt')
            self.assertFalse(startup.weight_cached(entry, str(home)))

    def test_tar_cache_receipt_checks_bytes_and_repairs_corruption(self):
        with tempfile.TemporaryDirectory() as directory:
            home, work = Path(directory) / 'hf', Path(directory) / 'work'
            content = io.BytesIO()
            with tarfile.open(fileobj=content, mode='w') as tar:
                item = tarfile.TarInfo('hub/model.bin')
                item.size = 7
                tar.addfile(item, io.BytesIO(b'weights'))
            data = content.getvalue()
            entry = {'name': 'weights.tar', 'url': 'https://example.test/archive',
                     'sha256': hashlib.sha256(data).hexdigest(), 'size': len(data)}
            with patch.object(startup.urllib.request, 'urlopen', return_value=io.BytesIO(data)) as get:
                startup.fetch_weights([entry], str(home), str(work))
                startup.fetch_weights([entry], str(home), str(work))
                self.assertEqual(1, get.call_count)
            (home / 'hub/model.bin').write_bytes(b'changed')
            self.assertFalse(startup.weight_cached(entry, str(home)))


if __name__ == '__main__':
    unittest.main()
