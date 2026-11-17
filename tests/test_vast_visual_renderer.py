"""vis live visual renderer: config rules, ffmpeg arguments, and a real Chromium + ffmpeg run."""
import base64
import importlib.util
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import tempfile
import time
import unittest
import unittest.mock
import zlib

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'services/audiomonastry-ai-runtime'))
import visual_renderer as vr  # noqa: E402


def png_data_uri(rgb):
    """64x64 PNG with vertical stripes of the given colour, so effects have something to bend."""
    def chunk(kind, data):
        body = kind + data
        return struct.pack('>I', len(data)) + body + struct.pack('>I', zlib.crc32(body) & 0xffffffff)
    row = b'\x00' + b''.join(bytes(rgb) if (x // 8) % 2 == 0 else bytes((255, 255, 255)) for x in range(64))
    raw = (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 64, 64, 8, 2, 0, 0, 0)) +
           chunk(b'IDAT', zlib.compress(row * 64)) + chunk(b'IEND', b''))
    return 'data:image/png;base64,' + base64.b64encode(raw).decode()


class ConfigTests(unittest.TestCase):
    def test_defaults_and_allowed_values(self):
        cfg = vr.validate_config({})
        self.assertEqual((1920, 1080, 30), (cfg['width'], cfg['height'], cfg['fps']))
        cfg = vr.validate_config({'resolution': '1440p', 'fps': 24})
        self.assertEqual((2560, 1440, 24), (cfg['width'], cfg['height'], cfg['fps']))
        self.assertEqual(25, vr.validate_config({'fps': 25})['fps'])

    def test_rejects_unsupported_values(self):
        for bad in ({'resolution': '4k'}, {'resolution': '640x360'}, {'fps': 60}, {'fps': True},
                    {'scenes': [{'kind': 'image', 'src': 'http://example.test/a.png'}]},
                    {'scenes': [{'kind': 'image', 'src': 'file:///etc/passwd'}]},
                    {'scenes': [{'kind': 'movie', 'src': 'https://example.test/a'}]},
                    {'scenes': 'x'}, {'seed': 1.5}, {'show': 1}):
            with self.assertRaises(vr.ConfigError, msg=str(bad)):
                vr.validate_config(bad)

    def test_scene_and_show_values_are_clamped_and_unknown_keys_dropped(self):
        cfg = vr.validate_config({'scenes': [{'kind': 'clip', 'src': 'https://example.test/c.mp4', 'durationS': 9999}],
                                  'show': {'fadeS': 99, 'evil': 1}})
        self.assertEqual(300, cfg['scenes'][0]['durationS'])
        self.assertEqual({'fadeS': 10.0}, cfg['show'])

    def test_effects_config(self):
        self.assertEqual('auto', vr.validate_config({})['effects'])
        self.assertEqual('off', vr.validate_config({'effects': 'off'})['effects'])
        cfg = vr.validate_config({'effects': ['glitch', {'id': 'bloom', 'amount': 5}]})
        self.assertEqual([{'id': 'glitch', 'amount': 0.7}, {'id': 'bloom', 'amount': 1.0}], cfg['effects'])
        for bad in ({'effects': ['nope']}, {'effects': [{'id': 'bloom', 'amount': 'x'}]}, {'effects': 7},
                    {'effects': ['edge'] * 7}, {'maxEffects': 0}, {'maxEffects': 9}, {'maxEffects': True}):
            with self.assertRaises(vr.ConfigError, msg=str(bad)):
                vr.validate_config(bad)

    def test_live_look_validation(self):
        # the pod is the last line of defence (fadeS 0..10, minDwellS 1..300); the agent clamps tighter upstream
        self.assertEqual({'presetId': 'aurora', 'show': {'fadeS': 10.0, 'minDwellS': 1.0}},
                         vr.validate_look({'presetId': 'aurora', 'show': {'fadeS': 99, 'minDwellS': 0, 'evil': 1}}))
        self.assertEqual({'presetId': None}, vr.validate_look({'presetId': None}))
        for bad in ({}, [], {'presetId': 5}, {'presetId': 'x' * 65}, {'show': 3}):
            with self.assertRaises(vr.ConfigError, msg=str(bad)):
                vr.validate_look(bad)

    def test_effect_ids_are_the_25_requested(self):
        self.assertEqual(25, len(vr.EFFECT_IDS))
        self.assertEqual(25, len(set(vr.EFFECT_IDS)))

    def test_features_are_clamped(self):
        out = vr.normalize_features({'bass': 9, 'mid': -1, 'bpm': 999, 'rms': 'x'})
        self.assertEqual(1.0, out['bass'])
        self.assertEqual(0.0, out['mid'])
        self.assertEqual(300.0, out['bpm'])
        self.assertNotIn('rms', out)

    def test_ffmpeg_arguments(self):
        cfg = vr.validate_config({'resolution': '1440p', 'fps': 25})
        args = vr.ffmpeg_args(cfg, 'h264_nvenc')
        self.assertIn('h264_nvenc', args)
        self.assertEqual('25', args[args.index('-g') + 1])          # 1 s GOP
        self.assertEqual('0', args[args.index('-bf') + 1])          # no B-frames: low latency
        self.assertEqual('32', args[args.index('-probesize') + 1])  # no 5 s input probing
        self.assertEqual('16000k', args[args.index('-b:v') + 1])
        self.assertEqual('mpegts', args[args.index('-f', args.index('-an')) + 1])
        self.assertIn('libx264', vr.ffmpeg_args(cfg, 'libx264'))
        with self.assertRaises(vr.ConfigError):
            vr.ffmpeg_args(cfg, 'rm -rf')

    def test_media_fetch_refuses_private_hosts_and_plain_http(self):
        with tempfile.TemporaryDirectory() as directory:
            for url in ('https://127.0.0.1/a.png', 'https://localhost/a.png', 'http://example.test/a.png',
                        'https://169.254.169.254/latest'):
                with self.assertRaises(vr.ConfigError, msg=url):
                    vr.fetch_media(url, Path(directory), 'm0.img')
            path = vr.fetch_media(png_data_uri((1, 2, 3)), Path(directory), 'm1.img')
            self.assertTrue(path.read_bytes().startswith(b'\x89PNG'))


