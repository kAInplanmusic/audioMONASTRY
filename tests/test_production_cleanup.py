import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]


def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


cleanup = load('production_cleanup_test', 'scripts/production/cleanup-run.py')
bootstrap = load('production_bootstrap_test', 'scripts/production/bootstrap.py')


class ProductionCleanupTests(unittest.TestCase):
    def test_runner_cleanup_deletes_only_exact_run_labels_without_host_state(self):
        own = {'id': 10, 'label': cleanup.vast.PREFIX + 'brain-43200000000'}
        others = [{'id': 11, 'label': cleanup.vast.PREFIX + 'brain-432000000001'},
                  {'id': 12, 'label': 'other-brain-43200000000'}]
        with patch.object(cleanup.vast, 'instances', side_effect=[[own] + others, others]), \
                patch.object(cleanup.vast, 'destroy') as destroy:
            report = cleanup.cleanup('43200000000')
        destroy.assert_called_once_with(10)
        self.assertTrue(report['cleanupPassed'])

    def test_cleanup_attempts_other_deletions_after_one_provider_failure(self):
        rows = [{'id': 10, 'label': cleanup.vast.PREFIX + 'brain-43200000000'},
                {'id': 11, 'label': cleanup.vast.PREFIX + 'ears-43200000000'}]
        with patch.object(cleanup.vast, 'instances', side_effect=[rows, rows[:1]]), \
                patch.object(cleanup.vast, 'destroy', side_effect=[RuntimeError('api unavailable'), None]) as destroy:
            with self.assertRaisesRegex(RuntimeError, 'DELETION_NOT_CONFIRMED'):
                cleanup.cleanup('43200000000')
        self.assertEqual(2, destroy.call_count)

    def test_invalid_run_identifier_cannot_trigger_any_remote_call(self):
        with patch.object(cleanup.vast, 'instances') as instances:
            with self.assertRaisesRegex(RuntimeError, 'Invalid deployment'):
                cleanup.cleanup('43200000000/foreign')
        instances.assert_not_called()

    def test_caddy_recovery_uses_verified_image_hash_and_disables_pulls(self):
        image = 'sha256:' + 'a' * 64
        with tempfile.TemporaryDirectory() as temp, patch.object(bootstrap, 'ROOT', Path(temp)), \
                patch.object(bootstrap.subprocess, 'run', side_effect=[Mock(stdout=image),
                    Mock(stdout='dns.providers.cloudflare\n')]):
            path, actual = bootstrap.snapshot_caddy_override()
            self.assertEqual(image, actual)
            self.assertIn('"pull_policy": "never"', path.read_text())
            self.assertEqual(0o600, path.stat().st_mode & 0o777)

    def test_caddy_without_dns_module_is_rejected(self):
        with patch.object(bootstrap.subprocess, 'run', side_effect=[Mock(stdout='sha256:' + 'a' * 64),
                Mock(stdout='http.handlers.reverse_proxy\n')]):
            with self.assertRaisesRegex(RuntimeError, 'DNS_MODULE_MISSING'):
                bootstrap.snapshot_caddy_override()


if __name__ == '__main__':
    unittest.main()
