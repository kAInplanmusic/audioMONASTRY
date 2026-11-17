"""Parallel ranged weight download and the brain/audio-brain bandwidth filter."""
import hashlib
import http.server
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


startup = load('ranged_startup', 'services/audiomonastry-ai-runtime/pod_start.py')
planner = load('ranged_planner', 'scripts/vast-fleet-plan.py')
DATA = os.urandom(5 * 1024 * 1024 + 123)


def serve(honor_range):
    seen = []

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            header = self.headers.get('Range')
            seen.append(header)
            if header and honor_range:
                start, end = [int(x) for x in header.split('=')[1].split('-')]
                body = DATA[start:end + 1]
                self.send_response(206)
                self.send_header('Content-Range', 'bytes %d-%d/%d' % (start, end, len(DATA)))
            else:
                body = DATA
                self.send_response(200)
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, seen


class RangedDownloadTests(unittest.TestCase):
    def fetch(self, honor_range, digest=None):
        server, seen = serve(honor_range)
        self.addCleanup(server.shutdown)
        entry = {'name': 'm/weights.bin', 'size': len(DATA), 'sha256': digest or hashlib.sha256(DATA).hexdigest(),
                 'url': 'http://127.0.0.1:%d/w' % server.server_address[1]}
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(startup, 'RANGE_MIN_BYTES', 1024), patch.object(startup, 'RANGE_PART_BYTES', 1024 * 1024), \
                patch.object(startup.time, 'sleep'):
            path = startup.download(entry, directory, retries=1)
            return Path(path).read_bytes(), seen

    def test_large_file_loads_in_parallel_parts_and_matches_hash(self):
        data, seen = self.fetch(honor_range=True)
        self.assertEqual(DATA, data)
        self.assertEqual(6, len([h for h in seen if h]))  # 5 MiB + remainder in 1 MiB parts

    def test_server_without_range_falls_back_to_single_stream(self):
        data, seen = self.fetch(honor_range=False)
        self.assertEqual(DATA, data)

    def test_wrong_hash_is_rejected_after_ranged_download(self):
        with self.assertRaisesRegex(ValueError, 'SHA-256'):
            self.fetch(honor_range=True, digest='0' * 64)


class BandwidthFilterTests(unittest.TestCase):
    def test_priority_roles_require_minimum_download_speed(self):
        fleet = json.loads((ROOT / 'deploy/gpu/pod-fleet.json').read_text())
        required = {p['role']: p.get('minDownloadMbps') for p in fleet['pods']}
        self.assertEqual(800, required['brain'])
        self.assertEqual(800, required['audio-brain'])
        pod = next(p for p in fleet['pods'] if p['role'] == 'audio-brain')
        with patch.object(planner, 'memory_required', return_value=19):
            self.assertEqual({'gte': 800.0}, planner.query(pod, {})['inet_down'])
            other = dict(pod, minDownloadMbps=None)
            self.assertNotIn('inet_down', planner.query(other, {}))


if __name__ == '__main__':
    unittest.main()