CHROMIUM = os.environ.get('AI_VIS_CHROMIUM_PATH', '')
HAVE_BROWSER = importlib.util.find_spec('playwright') is not None and (not CHROMIUM or Path(CHROMIUM).exists())


@unittest.skipUnless(HAVE_BROWSER and shutil.which('ffmpeg'), 'needs python playwright, chromium and ffmpeg')
class LiveRenderTests(unittest.TestCase):
    def cfg(self, fps=25):
        return vr.validate_config({'resolution': '640x360', 'fps': fps, 'seed': None, 'scenes': [
            {'id': 'a', 'kind': 'image', 'src': png_data_uri((220, 30, 30)), 'durationS': 4},
            {'id': 'b', 'kind': 'image', 'src': png_data_uri((30, 30, 220)), 'durationS': 4},
            {'id': 'broken', 'kind': 'image', 'src': 'data:image/png;base64,AAAA', 'durationS': 4}]},
            allow_test_sizes=True)

    def test_scene_reacts_to_audio_and_skips_broken_media(self):
        browser = vr.SceneBrowser(self.cfg())
        browser.start()
        try:
            self.assertEqual(2, browser.loaded_scenes)
            self.assertEqual(1, browser.skipped_scenes)
            self.assertTrue(browser.renderer)
            quiet = vr.normalize_features({})
            loud = vr.normalize_features({'bass': 1, 'mid': 0.8, 'treble': 0.7, 'rms': 0.9, 'onset': 1, 'energy': 1})
            first, first_jpeg = browser.frame(quiet, 0)
            self.assertEqual(0.0, first['fade'])                 # the show fades in from black
            for index in range(1, 26):                           # past the 0.8 s fade-in
                browser.frame(quiet, index)
            info, still = browser.frame(quiet, 26)
            _, pumping = browser.frame(loud, 27)
            self.assertTrue(still.startswith(b'\xff\xd8') and pumping.startswith(b'\xff\xd8'))
            self.assertEqual((0, 1.0), (info['sceneIndex'], info['fade']))
            self.assertNotEqual(first_jpeg, still)               # the scene became visible
            self.assertFalse(still == pumping, 'loud audio must change the picture')
        finally:
            browser.close()

    def test_show_changes_scene_on_a_beat_after_the_minimum_dwell(self):
        browser = vr.SceneBrowser(self.cfg())
        browser.start()
        try:
            beat = vr.normalize_features({'onset': 1, 'energy': 1, 'bass': 1})
            seen = set()
            for index in range(0, 25 * 9):                       # 9 s of frame time, no real-time wait
                info, _ = browser.frame(beat if index % 25 == 0 else vr.normalize_features({}), index)
                seen.add(info['sceneIndex'])
            self.assertEqual({0, 1}, seen)
        finally:
            browser.close()

    def test_session_streams_valid_h264_at_the_requested_size_and_rate(self):
        session = vr.VisualSession(self.cfg(25), encoder='libx264')
        session.start()
        subscriber = session.subscribe()
        try:
            session.set_features({'bass': 0.9, 'onset': 1})
            data, end = b'', time.monotonic() + 2.5
            while time.monotonic() < end:
                try:
                    chunk = subscriber.get(timeout=1)
                except Exception:  # noqa: BLE001
                    continue
                if not chunk:
                    break
                data += chunk
            status = session.status()
        finally:
            session.stop()
        self.assertTrue(status['running'] or status['frames'] > 0)
        self.assertGreater(status['frames'], 10)
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'out.ts'
            target.write_bytes(data)
            probe = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries',
                                    'stream=codec_name,width,height,r_frame_rate', '-of', 'json', str(target)],
                                   capture_output=True, timeout=30)
            stream = json.loads(probe.stdout)['streams'][0]
        self.assertEqual(('h264', 640, 360), (stream['codec_name'], stream['width'], stream['height']))
        self.assertEqual('25/1', stream['r_frame_rate'])


