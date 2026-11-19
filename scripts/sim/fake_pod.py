#!/usr/bin/env python3
"""Ersatz-Pod fuer Verkabelungstests ohne GPU/Vast (nur Standardbibliothek).

Verhaelt sich an der Schnittstelle wie ein Vast-Pod (services/audiomonastry-ai-runtime/app.py):
HTTPS mit eigenem Zertifikat, `Authorization: Bearer <AI_POD_TOKEN>`, `/health`, `/ready` (503 bis `--ready-after`),
`/models` (Modelle der Rolle laut model_manifest.json + pod-fleet.json), `/runsync`, `/run`, `/status/{id}`, `/cancel/{id}`.
Jeder Auftrag wird mit Rolle, Task und Modell als JSON-Zeile in `--log` protokolliert (Grundlage der Auswertung).
Antworten sind Platzhalter (`"simulated": true`, kurzes Stille-WAV): geprueft wird die VERDRAHTUNG, nicht die Modellqualitaet.

Aufruf: python3 scripts/sim/fake_pod.py --role brain --port 18001 --cert c.pem --key k.pem --token <TOKEN> --log sim/requests.jsonl
Optionen: --ready-after S (Sekunden bis /ready 200), --fail-task TASK (diesen Task mit Fehler beantworten), --latency S (kuenstliche Dauer).
"""
import argparse
import base64
import io
import json
import pathlib
import ssl
import struct
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = pathlib.Path(__file__).resolve().parents[2]


def role_models(role):
    fleet = json.loads((ROOT / 'deploy/gpu/pod-fleet.json').read_text())
    pods = fleet['pods'] if isinstance(fleet['pods'], list) else list(fleet['pods'].values())
    pods = pods + ([fleet['visPod']] if fleet.get('visPod') else [])
    pod = next((p for p in pods if p['role'] == role), None)
    if pod is None:
        raise SystemExit('unbekannte Rolle: %s' % role)
    manifest = json.loads((ROOT / 'services/audiomonastry-ai-runtime/model_manifest.json').read_text())
    models = {m['id']: m for m in (manifest['models'] if isinstance(manifest, dict) else manifest)}
    return [{'id': mid, 'loaded': True, 'repository': models.get(mid, {}).get('repository'),
             'revision': models.get(mid, {}).get('revision')} for mid in pod.get('models', [])]


def silent_wav(seconds=0.25, rate=48000):
    frames = int(seconds * rate)
    buf = io.BytesIO()
    data = b'\x00\x00' * frames
    buf.write(b'RIFF' + struct.pack('<I', 36 + len(data)) + b'WAVEfmt ' + struct.pack('<IHHIIHH', 16, 1, 1, rate, rate * 2, 2, 16))
    buf.write(b'data' + struct.pack('<I', len(data)) + data)
    return base64.b64encode(buf.getvalue()).decode()


class Pod:
    def __init__(self, args):
        self.args = args
        self.started = time.time()
        self.models = role_models(args.role)
        self.jobs = {}
        self.lock = threading.Lock()
        self.log_lock = threading.Lock()

    def ready(self):
        return time.time() - self.started >= self.args.ready_after

    def log(self, row):
        with self.log_lock, open(self.args.log, 'a', encoding='utf-8') as fh:
            fh.write(json.dumps({'t': round(time.time(), 3), 'role': self.args.role, **row}) + '\n')

    def run(self, job_input):
        inp = job_input if isinstance(job_input, dict) else {}
        task, model = str(inp.get('task', '')), str(inp.get('model', ''))
        self.log({'task': task, 'model': model, 'payloadKeys': sorted((inp.get('input') or {}).keys()) if isinstance(inp.get('input'), dict) else None,
                  'modelOnThisPod': model in {m['id'] for m in self.models} or task == 'warmup'})
        if self.args.latency:
            time.sleep(self.args.latency)
        if task == self.args.fail_task:
            return {'status': 'error', 'code': 'MODEL_UNAVAILABLE', 'message': 'simulated failure', 'model': model}
        if task != 'warmup' and model not in {m['id'] for m in self.models}:
            return {'status': 'error', 'code': 'MODEL_UNAVAILABLE', 'message': 'model not resident on this pod', 'model': model}
        result = {'simulated': True, 'text': 'simulated %s/%s' % (task, model), 'audioBase64': silent_wav(), 'sampleRate': 48000,
                  'format': 'wav', 'segments': [], 'stems': {}, 'labels': [], 'embedding': [0.0] * 8}
        return {'status': 'success', 'task': task, 'model': model, 'result': result, 'durationMs': int(self.args.latency * 1000)}


