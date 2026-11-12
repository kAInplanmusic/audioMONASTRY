"""Authenticated TLS progress until the production runtime takes over its port."""
import errno
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import multiprocessing
import os
import signal
import ssl
import tarfile
import threading
import time
import urllib.error


def error_code(exc):
    if isinstance(exc, urllib.error.HTTPError):
        return 'DOWNLOAD_HTTP_' + str(exc.code) if exc.code in (400, 401, 403, 404, 429, 500, 502, 503, 504) else 'DOWNLOAD_HTTP_ERROR'
    if isinstance(exc, PermissionError):
        return 'PERMISSION_DENIED'
    if isinstance(exc, OSError) and exc.errno == errno.ENOSPC:
        return 'DISK_FULL'
    if isinstance(exc, MemoryError) or (isinstance(exc, OSError) and exc.errno == errno.ENOMEM):
        return 'HOST_MEMORY_EXHAUSTED'
    if isinstance(exc, RuntimeError) and str(exc).startswith('zu wenig Platz:'):
        return 'DISK_SPACE_INSUFFICIENT'
    if isinstance(exc, ValueError) and str(exc).startswith('SHA-256 stimmt nicht'):
        return 'CHECKPOINT_HASH_MISMATCH'
    if isinstance(exc, tarfile.TarError):
        return 'ARCHIVE_INVALID'
    if isinstance(exc, (TimeoutError, urllib.error.URLError)):
        return 'DOWNLOAD_CONNECTION_FAILED'
    if isinstance(exc, ImportError):
        return 'DEPENDENCY_MISSING'
    return 'BOOTSTRAP_FAILED'


def child_main(connection):
    import pod_start

    def publish(phase, error=None):
        message = {'phase': phase}
        if error is not None:
            message['errorCode'] = error_code(error)
        connection.send(message)
        if phase == 'starting_runtime':
            if not connection.poll(30) or connection.recv() != 'port-released':
                raise RuntimeError('Bootstrap port handoff failed')
            connection.close()

    pod_start.PROGRESS = publish
    try:
        result = pod_start.main()
    except BaseException as exc:
        publish('failed', exc)
        result = 3
    raise SystemExit(result)


def start_server(state, token):
    if len(token) < 32:
        raise RuntimeError('Bootstrap authentication missing')

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass  # Never log request headers, URLs, or token material.

        def do_GET(self):
            if not hmac.compare_digest(self.headers.get('Authorization', '').encode(), ('Bearer ' + token).encode()):
                status, body = 401, {'error': 'unauthorized'}
            elif self.path == '/models':
                status, body = 200, {'models': []}
            elif self.path in ('/ready', '/health'):
                status = 503 if self.path == '/ready' else 200
                body = {'status': 'failed' if state.get('phase') == 'failed' else 'starting', **state}
            else:
                status, body = 404, {'error': 'not found'}
            raw = json.dumps(body).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

    server = ThreadingHTTPServer(('0.0.0.0', int(os.environ.get('PORT', '8000'))), Handler)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(os.environ['AI_TLS_CERT_FILE'], os.environ['AI_TLS_KEY_FILE'])
    server.socket = context.wrap_socket(server.socket, server_side=True)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, thread


def supervise():
    # Fork before starting any HTTP threads; Vast role images run on Linux.
    parent, child = multiprocessing.Pipe()
    process = multiprocessing.get_context('fork').Process(target=child_main, args=(child,))
    process.start()
    child.close()
    state = {'phase': 'initializing'}
    server = thread = None
    failed_at = None
    connected = True
    previous_term = signal.getsignal(signal.SIGTERM)

    def terminate(signum, frame):
        raise SystemExit(128 + signum)

    signal.signal(signal.SIGTERM, terminate)
    try:
        server, thread = start_server(state, os.environ.get('AI_POD_TOKEN', ''))
        while True:
            if connected and parent.poll(.2):
                try:
                    message = parent.recv()
                except EOFError:
                    message = None
                    connected = False
                if message:
                    state.update(message)
                    if message['phase'] == 'starting_runtime':
                        server.shutdown()
                        server.server_close()
                        thread.join(timeout=2)
                        server = None
                        parent.send('port-released')
                        process.join()
                        return process.exitcode
                    elif message['phase'] == 'failed':
                        failed_at = time.monotonic()
            if not connected:
                time.sleep(.2)
            if not process.is_alive():
                process.join()
                if server is None:
                    return process.exitcode
                if failed_at is None:
                    state.update(phase='failed', errorCode='BOOTSTRAP_PROCESS_EXITED', childExitCode=process.exitcode)
                    failed_at = time.monotonic()
                # Keep only structured failure metadata available for cleanup.
                if time.monotonic() - failed_at >= 300:
                    return process.exitcode or 3
    finally:
        if server:
            server.shutdown()
            server.server_close()
        if process.is_alive():
            process.terminate()
            process.join(timeout=35)
            if process.is_alive():
                process.kill()
                process.join(timeout=5)
        parent.close()
        signal.signal(signal.SIGTERM, previous_term)
