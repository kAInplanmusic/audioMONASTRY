"""Vast observer: only reads, never leaks secrets, records exactly the state changes the Vast docs define as meaningful."""
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


observe = load('vast_observe', 'scripts/vast-observe.py')


class SanitizeTests(unittest.TestCase):
    def test_urls_tokens_and_long_identifiers_are_removed(self):
        text = ('GET https://host.example/f?X-Amz-Signature=abcdef0123456789&X-Amz-Credential=KEY done\n'
                'Authorization: Bearer ghp_0123456789abcdefghijklmnopqrstuvwxyz\n'
                'password=hunter2hunter2 ok\nhash 0123456789abcdef0123456789abcdef0123456789abcdef end')
        clean = observe.sanitize(text)
        for secret in ('X-Amz-Signature', 'ghp_0123', 'hunter2', '0123456789abcdef0123456789abcdef'):
            self.assertNotIn(secret, clean)
        self.assertIn('[url]', clean)
        self.assertIn('done', clean)
        self.assertIn('ok', clean)


class SnapshotTests(unittest.TestCase):
    base = {'id': 7, 'label': 'audiomonastry-vast-audio-brain-1', 'actual_status': 'loading', 'intended_status': 'running',
            'status_msg': 'Downloading image layers', 'ports': None, 'machine_id': 5, 'gpu_name': 'RTX 3090', 'inet_down': 898.0}

    def test_snapshot_keeps_the_cold_start_fields_and_no_port_numbers(self):
        shot = observe.snapshot({**self.base, 'ports': {'8000/tcp': [{'HostIp': '0.0.0.0', 'HostPort': '40105'}]}, 'extra': 'x'})
        self.assertEqual({'id', 'label', 'actual', 'intended', 'msg', 'port8000', 'machine', 'gpu', 'inetDown'}, set(shot))
        self.assertTrue(shot['port8000'])
        self.assertNotIn('40105', str(shot))

    def test_status_message_is_sanitized(self):
        shot = observe.snapshot({**self.base, 'status_msg': 'pull https://ghcr.io/v2/x?token=abc failed'})
        self.assertNotIn('https://', shot['msg'])

    def test_changes_are_reported_only_for_meaningful_fields(self):
        first = observe.snapshot(self.base)
        self.assertTrue(observe.changed(None, first))
        self.assertFalse(observe.changed(first, observe.snapshot({**self.base, 'inet_down': 123.0})))     # Messwert-Rauschen
        self.assertTrue(observe.changed(first, observe.snapshot({**self.base, 'actual_status': 'running'})))
        self.assertTrue(observe.changed(first, observe.snapshot({**self.base, 'status_msg': 'Extracting'})))
        self.assertTrue(observe.changed(first, observe.snapshot({**self.base, 'ports': {'8000/tcp': [{'HostPort': '1'}]}})))


class FetchLogsTests(unittest.TestCase):
    class Pods:
        def __init__(self, answer):
            self.answer, self.calls = answer, []

        def api(self, method, path, body=None):
            self.calls.append((method, path, body))
            return self.answer

    def test_logs_are_requested_with_the_documented_endpoint_and_only_https_result_urls_are_followed(self):
        pods = self.Pods({'success': True, 'result_url': 'file:///etc/passwd'})
        self.assertIsNone(observe.fetch_logs(pods, 7))
        self.assertEqual(('PUT', '/api/v0/instances/request_logs/7', {'tail': '1500'}), pods.calls[0])
        self.assertIsNone(observe.fetch_logs(self.Pods({'success': True}), 7))
        self.assertIsNone(observe.fetch_logs(self.Pods([]), 7))

    def test_downloaded_logs_are_sanitized(self):
        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def read(self):
                return b'loading weights from https://r2.example/x?X-Amz-Signature=abc\nready'
        pods = self.Pods({'result_url': 'https://s3.amazonaws.com/vast.ai/instance_logs/h.log'})
        with patch.object(observe.urllib.request, 'urlopen', return_value=Response()), patch.object(observe.time, 'sleep'):
            text = observe.fetch_logs(pods, 7)
        self.assertNotIn('X-Amz-Signature', text)
        self.assertIn('ready', text)


class LastPodLineTests(unittest.TestCase):
    def test_structured_pod_line_wins_over_library_noise(self):
        text = '{"ts": "t", "msg": "models ready"}\n[transformers] falling back\n[transformers] more noise\n'
        self.assertEqual('{"ts": "t", "msg": "models ready"}', observe.last_pod_line(text))
        self.assertEqual('INFO:     Uvicorn running', observe.last_pod_line('x\nINFO:     Uvicorn running\nnoise'))
        self.assertEqual('only noise', observe.last_pod_line('only noise'))
        self.assertEqual('', observe.last_pod_line(None))


if __name__ == '__main__':
    unittest.main()