def decode_rgb(jpeg):
    return subprocess.run(['ffmpeg', '-v', 'error', '-i', 'pipe:0', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
                          input=jpeg, capture_output=True, check=True, timeout=30).stdout


def mean_abs_diff(a, b):
    ra, rb = decode_rgb(a), decode_rgb(b)
    return sum(abs(x - y) for x, y in zip(ra[::7], rb[::7])) / max(1, len(ra[::7]))


@unittest.skipUnless(HAVE_BROWSER and shutil.which('ffmpeg'), 'needs python playwright, chromium and ffmpeg')
class EffectTests(unittest.TestCase):
    """All 25 effects: shader compiles, and the picture measurably differs from the same frames without effects."""

    @classmethod
    def setUpClass(cls):
        photo = subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:d=1',
                                '-frames:v', '1', '-q:v', '3', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1'],
                               capture_output=True, check=True, timeout=30).stdout
        cls.uri = 'data:image/jpeg;base64,' + base64.b64encode(photo).decode()
        cls.cfg = vr.validate_config({'resolution': '640x360', 'fps': 25, 'effects': 'off', 'scenes': [
            {'id': 'p', 'kind': 'image', 'src': cls.uri, 'durationS': 120}]}, allow_test_sizes=True)
        cls.browser = vr.SceneBrowser(cls.cfg)
        cls.browser.start()
        cls.quiet = vr.normalize_features({'bass': 0.15, 'mid': 0.3, 'treble': 0.3, 'rms': 0.3, 'onset': 0.1, 'energy': 0.3})
        cls.loud = vr.normalize_features({'bass': 0.9, 'mid': 0.7, 'treble': 0.6, 'rms': 0.8, 'onset': 0.9, 'energy': 0.8})

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()

    def run_frames(self, mode):
        self.browser.set_effects(mode)
        frames = []
        for index in range(40, 54):
            info, jpeg = self.browser.frame(self.loud if index % 2 else self.quiet, index)
            frames.append((info, jpeg))
        return frames

    def test_all_25_shaders_compile(self):
        self.assertEqual(sorted(vr.EFFECT_IDS), sorted(self.browser.compiled_effects()))

    def test_every_effect_changes_the_picture(self):
        base_a, base_b = self.run_frames('off'), self.run_frames('off')
        noise = max(mean_abs_diff(x[1], y[1]) for x, y in zip(base_a[-8:], base_b[-8:]))
        weak = {}
        for effect in vr.EFFECT_IDS:
            frames = self.run_frames([{'id': effect, 'amount': 1.0}])
            self.assertTrue(all(info['effects'] == [effect] for info, _ in frames), effect)
            strongest = max(mean_abs_diff(f[1], b[1]) for f, b in zip(frames[-8:], base_b[-8:]))
            if strongest <= max(0.5, 3 * noise):
                weak[effect] = round(strongest, 2)
        self.assertEqual({}, weak, 'effects with no measurable change (noise %.2f)' % noise)

    def test_live_look_changes_fade_and_dwell_of_the_running_show(self):
        self.browser.set_effects('off')
        self.browser.set_look({'show': {'fadeS': 0, 'minDwellS': 1}, 'presetId': None})
        info, _ = self.browser.frame(self.quiet, 70)
        self.assertEqual(1.0, info['fade'])              # fadeS 0 = hard cut, no fade-in from black

    def test_auto_director_picks_limited_effects_and_can_be_switched_off(self):
        frames = self.run_frames('auto')
        counts = {len(info['effects']) for info, _ in frames}
        self.assertTrue(counts <= {1, 2, 3} and counts, counts)
        self.browser.set_effects('auto', 1)
        info, _ = self.browser.frame(self.loud, 60)
        self.assertEqual(1, len(info['effects']))
        self.browser.set_effects('off')
        info, _ = self.browser.frame(self.loud, 61)
        self.assertEqual([], info['effects'])


