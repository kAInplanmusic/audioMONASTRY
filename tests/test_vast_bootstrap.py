"""Exercise the real TLS progress endpoint and production port handoff."""
import importlib.util
import json
import os
from pathlib import Path
import socket
import ssl
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / 'services/audiomonastry-ai-runtime'
spec = importlib.util.spec_from_file_location('bootstrap', RUNTIME / 'vast_bootstrap.py')
bootstrap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bootstrap)


class BootstrapTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.cert = Path(self.directory.name) / 'cert.pem'
        self.key = Path(self.directory.name) / 'key.pem'
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
            '-keyout', str(self.key), '-out', str(self.cert), '-days', '1',
            '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'],
            check=True, capture_output=True)
        self.context = ssl.create_default_context(cafile=str(self.cert))
        self.token = 'test-only-token-' + 'x' * 32
        self.env = {'AI_TLS_CERT_FILE': str(self.cert), 'AI_TLS_KEY_FILE': str(self.key),
                    'AI_POD_TOKEN': self.token, 'PORT': '0'}

    def get(self, port, path='/ready', token=None):
        request = urllib.request.Request('https://127.0.0.1:' + str(port) + path,
            headers={'Authorization': 'Bearer ' + (token or self.token)})
        try:
            response = urllib.request.urlopen(request, context=self.context, timeout=1)
        except urllib.error.HTTPError as exc:
            response = exc
        with response:
            return response.code, json.load(response)

    def test_tls_auth_and_failure_metadata_never_claim_readiness(self):
        state = {'phase': 'fetching_weights'}
        with patch.dict(os.environ, self.env):
            server, thread = bootstrap.start_server(state, self.token)
        try:
            port = server.server_port
            self.assertEqual(401, self.get(port, token='invalid')[0])
            self.assertEqual((200, {'models': []}), self.get(port, '/models'))
            self.assertEqual(503, self.get(port)[0])
            state.update(phase='failed', errorCode=bootstrap.error_code(
                urllib.error.HTTPError('https://private.example/?signature=secret', 403, 'private', {}, None)))
            status, body = self.get(port)
            self.assertEqual(503, status)
            self.assertEqual('DOWNLOAD_HTTP_403', body['errorCode'])
            self.assertNotIn('private', json.dumps(body))
            self.assertNotIn('signature', json.dumps(body))
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_supervisor_releases_tls_port_before_runtime_binds(self):
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            port = listener.getsockname()[1]
        code = '''
import os,ssl
from http.server import BaseHTTPRequestHandler,HTTPServer
import pod_start,vast_bootstrap
def runtime():
    pod_start.progress('fetching_weights')
    pod_start.progress('verifying_assets')
    pod_start.progress('starting_runtime')
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*args):pass
        def do_GET(self):
            raw=b'{"runtime":true}'
            self.send_response(200);self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
    server=HTTPServer(('127.0.0.1',int(os.environ['PORT'])),Handler)
    context=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(os.environ['AI_TLS_CERT_FILE'],os.environ['AI_TLS_KEY_FILE'])
    server.socket=context.wrap_socket(server.socket,server_side=True)
    server.timeout=10;server.handle_request();server.server_close()
    return 0
pod_start.main=runtime
raise SystemExit(vast_bootstrap.supervise())
'''
        process = subprocess.Popen([sys.executable, '-c', code], cwd=RUNTIME,
            env={**os.environ, **self.env, 'PORT': str(port)}, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            deadline = time.monotonic() + 12
            body = {}
            while time.monotonic() < deadline:
                try:
                    _, body = self.get(port)
                    if body.get('runtime'):
                        break
                except OSError:
                    pass
                time.sleep(.1)
            self.assertEqual({'runtime': True}, body)
            stdout, stderr = process.communicate(timeout=5)
            self.assertEqual(0, process.returncode, stderr.decode())
        finally:
            if process.poll() is None:
                process.kill()
                process.communicate()


if __name__ == '__main__':
    unittest.main()