def handler_factory(pod):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def reply(self, status, body):
            raw = json.dumps(body).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def authorized(self):
            return self.headers.get('Authorization', '') == 'Bearer ' + pod.args.token

        def body(self):
            n = int(self.headers.get('Content-Length') or 0)
            try:
                data = json.loads(self.rfile.read(n) or b'{}')
            except ValueError:
                return None
            return data.get('input') if isinstance(data, dict) else None

        def do_GET(self):
            if self.path == '/health':
                return self.reply(200, {'status': 'ok', 'role': pod.args.role})
            if not self.authorized():
                return self.reply(401, {'error': 'unauthorized'})
            if self.path == '/ready':
                return self.reply(200 if pod.ready() else 503, {'status': 'ready' if pod.ready() else 'starting', 'simulated': True})
            if self.path == '/models':
                return self.reply(200, {'models': pod.models if pod.ready() else [dict(m, loaded=False) for m in pod.models]})
            if self.path.startswith('/status/'):
                with pod.lock:
                    job = pod.jobs.get(self.path.split('/', 2)[2])
                return self.reply(200, job) if job else self.reply(404, {'error': 'job not found'})
            self.reply(404, {'error': 'not found'})

        def do_POST(self):
            if not self.authorized():
                return self.reply(401, {'error': 'unauthorized'})
            if self.path == '/runsync':
                return self.reply(200, {'id': uuid.uuid4().hex, 'status': 'COMPLETED', 'output': pod.run(self.body())})
            if self.path == '/run':
                job_id = uuid.uuid4().hex
                job_input = self.body()
                with pod.lock:
                    pod.jobs[job_id] = {'id': job_id, 'status': 'IN_PROGRESS'}

                def work():
                    out = pod.run(job_input)
                    with pod.lock:
                        if pod.jobs[job_id]['status'] != 'CANCELLED':
                            pod.jobs[job_id] = {'id': job_id, 'status': 'COMPLETED', 'output': out}
                threading.Thread(target=work, daemon=True).start()
                return self.reply(200, {'id': job_id, 'status': 'IN_QUEUE'})
            if self.path.startswith('/cancel/'):
                job_id = self.path.split('/', 2)[2]
                with pod.lock:
                    if job_id not in pod.jobs:
                        return self.reply(404, {'error': 'job not found'})
                    pod.jobs[job_id] = {'id': job_id, 'status': 'CANCELLED', 'cancelled': True}
                return self.reply(200, pod.jobs[job_id])
            self.reply(404, {'error': 'not found'})
    return Handler


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--role', required=True)
    p.add_argument('--port', type=int, required=True)
    p.add_argument('--host', default='127.0.0.1')
    p.add_argument('--cert', required=True)
    p.add_argument('--key', required=True)
    p.add_argument('--token', required=True)
    p.add_argument('--log', default='sim/requests.jsonl')
    p.add_argument('--ready-after', type=float, default=0.0)
    p.add_argument('--fail-task', default='')
    p.add_argument('--latency', type=float, default=0.0)
    args = p.parse_args()
    if len(args.token) < 32:
        raise SystemExit('Token muss mindestens 32 Zeichen haben (wie in der App: podToken())')
    pathlib.Path(args.log).parent.mkdir(parents=True, exist_ok=True)
    pod = Pod(args)
    server = ThreadingHTTPServer((args.host, args.port), handler_factory(pod))
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(args.cert, args.key)
    server.socket = ctx.wrap_socket(server.socket, server_side=True)
    print(json.dumps({'fakePod': args.role, 'url': 'https://%s:%d' % (args.host, args.port), 'models': [m['id'] for m in pod.models]}), flush=True)
    server.serve_forever()


if __name__ == '__main__':
    main()