HAVE_API = importlib.util.find_spec('fastapi') is not None and importlib.util.find_spec('httpx') is not None


@unittest.skipUnless(HAVE_BROWSER and HAVE_API and shutil.which('ffmpeg'), 'needs fastapi, httpx, playwright, chromium, ffmpeg')
class EndpointTests(unittest.TestCase):
    """HTTP surface of the vis role on a bare FastAPI app (bearer auth belongs to the real app)."""

    @classmethod
    def setUpClass(cls):
        import types
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        cls.stub = FastAPI()
        sys.modules['app'] = types.SimpleNamespace(app=cls.stub)
        sys.modules.setdefault('render_probe', types.SimpleNamespace(run=lambda: {}))
        sys.modules.pop('vast_app', None)
        cls.vast_app = importlib.import_module('vast_app')
        cls.client = TestClient(cls.stub)

    def setUp(self):
        self.env = unittest.mock.patch.dict(os.environ, {'AI_ROLE': 'vis', 'AI_VIS_ENCODER': 'libx264'})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.addCleanup(lambda: self.client.delete('/visual/session'))

    def test_other_roles_do_not_expose_the_renderer(self):
        with unittest.mock.patch.dict(os.environ, {'AI_ROLE': 'brain'}):
            for method, path in (('post', '/visual/session'), ('post', '/visual/features'), ('get', '/visual/status'),
                                 ('get', '/visual/stream'), ('delete', '/visual/session')):
                self.assertEqual(404, getattr(self.client, method)(path, **({'json': {}} if method == 'post' else {})).status_code)

    def test_bad_requests_and_missing_session(self):
        self.assertEqual(400, self.client.post('/visual/session', json={'fps': 60}).status_code)
        self.assertEqual(400, self.client.post('/visual/session', json={'resolution': '8k'}).status_code)
        self.assertEqual(409, self.client.post('/visual/features', json={'bass': 1}).status_code)
        self.assertEqual(409, self.client.get('/visual/stream').status_code)
        self.assertEqual({'running': False}, self.client.get('/visual/status').json())

    def test_session_lifecycle_streams_mpegts(self):
        started = self.client.post('/visual/session', json={'resolution': '1080p', 'fps': 24, 'scenes': [
            {'id': 'a', 'kind': 'image', 'src': png_data_uri((200, 40, 40)), 'durationS': 6}]})
        self.assertEqual(200, started.status_code, started.text)
        self.assertEqual('1920x1080', started.json()['resolution'])
        self.assertEqual(200, self.client.post('/visual/features', json={'bass': 0.9, 'onset': 1}).status_code)
        with self.client.stream('GET', '/visual/stream') as response:
            self.assertEqual('video/mp2t', response.headers['content-type'])
            first = next(response.iter_bytes())
        self.assertEqual(0x47, first[0])                         # MPEG-TS sync byte
        status = self.client.get('/visual/status').json()
        self.assertTrue(status['running'])
        self.assertEqual(1, status['loadedScenes'])
        self.assertEqual(400, self.client.post('/visual/effects', json={'effects': ['nope']}).status_code)
        self.assertEqual(200, self.client.post('/visual/effects', json={'effects': [{'id': 'kaleido', 'amount': 1}]}).status_code)
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline and self.client.get('/visual/status').json().get('effects') != ['kaleido']:
            time.sleep(0.5)
        self.assertEqual(['kaleido'], self.client.get('/visual/status').json()['effects'])
        self.assertEqual({'running': False}, self.client.delete('/visual/session').json())
        self.assertEqual({'running': False}, self.client.get('/visual/status').json())


if __name__ == '__main__':
    unittest.main()
