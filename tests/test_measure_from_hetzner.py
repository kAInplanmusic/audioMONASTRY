import base64
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('measure', ROOT / 'scripts/measure-from-hetzner.py')
measure = importlib.util.module_from_spec(spec)
spec.loader.exec_module(measure)


class BuildTests(unittest.TestCase):
    def test_targets_include_primary_and_second_hosts_with_ports_only(self):
        with tempfile.TemporaryDirectory() as d:
            cert = Path(d) / 'c.pem'
            cert.write_text('PEM')
            state = {'instances': {'audio-brain': {'id': 1, 'host': 'h1', 'cert': str(cert)}, 'voice': {'id': 3, 'host': 'h3', 'cert': str(cert)}},
                     'hedges': {'audio-brain': {'id': 2, 'host': 'h2', 'cert': str(cert)}}}
            targets = measure.build_targets(state, {'1': '1111', '2': '2222'}, {'audio-brain': ['qwen3-4b']})
        self.assertEqual(['audio-brain', 'audio-brain-hedge'], [t['name'] for t in targets])      # voice hat keinen Port: nicht gemessen
        self.assertEqual([1111, 2222], [t['port'] for t in targets])
        self.assertEqual(['qwen3-4b'], targets[1]['expect_models'])

    def test_user_data_carries_probe_and_config_but_no_account_keys(self):
        config = {'token': 'podtoken', 'put_url': 'https://r2.example/put?sig=abc', 'targets': []}
        data = measure.build_user_data('print("probe")', config)
        self.assertTrue(data.startswith('#cloud-config'))
        self.assertIn('shutdown -h now', data)
        blobs = [line.split('content: ')[1] for line in data.splitlines() if 'content: ' in line]
        self.assertEqual('print("probe")', base64.b64decode(blobs[0]).decode())
        self.assertEqual(config, json.loads(base64.b64decode(blobs[1]).decode()))
        for word in ('HCLOUD', 'VAST_API_KEY', 'GHCR', 'R2_SECRET', 'CFS3_SECRET'):
            self.assertNotIn(word, data)
        self.assertLess(len(data.encode()), 32 * 1024)                      # Hetzner-Grenze fuer user_data

    def test_the_server_is_always_deleted_in_a_finally_block(self):
        text = (ROOT / 'scripts/measure-from-hetzner.py').read_text()
        self.assertIn("finally:\n        if server_id is not None:", text)
        self.assertIn("hetzner('DELETE', '/servers/%d' % server_id)", text)


class WaitPortsTests(unittest.TestCase):
    def run_wait(self, schedule, grace=150):
        """schedule: Liste von Sekunden-Schwellen je Instanz-ID, ab denen ein Port erscheint."""
        clock = {'now': 0.0}
        state = {'instances': {'a': {'id': 1}}, 'hedges': {'a': {'id': 2}}}

        class VP:
            @staticmethod
            def instances():
                return [{'id': ident, 'ports': {'8000/tcp': [{'HostPort': str(1000 + ident)}]} if clock['now'] >= at else {}}
                        for ident, at in schedule.items()]

        ports, running = measure.wait_ports(VP, state, 12, grace_seconds=grace, clock=lambda: clock['now'],
                                            sleep=lambda s: clock.__setitem__('now', clock['now'] + s))
        return ports, running, clock['now']

    def test_a_slow_pod_does_not_delay_the_start_beyond_the_grace_period(self):
        ports, running, end = self.run_wait({1: 700, 2: 60})
        self.assertEqual({'2'}, set(ports))                      # Pod 1 hat nach 60 + 150 s noch keinen Port: wird nicht abgewartet
        self.assertLessEqual(end, 60 + 150 + 10)
        self.assertEqual(60.0, running['2'])

    def test_all_ports_present_returns_immediately_with_their_times(self):
        ports, running, end = self.run_wait({1: 30, 2: 90})
        self.assertEqual({'1', '2'}, set(ports))
        self.assertEqual({'1': 30.0, '2': 90.0}, running)


if __name__ == '__main__':
    unittest.main()
