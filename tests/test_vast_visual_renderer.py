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

    def test_raw_ffmpeg_arguments_read_yuv420p_frames_without_jpeg(self):
        cfg = vr.validate_config({'resolution': '1080p', 'fps': 30})
        args = vr.ffmpeg_args(cfg, 'h264_nvenc', raw=True)
        self.assertNotIn('mjpeg', args)
        self.assertNotIn('image2pipe', args)
        self.assertEqual('rawvideo', args[args.index('-f') + 1])
        self.assertEqual('1920x1080', args[args.index('-s') + 1])
        self.assertEqual('30', args[args.index('-framerate') + 1])
        self.assertIn('mjpeg', vr.ffmpeg_args(cfg, 'h264_nvenc'))   # JPEG path stays the fallback


    def test_encoder_probe_reports_why_nvenc_is_unusable_and_caches_it(self):
        vr._ENCODER_PROBE.clear()
        failed = subprocess.CompletedProcess([], 1, b'', b'[h264_nvenc] OpenEncodeSessionEx failed: unsupported device (2)\nmore')
        with unittest.mock.patch.object(vr.subprocess, 'run', return_value=failed) as run:
            reason = vr.probe_encoder('h264_nvenc')
            self.assertIn('unsupported device', reason)
            self.assertEqual(reason, vr.probe_encoder('h264_nvenc'))
            self.assertEqual(1, run.call_count)                       # cached per process
            self.assertIsNone(vr.probe_encoder('libx264'))            # software encoder is never probed
        with unittest.mock.patch.object(vr.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, b'', b'')):
            vr._ENCODER_PROBE.clear()
            self.assertIsNone(vr.probe_encoder('h264_nvenc'))
        vr._ENCODER_PROBE.clear()

    def test_nvenc_low_latency_flags_are_added_only_after_a_successful_probe(self):
        cfg = vr.validate_config({'resolution': '1080p', 'fps': 30})
        args = vr.ffmpeg_args(cfg, 'h264_nvenc', raw=True, extra=vr.NVENC_LOW_LATENCY)
        at = args.index('h264_nvenc')
        self.assertEqual(vr.NVENC_LOW_LATENCY, args[at + 1:at + 1 + len(vr.NVENC_LOW_LATENCY)])
        self.assertEqual('p1', args[args.index('-preset') + 1])               # restliche Flags unveraendert
        self.assertNotIn('-zerolatency', vr.ffmpeg_args(cfg, 'h264_nvenc', raw=True))
        self.assertNotIn('-delay', vr.ffmpeg_args(cfg, 'libx264', raw=True, extra=vr.NVENC_LOW_LATENCY))     # nur NVENC bekommt sie
        ok = subprocess.CompletedProcess([], 0, b'', b'')
        bad = subprocess.CompletedProcess([], 1, b'', b'Unrecognized option')
        vr._FLAGS_PROBE.clear()
        with unittest.mock.patch.object(vr.subprocess, 'run', return_value=ok) as run:
            self.assertEqual(vr.NVENC_LOW_LATENCY, vr.low_latency_flags('h264_nvenc'))
            vr.low_latency_flags('h264_nvenc')
            self.assertEqual(1, run.call_count)                                # je Prozess nur einmal geprueft
            self.assertEqual([], vr.low_latency_flags('libx264'))
        vr._FLAGS_PROBE.clear()
        with unittest.mock.patch.object(vr.subprocess, 'run', return_value=bad):
            self.assertEqual([], vr.low_latency_flags('h264_nvenc'))           # aelteres ffmpeg: bekannte Flags bleiben
        vr._FLAGS_PROBE.clear()
        with unittest.mock.patch.dict(os.environ, {'AI_VIS_LOW_LATENCY': '0'}):
            self.assertEqual([], vr.low_latency_flags('h264_nvenc'))
        vr._FLAGS_PROBE.clear()

    def test_beat_and_bar_phase_pass_through_wrapped_and_only_when_given(self):
        self.assertNotIn('beatPhase', vr.normalize_features({'bass': 1}))
        out = vr.normalize_features({'beatPhase': 1.25, 'barPhase': -0.25, 'bass': 0.5})
        self.assertAlmostEqual(0.25, out['beatPhase'])
        self.assertAlmostEqual(0.75, out['barPhase'])
        self.assertNotIn('beatPhase', vr.normalize_features({'beatPhase': True}))
        self.assertNotIn('barPhase', vr.normalize_features({'barPhase': float('nan')}))
        self.assertNotIn('barPhase', vr.normalize_features({'barPhase': float('inf')}))

    def test_quantize_is_a_validated_show_option_and_layer_roles_default_on(self):
        self.assertEqual({'show': {'quantize': 'bar', 'fadeS': 2.0}}, vr.validate_look({'show': {'quantize': 'bar', 'fadeS': 2}}))
        self.assertEqual('beat', vr.validate_config({'show': {'quantize': 'beat'}})['show']['quantize'])
        for bad in ('sometimes', 3, None):
            with self.assertRaises(vr.ConfigError):
                vr.validate_look({'show': {'quantize': bad}})
        self.assertTrue(vr.validate_config({})['layerRoles'])
        self.assertFalse(vr.validate_config({'layerRoles': False})['layerRoles'])
        with self.assertRaises(vr.ConfigError):
            vr.validate_config({'layerRoles': 'yes'})

    def test_phase_macros_come_from_the_shared_table_and_validate(self):
        self.assertEqual(['build', 'trance', 'peak', 'release'], list(vr.PHASES))
        for phase in vr.PHASES.values():
            look = vr.validate_look({'presetId': phase['presetId'], 'show': phase['show']})
            self.assertEqual(phase['show']['quantize'], look['show']['quantize'])
            self.assertIn(phase['maxEffects'], (1, 2, 3, 4))

    def test_set_phase_queues_look_and_effects_and_rejects_unknown_names(self):
        session = vr.VisualSession(vr.validate_config({}), encoder='libx264')
        self.assertEqual({'phase': 'peak', 'label': 'Höhepunkt'}, session.set_phase('peak'))
        self.assertEqual('inferno', session._pending_look['presetId'])
        self.assertEqual('beat', session._pending_look['show']['quantize'])
        self.assertEqual(('auto', 4), session._pending_effects)
        self.assertEqual('peak', session.status()['phase'])
        for bad in ('drop', '', None, 7):
            with self.assertRaises(vr.ConfigError):
                session.set_phase(bad)
        self.assertEqual('peak', session.phase)                  # ungueltige Namen aendern nichts

    def test_local_site_serves_scene_and_media_with_ranges_and_refuses_everything_else(self):
        import http.client
        with tempfile.TemporaryDirectory() as directory:
            media = Path(directory) / 'm0.mp4'
            media.write_bytes(bytes(range(100)))
            site = vr.LocalSite({'m0.mp4': media})
            self.addCleanup(site.close)
            host, port = site.origin.replace('http://', '').split(':')

            def request(method, path, headers=None):
                connection = http.client.HTTPConnection(host, int(port), timeout=5)
                connection.request(method, path, headers=headers or {})
                answer = connection.getresponse()
                body = answer.read()
                connection.close()
                return answer.status, dict(answer.getheaders()), body

            status, headers, body = request('GET', '/media/m0.mp4')
            self.assertEqual((200, bytes(range(100)), 'video/mp4'), (status, body, headers['Content-Type']))
            status, headers, body = request('GET', '/media/m0.mp4', {'Range': 'bytes=10-19'})
            self.assertEqual((206, bytes(range(10, 20)), 'bytes 10-19/100'), (status, body, headers['Content-Range']))
            status, headers, body = request('GET', '/media/m0.mp4', {'Range': 'bytes=90-'})
            self.assertEqual((206, bytes(range(90, 100))), (status, body))
            status, headers, body = request('HEAD', '/media/m0.mp4')
            self.assertEqual((200, b'', '100'), (status, body, headers['Content-Length']))
            self.assertEqual(200, request('GET', '/scene.html')[0])
            self.assertIn(b'canvas', request('GET', '/scene.html')[2])
            self.assertEqual(200, request('GET', '/scene.js')[0])
            for path in ('/media/other.mp4', '/media/../scene.js', '/../etc/passwd', '/media/', '/nothing'):
                self.assertEqual(404, request('GET', path)[0], path)

    def test_marked_processes_are_found_and_reaped(self):
        marker = '--vis-session=unit-test-' + os.urandom(4).hex()
        child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)', marker])
        self.addCleanup(child.kill)
        deadline = time.monotonic() + 3
        while child.pid not in vr.marked_pids(marker) and time.monotonic() < deadline:
            time.sleep(0.05)
        self.assertIn(child.pid, vr.marked_pids(marker))
        self.assertEqual([], vr.marked_pids('--vis-session=nobody-' + os.urandom(4).hex()))
        started = time.monotonic()
        count = vr.reap_marked(marker, grace=0.3)
        child.wait(timeout=5)                                  # wurde beendet (sonst Timeout)
        self.assertEqual(1, count)
        self.assertLess(time.monotonic() - started, 4)
        self.assertEqual([], vr.marked_pids(marker))


    def test_subtree_helpers_find_and_kill_grandchildren(self):
        script = ('import subprocess,sys,time;'
                  'c=subprocess.Popen([sys.executable,"-c","import time;time.sleep(60)"]);'
                  'print(c.pid,flush=True);time.sleep(60)')
        parent = subprocess.Popen([sys.executable, '-c', script], stdout=subprocess.PIPE, text=True)
        self.addCleanup(parent.kill)
        grandchild = int(parent.stdout.readline())
        self.addCleanup(lambda: os.path.exists('/proc/%d' % grandchild) and os.kill(grandchild, 9))
        self.assertIn(parent.pid, vr.child_pids(os.getpid()))
        self.assertTrue({parent.pid, grandchild} <= set(vr.subtree_pids(parent.pid)))
        self.assertGreaterEqual(vr.kill_subtree(parent.pid), 2)
        parent.wait(timeout=5)
        deadline = time.monotonic() + 3
        while os.path.exists('/proc/%d' % grandchild) and time.monotonic() < deadline:
            try:
                os.waitpid(grandchild, os.WNOHANG)       # nicht unser Kind; nur Zombie-Pruefung ueber /proc
            except ChildProcessError:
                pass
            time.sleep(0.05)
        state = ''
        try:
            state = open('/proc/%d/stat' % grandchild).read().split(')')[-1].split()[0]
        except OSError:
            pass
        self.assertIn(state, ('', 'Z'))                  # weg oder nur noch Zombie
        self.assertEqual(0, vr.kill_subtree(0))
        self.assertEqual(0, vr.kill_subtree(None))


