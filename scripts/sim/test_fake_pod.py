"""Contract tests for the offline simulator."""
import base64
import io
import json
import tempfile
import threading
import time
import unittest
import wave
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace

from fake_agent import APP_STEMS, NATIVE_STEMS, simulate
from fake_pod import Pod, handler_factory


class PodTest(unittest.TestCase):
    def setUp(self):
        directory = self.enterContext(tempfile.TemporaryDirectory())
        self.pod = Pod(SimpleNamespace(role='studio', token='fixture-token', ready_after=0,
                                       log=Path(directory) / 'jobs.jsonl', latency=0.1, fail_task=''))
        server = ThreadingHTTPServer(('127.0.0.1', 0), handler_factory(self.pod))
        worker = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': 0.02})
        worker.start()
        self.addCleanup(worker.join)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        self.port = server.server_port
        self.job = {'input': {'task': 'stem.separate', 'model': 'bs-roformer-sw-6stem',
                              'input': {'includeModelStems': True}}}

    def request(self, method, path, body=None, authorized=True):
        headers = {'Authorization': 'Bearer fixture-token'} if authorized else {}
        conn = HTTPConnection('127.0.0.1', self.port, timeout=2)
        try:
            conn.request(method, path, None if body is None else json.dumps(body), headers)
            response = conn.getresponse()
            return response.status, json.load(response)
        finally:
            conn.close()

    def test_audio_stems_and_terminal_job(self):
        code, receipt = self.request('POST', '/run', self.job)
        self.assertEqual((code, receipt['status']), (200, 'IN_QUEUE'))
        job_id = receipt['id']
        deadline = time.monotonic() + 2
        while True:
            _, job = self.request('GET', f'/status/{job_id}')
            if job['status'] == 'COMPLETED' or time.monotonic() >= deadline:
                break
            time.sleep(0.01)
        self.assertEqual(job['status'], 'COMPLETED')
        result = job['output']['result']
        self.assertTrue(result['simulated'])
        self.assertEqual(list(result['stems']), list(APP_STEMS))
        self.assertEqual(list(result['modelStemAudio']), list(NATIVE_STEMS))
        samples = set()
        for audio in result['modelStemAudio'].values():
            with wave.open(io.BytesIO(base64.b64decode(audio))) as wav:
                self.assertEqual((wav.getframerate(), wav.getnchannels(), wav.getnframes()), (48000, 2, 12000))
                pcm = wav.readframes(12000)
                self.assertTrue(any(pcm))
                samples.add(pcm)
        self.assertEqual(len(samples), 6)
        self.assertEqual(self.request('POST', f'/cancel/{job_id}')[1]['status'], 'COMPLETED')
        rows = [json.loads(line) for line in self.pod.args.log.read_text().splitlines()]
        self.assertEqual([(row['jobId'], row['endpoint']) for row in rows], [(job_id, '/run')])

    def test_cancellation_remains_terminal_after_worker_finishes(self):
        self.pod.args.latency = 0.3
        _, job = self.request('POST', '/run', self.job)
        job_id = job['id']
        self.assertEqual(self.request('POST', f'/cancel/{job_id}')[1]['status'], 'CANCELLED')
        time.sleep(0.35)
        self.assertEqual(self.request('GET', f'/status/{job_id}')[1]['status'], 'CANCELLED')

    def test_readiness_auth_and_storage_errors(self):
        self.assertEqual(self.request('POST', '/runsync', self.job, authorized=False)[0], 401)
        self.assertFalse(self.pod.args.log.exists())
        self.pod.args.ready_after = 60
        self.assertEqual(self.request('GET', '/ready')[0], 503)
        _, cold_job = self.request('POST', '/runsync', self.job)
        self.assertEqual(cold_job['output']['code'], 'MODEL_UNAVAILABLE')
        self.pod.args.ready_after = 0
        self.job['input']['input']['outputUrls'] = {'vocals': 'https://invalid.example/test.wav'}
        _, upload_job = self.request('POST', '/runsync', self.job)
        self.assertEqual(upload_job['output']['code'], 'INVALID_PAYLOAD')

    def test_analysis_fixtures_return_usable_values_and_keep_simulation_marker(self):
        for task, model, field in (
            ('audio.understand', 'moss-music-8b-instruct', 'text'),
            ('audio.classify', 'clap-music', 'labels'),
            ('audio.analyze', 'beat-this', 'beats'),
            ('audio.analyze', 'songformer', 'sections'),
            ('audio.analyze', 'dsp-analysis', 'chromaMean'),
            ('audio.transcribe', 'basic-pitch', 'midiBase64'),
        ):
            result = simulate(task, model, {})
            self.assertTrue(result['simulated'], model)
            self.assertTrue(result[field], model)
        midi = base64.b64decode(result['midiBase64'])
        self.assertEqual(midi[:4], b'MThd')
        self.assertEqual(int.from_bytes(midi[18:22], 'big'), len(midi[22:]))

    def test_gui_requires_catalog_and_proposes_without_executing(self):
        payload = {'format': 'daw_commands', 'instruction': 'Set the tempo to 128 BPM'}
        result = simulate('gui.execute', 'qwen3-4b', payload)
        self.assertEqual(json.loads(result['text']), {'commands': []})
        payload['allowedPluginCommands'] = {'transport': 'set_tempo(bpm), play, stop'}
        result = simulate('gui.execute', 'qwen3-4b', payload)
        self.assertFalse(result['executed'])
        self.assertTrue(result['requiresPluginLock'])
        self.assertEqual(json.loads(result['text'])['commands'],
                         [{'pluginId': 'transport', 'command': 'set_tempo(128)'}])


if __name__ == '__main__':
    unittest.main()
