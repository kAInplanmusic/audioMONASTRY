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
from unittest.mock import MagicMock

ROOT = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


vast = load('vast_migration', 'scripts/vast-pods.py')
startup = load('startup_cache', 'services/audiomonastry-ai-runtime/pod_start.py')
promotion = load('vast_promotion', 'scripts/vast-promote-runtime.py')


class MigrationTests(unittest.TestCase):
    def test_large_signed_weight_list_fits_vast_limit_without_losing_entries(self):
        import base64, zlib
        entries = [{'url': 'https://weights.example/model/' + str(i) + '?signature=' + ('a' * 120),
                    'sha256': 'b' * 64, 'size': 1000} for i in range(200)]
        raw = json.dumps(entries)
        self.assertGreater(len(raw), 32768)
        packed = vast.compact_environment({'AI_WEIGHTS_URLS': raw, 'AI_POD_TOKEN': 'keep-this-token'})
        self.assertNotIn('AI_WEIGHTS_URLS', packed)
        self.assertLess(len(json.dumps(packed)), 28 * 1024)
        restored = json.loads(zlib.decompress(base64.b64decode(packed['VAST_WEIGHTS_ZLIB_B64'])))
        self.assertEqual(entries, restored)
        self.assertEqual('keep-this-token', packed['AI_POD_TOKEN'])
        with self.assertRaises(RuntimeError):
            vast.compact_environment({'AI_WEIGHTS_URLS': '[]', 'OTHER': 'x' * 32768})

    def test_vast_entrypoint_restores_manifest_before_start_and_removes_bootstrap_secrets(self):
        import base64, os, sys
        sys.path.insert(0, str(ROOT / 'services/audiomonastry-ai-runtime'))
        entrypoint = load('vast_entrypoint_test', 'services/audiomonastry-ai-runtime/vast_start.py')
        entries = [{'url': 'https://weights.example/a?signature=one', 'sha256': 'a' * 64, 'size': 7}]
        env = vast.compact_environment({'AI_WEIGHTS_URLS': json.dumps(entries)})
        env.update({'VAST_TLS_CERT_B64': base64.b64encode(b'cert').decode(),
                    'VAST_TLS_KEY_B64': base64.b64encode(b'private-key').decode()})
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, env), patch.object(
                entrypoint, 'Path', return_value=Path(directory)), patch.object(entrypoint.pod_start, 'main', return_value=0):
            self.assertEqual(0, entrypoint.main())
            self.assertEqual(entries, json.loads(os.environ['AI_WEIGHTS_URLS']))
            self.assertNotIn('VAST_WEIGHTS_ZLIB_B64', os.environ)
            self.assertNotIn('VAST_TLS_KEY_B64', os.environ)
            self.assertEqual(0o600, (Path(directory) / 'key.pem').stat().st_mode & 0o777)

    def test_rate_limited_create_reconciles_label_before_retrying_purchase(self):
        import os
        from email.message import Message
        headers = Message()
        headers['Retry-After'] = '0'
        error = vast.urllib.error.HTTPError('https://example.test', 429, 'rate limit', headers, io.BytesIO(b'{}'))
        label = 'audiomonastry-vast-song-test'
        with patch.dict(os.environ, {'VAST_API_KEY': 'fake-test-key'}), patch.object(vast.time, 'sleep'), patch.object(
                vast.urllib.request, 'urlopen', side_effect=error) as transport, patch.object(
                vast, 'instances', return_value=[{'id': 123, 'label': label}]):
            result = vast.api('PUT', '/api/v0/asks/456/', {'label': label})
        self.assertEqual({'success': True, 'new_contract': 123}, result)
        self.assertEqual(1, transport.call_count)

    def test_failed_startup_stops_paid_wait_without_exporting_loader_messages(self):
        error = vast.urllib.error.HTTPError('https://example.test', 503, 'not ready', {},
            io.BytesIO(b'{"status":"failed","errors":["private-signed-url"]}'))
        with self.assertRaisesRegex(RuntimeError, '^Terminal model readiness failure: vis$'):
            vast.fail_on_terminal_readiness(error, 'vis')
        loading = vast.urllib.error.HTTPError('https://example.test', 503, 'not ready', {},
            io.BytesIO(b'{"status":"loading_models"}'))
        vast.fail_on_terminal_readiness(loading, 'vis')

    def test_promotion_preserves_existing_env_and_mounts_only_public_ca(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state = root / 'state'
            state.mkdir()
            (state / 'state.json').write_text(json.dumps({'promoted': True,
                'manifestSha256': hashlib.sha256(promotion.MANIFEST.read_bytes()).hexdigest(), 'instances': {
                str(i): {'url': 'https://example.test', 'cert': 'test-cert'} for i in range(8)}}))
            (state / 'runtime.env').write_text('AI_GPU_PROVIDER=vast\nAI_POD_TOKEN=test-secret\n')
            (state / 'ca.pem').write_text('public-certificates')
            env = root / '.env'
            env.write_text('EXISTING_DB_CONFIG=keep\nAI_GPU_PROVIDER=runpod\n')
            response = MagicMock()
            response.__enter__.return_value.status = 200
            with patch.object(promotion.ssl, 'create_default_context'), patch.object(
                    promotion.urllib.request, 'urlopen', return_value=response):
                promotion.promote(state, env, root / 'ca')
            self.assertIn('EXISTING_DB_CONFIG=keep', env.read_text())
            self.assertNotIn('AI_GPU_PROVIDER=runpod', env.read_text())
            self.assertEqual('public-certificates', (root / 'ca/ca.pem').read_text())
            self.assertEqual(0o600, env.stat().st_mode & 0o777)

    def test_promotion_refuses_partial_readiness(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'state.json').write_text(json.dumps({'promoted': False, 'instances': {}}))
            with self.assertRaises(RuntimeError):
                promotion.promote(root, root / '.env', root / 'ca')

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