def ws_connect(sink, path=None, origin=vr.ORIGIN):
    """Minimaler WebSocket-Client (nur Test): liefert (socket, Statuszeile)."""
    import base64 as b64
    import socket as sock
    host, port = sink.url.split('/')[2].split(':')
    conn = sock.create_connection((host, int(port)), timeout=5)
    route = path or '/' + '/'.join(sink.url.split('/')[3:])
    lines = ['GET %s HTTP/1.1' % route, 'Host: %s:%s' % (host, port), 'Upgrade: websocket', 'Connection: Upgrade',
             'Sec-WebSocket-Key: %s' % b64.b64encode(os.urandom(16)).decode(), 'Sec-WebSocket-Version: 13']
    if origin:
        lines.append('Origin: ' + origin)
    conn.sendall(('\r\n'.join(lines) + '\r\n\r\n').encode())
    data = b''
    while b'\r\n\r\n' not in data:
        chunk = conn.recv(4096)
        if not chunk:
            break
        data += chunk
    return conn, data.split(b'\r\n')[0].decode()


def ws_send(conn, payload, opcode=2, fin=True):
    mask = os.urandom(4)
    size = len(payload)
    head = bytes([(0x80 if fin else 0) | opcode])
    head += bytes([0x80 | size]) if size < 126 else (bytes([0x80 | 126]) + struct.pack('>H', size) if size < 65536
                                                     else bytes([0x80 | 127]) + struct.pack('>Q', size))
    masked = bytes(b ^ mask[k % 4] for k, b in enumerate(payload))
    conn.sendall(head + mask + masked)


