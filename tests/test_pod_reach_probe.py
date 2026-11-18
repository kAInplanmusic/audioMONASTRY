"""pod_reach_probe.py gegen einen nachgebauten Pod (lokaler TLS-Server mit selbstsigniertem Zertifikat)."""
import http.server
import importlib.util
import json
import os
from pathlib import Path
import shutil
import socket
import ssl
import subprocess
import tempfile
import threading
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('probe', ROOT / 'scripts/pod_reach_probe.py')
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)
HAVE_OPENSSL = shutil.which('openssl') is not None


def make_cert(directory):
    cert, key = Path(directory) / 'c.pem', Path(directory) / 'k.pem'
    subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', str(key), '-out', str(cert), '-days', '1',
                    '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], check=True, capture_output=True)
    return cert, key


class FakePod:
    """Antwortet wie die Pod-Runtime: erst nur verbindungslos, dann /models leer, dann Modell geladen, dann /ready=200."""

    def __init__(self, cert, key, token, delays):
        self.token, self.delays, self.t0 = token, delays, time.time()
        pod = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):
                age = time.time() - pod.t0
                if self.headers.get('Authorization') != 'Bearer ' + pod.token:
                    return self.reply(401, {'error': 'unauthorized'})
                if self.path == '/models':
                    loaded = age >= pod.delays['models']
                    return self.reply(200, {'models': [{'id': 'qwen3-4b', 'loaded': loaded}]})
                if self.path == '/ready':
                    return self.reply(200 if age >= pod.delays['ready'] else 503, {'status': 'x'})
                self.reply(404, {})

            def reply(self, status, body):
                raw = json.dumps(body).encode()
                self.send_response(status)
                self.send_header('Content-Length', str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

        self.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(str(cert), str(key))
        self.server.socket = context.wrap_socket(self.server.socket, server_side=True)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class Collector:
    def __init__(self):
        self.bodies = []
        collector = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_PUT(self):
                collector.bodies.append(json.loads(self.rfile.read(int(self.headers['Content-Length']))))
                self.send_response(200)
                self.send_header('Content-Length', '0')
                self.end_headers()

        self.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.url = 'http://127.0.0.1:%d/result' % self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


@unittest.skipUnless(HAVE_OPENSSL, 'openssl fehlt')
class ProbeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.cert, self.key = make_cert(self.tmp.name)
        self.collector = Collector()
        self.addCleanup(self.collector.close)
        os.environ['no_proxy'] = '127.0.0.1'

    def config(self, pods, **extra):
        targets = [{'name': name, 'host': '127.0.0.1', 'port': pod.port, 'cert_pem': self.cert.read_text(), 'expect_models': ['qwen3-4b']}
                   for name, pod in pods.items()]
        return {'token': 'tok', 'put_url': self.collector.url, 'max_seconds': 20, 'interval': 0.1, 'put_every': 0.3, 'targets': targets, **extra}

    def test_measures_the_timeline_for_two_pods_and_reports_the_faster_one(self):
        fast = FakePod(self.cert, self.key, 'tok', {'models': 0.2, 'ready': 0.3})
        slow = FakePod(self.cert, self.key, 'tok', {'models': 1.0, 'ready': 1.4})
        self.addCleanup(fast.close)
        self.addCleanup(slow.close)
        result, status = probe.run(self.config({'a': fast, 'b': slow}))
        self.assertTrue(result['allReady'])
        self.assertEqual(200, status)
        a, b = result['targets']['a'], result['targets']['b']
        self.assertLess(a['firstReadyS'], b['firstReadyS'])
        self.assertIsNotNone(a['firstTlsS'])
        self.assertGreaterEqual(b['firstReadyS'], 1.4)
        self.assertTrue(self.collector.bodies[-1]['done'])
        self.assertNotIn('tok', json.dumps(self.collector.bodies))            # Token nie im Ergebnis

    def test_a_pod_that_never_answers_is_reported_with_its_error_kind(self):
        sock = socket.socket()
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]            # nichts hoert zu: Verbindung abgelehnt
        sock.close()
        config = self.config({}, max_seconds=1)
        config['targets'] = [{'name': 'dead', 'host': '127.0.0.1', 'port': port, 'cert_pem': self.cert.read_text(), 'expect_models': ['qwen3-4b']}]
        result, status = probe.run(config)
        state = result['targets']['dead']
        self.assertFalse(result['allReady'])
        self.assertIsNone(state['firstTcpS'])
        self.assertIn('ConnectionRefusedError', state['errors'])

    def test_wrong_token_is_never_ready_and_counts_http_401(self):
        pod = FakePod(self.cert, self.key, 'other', {'models': 0, 'ready': 0})
        self.addCleanup(pod.close)
        config = self.config({'a': pod}, max_seconds=1)
        result, _ = probe.run(config)
        self.assertFalse(result['allReady'])
        self.assertIn('HTTP 401', result['targets']['a']['errors'])


    def test_group_stop_ends_when_every_role_has_one_ready_host_and_reports_the_roles_first_ready_time(self):
        a_fast = FakePod(self.cert, self.key, 'tok', {'models': 0.1, 'ready': 0.2})
        a_slow = FakePod(self.cert, self.key, 'tok', {'models': 60, 'ready': 60})          # Zweit-Host von a wird nie abgewartet
        b = FakePod(self.cert, self.key, 'tok', {'models': 0.5, 'ready': 0.8})
        for pod in (a_fast, a_slow, b):
            self.addCleanup(pod.close)
        config = self.config({'a-hedge': a_fast, 'a': a_slow, 'b': b}, group_stop=True, max_seconds=15)
        started = time.time()
        result, _ = probe.run(config)
        self.assertLess(time.time() - started, 10)
        self.assertTrue(result['allReady'])
        self.assertEqual({'a', 'b'}, set(result['roleFirstReadyS']))
        self.assertIsNone(result['targets']['a']['firstReadyS'])                  # langsamer Host: nicht fertig, Messung trotzdem beendet


    def test_the_ready_body_is_recorded_while_the_pod_is_still_starting(self):
        pod = FakePod(self.cert, self.key, 'tok', {'models': 100, 'ready': 100})
        self.addCleanup(pod.close)
        result, _ = probe.run(self.config({'a': pod}, max_seconds=1))
        state = result['targets']['a']
        self.assertEqual(503, state['lastReadyStatus'])
        self.assertIn('status', state['lastReadyBody'])                         # Grund fuer 503 landet im Ergebnis


if __name__ == '__main__':
    unittest.main()