def ws_recv(conn):
    head = conn.recv(2)
    length = head[1] & 0x7F
    return head[0] & 0x0F, conn.recv(length) if length else b''


class FrameSinkTests(unittest.TestCase):
    def sink(self, size=12, write=None):
        got = []
        sink = vr.FrameSink(size, write or got.append)
        self.addCleanup(sink.close)
        return sink, got

    def test_accepts_exact_frames_and_acks_each_one(self):
        sink, got = self.sink()
        conn, status = ws_connect(sink)
        self.addCleanup(conn.close)
        self.assertIn('101', status)
        ws_send(conn, b'a' * 12)
        self.assertEqual((2, b'\x01'), ws_recv(conn))
        ws_send(conn, bytes(range(12)))
        self.assertEqual((2, b'\x01'), ws_recv(conn))
        self.assertEqual([b'a' * 12, bytes(range(12))], got)
        self.assertEqual(2, sink.received)
        self.assertTrue(sink.url.startswith('ws://127.0.0.1:'))

    def test_large_frames_with_extended_length_arrive_unchanged(self):
        data = os.urandom(70000)
        sink, got = self.sink(size=len(data))
        conn, _ = ws_connect(sink)
        self.addCleanup(conn.close)
        ws_send(conn, data)
        self.assertEqual((2, b'\x01'), ws_recv(conn))
        self.assertEqual([data], got)

    def test_fragmented_message_is_reassembled(self):
        sink, got = self.sink()
        conn, _ = ws_connect(sink)
        self.addCleanup(conn.close)
        ws_send(conn, b'x' * 5, opcode=2, fin=False)
        ws_send(conn, b'y' * 7, opcode=0, fin=True)
        self.assertEqual((2, b'\x01'), ws_recv(conn))
        self.assertEqual([b'x' * 5 + b'y' * 7], got)

    def test_handshake_needs_the_secret_path_and_the_page_origin(self):
        sink, got = self.sink()
        for kwargs in ({'path': '/f/guess'}, {'origin': 'https://evil.example'}, {'origin': None}):
            conn, status = ws_connect(sink, **kwargs)
            conn.close()
            self.assertIn('403', status, kwargs)
        self.assertEqual([], got)

    def test_wrong_frame_size_closes_the_connection(self):
        sink, got = self.sink()
        conn, _ = ws_connect(sink)
        self.addCleanup(conn.close)
        ws_send(conn, b'c' * 11)
        opcode, payload = ws_recv(conn)
        self.assertEqual(8, opcode)
        self.assertEqual(1009, struct.unpack('>H', payload[:2])[0])
        self.assertEqual([], got)

    def test_only_one_connection_at_a_time(self):
        sink, _ = self.sink()
        first, status = ws_connect(sink)
        self.addCleanup(first.close)
        self.assertIn('101', status)
        second, status = ws_connect(sink)
        second.close()
        self.assertIn('409', status)

    def test_write_failure_is_reported_as_close_1011(self):
        def broken(_data):
            raise BrokenPipeError()
        sink, _ = self.sink(size=4, write=broken)
        conn, _ = ws_connect(sink)
        self.addCleanup(conn.close)
        ws_send(conn, b'dddd')
        opcode, payload = ws_recv(conn)
        self.assertEqual((8, 1011), (opcode, struct.unpack('>H', payload[:2])[0]))

    def test_text_messages_go_both_ways_and_do_not_count_as_frames(self):
        messages = []
        got = []
        sink = vr.FrameSink(12, got.append, messages.append)
        self.addCleanup(sink.close)
        conn, _ = ws_connect(sink)
        self.addCleanup(conn.close)
        ws_send(conn, b'{"type":"stats","frames":3}', opcode=1)
        ws_send(conn, b'not json', opcode=1)                       # kaputtes JSON wird ignoriert, Verbindung bleibt
        ws_send(conn, b'f' * 12)
        self.assertEqual((2, b'\x01'), ws_recv(conn))
        self.assertEqual([{'type': 'stats', 'frames': 3}], messages)
        self.assertEqual(1, sink.received)
        self.assertTrue(sink.send_json({'type': 'features', 'bass': 0.5}))
        opcode, payload = ws_recv(conn)
        self.assertEqual((1, {'type': 'features', 'bass': 0.5}), (opcode, json.loads(payload)))

    def test_send_json_without_connection_is_false_and_end_is_noticed(self):
        sink, _ = self.sink()
        self.assertFalse(sink.send_json({'a': 1}))
        self.assertFalse(sink.connected)
        conn, _ = ws_connect(sink)
        deadline = time.monotonic() + 2
        while not sink.connected and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertTrue(sink.connected and not sink.ended)
        conn.close()
        while not sink.ended and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertTrue(sink.ended)

    def test_unmask_matches_plain_xor_with_and_without_numpy(self):
        payload, mask = os.urandom(1001), os.urandom(4)
        expected = bytes(b ^ mask[k % 4] for k, b in enumerate(payload))
        self.assertEqual(expected, vr.FrameSink._unmask(payload, mask))
        with unittest.mock.patch.dict(sys.modules, {'numpy': None}):
            self.assertEqual(expected, vr.FrameSink._unmask(payload, mask))
        self.assertEqual(b'', vr.FrameSink._unmask(b'', mask))


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

    def test_raw_frame_path_shows_the_same_picture_as_the_jpeg_path(self):
        def grab(raw):
            cfg = vr.validate_config({'resolution': '640x360', 'fps': 25, 'seed': 7, 'effects': 'off', 'scenes': [
                {'id': 'a', 'kind': 'image', 'src': png_data_uri((220, 30, 30)), 'durationS': 8}]}, allow_test_sizes=True)
            with unittest.mock.patch.dict(os.environ, {'AI_VIS_RAW': '1' if raw else '0'}):
                session = vr.VisualSession(cfg, encoder='libx264')
                session.start()
            subscriber = session.subscribe()
            data, end = b'', time.monotonic() + 3
            try:
                while time.monotonic() < end:
                    try:
                        chunk = subscriber.get(timeout=1)
                    except Exception:  # noqa: BLE001
                        continue
                    if not chunk:
                        break
                    data += chunk
                mode = session.status()['frameMode']
            finally:
                session.stop()
            picture = subprocess.run(['ffmpeg', '-v', 'error', '-i', 'pipe:0', '-vf', 'select=eq(n\\,15)', '-frames:v', '1',
                                      '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], input=data, capture_output=True,
                                     check=True, timeout=60).stdout
            return mode, picture
        raw_mode, raw_picture = grab(True)
        jpeg_mode, jpeg_picture = grab(False)
        self.assertEqual(('raw-i420', 'mjpeg'), (raw_mode, jpeg_mode))
        self.assertEqual(640 * 360 * 3, len(raw_picture))
        self.assertEqual(len(raw_picture), len(jpeg_picture))
        sample = list(zip(raw_picture[::11], jpeg_picture[::11]))
        self.assertLess(sum(abs(a - b) for a, b in sample) / len(sample), 6)


    def test_browser_close_leaves_no_marked_processes_and_session_reports_teardown(self):
        kids_before = set(vr.child_pids(os.getpid()))
        session = vr.VisualSession(self.cfg(25), encoder='libx264')
        session.start()
        marker = '--vis-session=' + session._browser._marker
        time.sleep(1.5)
        self.assertTrue(vr.marked_pids(marker))               # Chromium laeuft mit der Markierung
        session.stop()
        self.assertEqual([], vr.marked_pids(marker))
        self.assertEqual(kids_before, set(vr.child_pids(os.getpid())))      # Treiber, Chromium und ffmpeg sind weg
        self.assertTrue({'ffmpeg', 'browser', 'reaped'} <= set(session.status()['teardownMs']))

    def test_cdp_driver_evaluates_expressions_and_functions_and_reports_page_errors(self):
        browser = vr.SceneBrowser(self.cfg(25))
        browser.start()
        self.addCleanup(browser.close)
        self.assertEqual('cdp', browser.driver)
        self.assertTrue(browser.origin.startswith('http://127.0.0.1:'))
        page = browser._page
        self.assertEqual(3, page.evaluate('1 + 2'))                              # Ausdruck
        self.assertEqual(42, page.evaluate('x => x * 2', 21))                   # Funktion mit Argument
        self.assertEqual(7, page.evaluate('async () => 7'))                     # Funktion ohne Argument
        self.assertEqual({'a': [1, 2], 's': 'ü'}, page.evaluate('({a: [1, 2], s: "\\u00fc"})'))
        self.assertEqual([1, 'x', None], page.evaluate('a => a', [1, 'x', None]))
        self.assertEqual(2_000_000, len(page.evaluate('"x".repeat(2000000)')))   # grosse Rueckgabe (WebSocket-Frames > 64 KiB)
        with self.assertRaises(vr.CdpError):
            page.evaluate('() => { throw new Error("boom") }')
        with self.assertRaises(vr.CdpError):
            page.evaluate('nothingDefinedHere.x')
        self.assertEqual(3, page.evaluate('1 + 2'))                              # Verbindung bleibt nach Fehlern benutzbar

    def test_cdp_driver_status_and_fast_stop_with_a_running_stream(self):
        session = vr.VisualSession(self.cfg(25), encoder='libx264')
        session.start()
        time.sleep(2.0)
        status = session.status()
        started = time.monotonic()
        session.stop()
        self.assertEqual('cdp', status['driver'])
        self.assertIsNone(status['driverNote'])
        self.assertEqual('raw-i420', status['frameMode'])
        self.assertLess(time.monotonic() - started, 3.0)

    def test_playwright_stays_available_as_fallback_and_says_why(self):
        class Broken:
            def __init__(self, *args, **kwargs):
                raise vr.CdpError('no chromium for you')
        with unittest.mock.patch.object(vr, 'CdpChromium', Broken):
            browser = vr.SceneBrowser(self.cfg(25))
            browser.start()
        self.addCleanup(browser.close)
        self.assertEqual('playwright', browser.driver)
        self.assertIn('cdp driver failed', browser.driver_note)
        self.assertEqual(3, browser._page.evaluate('() => 1 + 2'))
        browser.close()                                  # Playwright erlaubt je Thread nur eine Sync-Instanz gleichzeitig
        with unittest.mock.patch.dict(os.environ, {'AI_VIS_DRIVER': 'playwright'}):
            forced = vr.SceneBrowser(self.cfg(25))
            forced.start()
        self.addCleanup(forced.close)
        self.assertEqual(('playwright', None), (forced.driver, forced.driver_note))

    def test_missing_nvenc_falls_back_to_libx264_and_says_so(self):
        session = vr.VisualSession(self.cfg(25), encoder='h264_nvenc')
        with unittest.mock.patch.object(vr, 'probe_encoder', return_value='OpenEncodeSessionEx failed: unsupported device'):
            session.start()
        try:
            time.sleep(1.5)
            status = session.status()
        finally:
            session.stop()
        self.assertEqual('libx264', status['encoder'])
        self.assertIn('unsupported device', status['encoderFallback'])
        self.assertGreater(status['frames'], 3)
        self.assertIsNone(status['error'])
        self.assertIsInstance(status['rawTimingMs'], dict)
        self.assertEqual({'renderIssueMs', 'fenceMs', 'getMs', 'sendWaitMs', 'ackMs', 'bufferedKB'}, set(status['rawTimingMs']))   # raw path ran


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

    def test_capabilities_tell_whether_this_host_can_use_nvenc(self):
        with unittest.mock.patch.object(vr, 'probe_encoder', return_value=None), \
                unittest.mock.patch.object(vr, 'low_latency_flags', return_value=list(vr.NVENC_LOW_LATENCY)):
            data = self.client.get('/visual/capabilities').json()
        self.assertEqual((True, None, vr.NVENC_LOW_LATENCY), (data['nvenc'], data['nvencReason'], data['lowLatencyFlags']))
        with unittest.mock.patch.object(vr, 'probe_encoder', return_value='OpenEncodeSessionEx failed: unsupported device'), \
                unittest.mock.patch.object(vr, 'low_latency_flags', return_value=[]):
            data = self.client.get('/visual/capabilities').json()
        self.assertEqual((False, []), (data['nvenc'], data['lowLatencyFlags']))
        self.assertIn('unsupported device', data['nvencReason'])
        with unittest.mock.patch.dict(os.environ, {'AI_ROLE': 'brain'}):
            self.assertEqual(404, self.client.get('/visual/capabilities').status_code)

    def test_bad_requests_and_missing_session(self):
        self.assertEqual(400, self.client.post('/visual/session', json={'fps': 60}).status_code)
        self.assertEqual(400, self.client.post('/visual/session', json={'resolution': '8k'}).status_code)
        self.assertEqual(409, self.client.post('/visual/features', json={'bass': 1}).status_code)
        self.assertEqual(409, self.client.get('/visual/stream').status_code)
        self.assertEqual({'running': False}, self.client.get('/visual/status').json())
        self.assertEqual(409, self.client.post('/visual/phase', json={'phase': 'peak'}).status_code)

    def test_session_lifecycle_streams_mpegts(self):
        started = self.client.post('/visual/session', json={'resolution': '1080p', 'fps': 24, 'scenes': [
            {'id': 'a', 'kind': 'image', 'src': png_data_uri((200, 40, 40)), 'durationS': 6}]})
        self.assertEqual(200, started.status_code, started.text)
        self.assertEqual('1920x1080', started.json()['resolution'])
        self.assertEqual(200, self.client.post('/visual/features', json={'bass': 0.9, 'onset': 1}).status_code)
        self.assertEqual(200, self.client.post('/visual/features', json={'bass': 0.9, 'onset': 1, 'beatPhase': 0.1, 'barPhase': 0.4}).status_code)
        phase = self.client.post('/visual/phase', json={'phase': 'trance'})
        self.assertEqual((200, 'Trance'), (phase.status_code, phase.json()['label']))
        self.assertEqual(400, self.client.post('/visual/phase', json={'phase': 'nope'}).status_code)
        self.assertEqual('trance', self.client.get('/visual/status').json()['phase'])
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
