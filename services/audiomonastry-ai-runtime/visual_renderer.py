"""Live-Visual-Renderer der Rolle vis (VisualMONK auf dem Pod).

Aus vorhandenen Bildern/Clips und Effekten wird zur Musik ein Live-Video:
headless Chromium fuehrt dieselbe Szene wie die Overlay-Komponente der App
(`visual/scene.js`, gebuendelt aus src/core/visual/podScene.ts), die Frames
gehen als JPEG in ffmpeg und kommen als H.264/MPEG-TS wieder heraus.

Ziel: 1080p oder 1440p bei 24/25/30 fps. Nicht auf GPU gemessen: der Status
meldet den WebGL-Renderer und die tatsaechliche Bildrate.

Der Pod laedt die Medien selbst (nur https, keine privaten Adressen, Groessen-
grenze) und liefert sie dem Browser unter demselben Ursprung aus. So braucht
der Speicher keine CORS-Header, und WebGL-Texturen bleiben unbefleckt.
"""
from __future__ import annotations

import base64
import ipaddress
import json
import mimetypes
import os
import queue
import re
import socket
import subprocess
import tempfile
import threading
import time
import urllib.request
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple
from urllib.parse import urlparse

HERE = Path(__file__).resolve().parent / 'visual'
ORIGIN = 'https://vis.local'

SIZES: Dict[str, Tuple[int, int]] = {'1080p': (1920, 1080), '1440p': (2560, 1440)}
FPS_CHOICES = (24, 25, 30)
KBPS = {'1080p': 10000, '1440p': 16000}
MAX_SCENES = 200
MAX_MEDIA_BYTES = 1 << 30
ENCODERS = ('h264_nvenc', 'libx264')
SHOW_KEYS = {'minDwellS': (1, 300), 'fadeS': (0, 10), 'onsetThreshold': (0, 1),
             'energyJump': (0, 1), 'maxSceneS': (1, 600), 'repeatWindow': (0, 50)}
FEATURE_KEYS = ('bass', 'mid', 'treble', 'rms', 'onset', 'energy')


class ConfigError(ValueError):
    """Ungueltige Sitzungsvorgabe (wird als HTTP 400 gemeldet)."""


def _number(value: Any, low: float, high: float, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value != value:
        raise ConfigError(name + ' must be a number')
    return min(max(float(value), low), high)


def validate_config(raw: Dict[str, Any], allow_test_sizes: bool = False) -> Dict[str, Any]:
    """Sitzungsvorgabe pruefen und normalisieren (rein, ohne Netzwerk)."""
    if not isinstance(raw, dict):
        raise ConfigError('body must be an object')
    resolution = raw.get('resolution', '1080p')
    if resolution in SIZES:
        width, height = SIZES[resolution]
    elif allow_test_sizes and isinstance(resolution, str) and re.fullmatch(r'\d{2,4}x\d{2,4}', resolution):
        width, height = (int(x) for x in resolution.split('x'))
        resolution = '1080p'
    else:
        raise ConfigError('resolution must be one of ' + ', '.join(SIZES))
    fps = raw.get('fps', 30)
    if fps not in FPS_CHOICES or isinstance(fps, bool):
        raise ConfigError('fps must be one of ' + ', '.join(str(x) for x in FPS_CHOICES))
    scenes_in = raw.get('scenes', [])
    if not isinstance(scenes_in, list) or len(scenes_in) > MAX_SCENES:
        raise ConfigError('scenes must be a list of at most %d entries' % MAX_SCENES)
    scenes: List[Dict[str, Any]] = []
    for index, scene in enumerate(scenes_in):
        if not isinstance(scene, dict):
            raise ConfigError('scene %d must be an object' % index)
        kind = scene.get('kind')
        src = scene.get('src')
        if kind not in ('image', 'clip'):
            raise ConfigError('scene %d: kind must be image or clip' % index)
        if not isinstance(src, str) or not (src.startswith('https://') or src.startswith('data:image/')
                                            or src.startswith('data:video/')):
            raise ConfigError('scene %d: src must be https or a data URI' % index)
        item: Dict[str, Any] = {'id': str(scene.get('id') or 'scene-%d' % index)[:80],
                                'label': str(scene.get('label') or scene.get('id') or 'scene')[:120],
                                'prompt': str(scene.get('prompt') or '')[:300], 'kind': kind, 'src': src,
                                'durationS': _number(scene.get('durationS', 8), 1, 300, 'durationS')}
        for key in ('mood', 'energy'):
            if isinstance(scene.get(key), str):
                item[key] = scene[key][:20]
        scenes.append(item)
    show_in = raw.get('show') or {}
    if not isinstance(show_in, dict):
        raise ConfigError('show must be an object')
    show = {key: _number(value, *SHOW_KEYS[key], key) for key, value in show_in.items() if key in SHOW_KEYS}
    seed = raw.get('seed')
    if seed is not None and (isinstance(seed, bool) or not isinstance(seed, int)):
        raise ConfigError('seed must be an integer')
    preset = raw.get('presetId')
    if preset is not None and (not isinstance(preset, str) or len(preset) > 64):
        raise ConfigError('presetId must be a short string')
    return {'resolution': resolution, 'width': width, 'height': height, 'fps': int(fps),
            'presetId': preset, 'seed': seed, 'scenes': scenes, 'show': show}


def normalize_features(raw: Dict[str, Any]) -> Dict[str, float]:
    out = {key: min(max(float(raw.get(key, 0) or 0), 0.0), 1.0) for key in FEATURE_KEYS if
           isinstance(raw.get(key, 0), (int, float)) and not isinstance(raw.get(key, 0), bool)}
    bpm = raw.get('bpm', 0)
    out['bpm'] = min(max(float(bpm), 0.0), 300.0) if isinstance(bpm, (int, float)) and not isinstance(bpm, bool) else 0.0
    return out


def ffmpeg_args(cfg: Dict[str, Any], encoder: str) -> List[str]:
    """JPEG-Frames von stdin -> H.264/MPEG-TS auf stdout; kurzes GOP, keine B-Frames."""
    if encoder not in ENCODERS:
        raise ConfigError('encoder must be one of ' + ', '.join(ENCODERS))
    fps = cfg['fps']
    kbps = KBPS[cfg['resolution']]
    rate = ['-b:v', '%dk' % kbps, '-maxrate', '%dk' % kbps, '-bufsize', '%dk' % (kbps // 2)]
    if encoder == 'h264_nvenc':
        codec = ['-c:v', 'h264_nvenc', '-preset', 'p1', '-tune', 'll', '-rc', 'cbr', '-profile:v', 'high']
    else:
        codec = ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-profile:v', 'high']
    # Kein Vorab-Pruefen des Eingangs (Standard: bis 5 s / 5 MB): sonst kommt das erste Byte viel zu spaet.
    return ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-fflags', 'nobuffer', '-probesize', '32',
            '-analyzeduration', '0', '-f', 'image2pipe', '-framerate', str(fps),
            '-c:v', 'mjpeg', '-i', 'pipe:0', *codec, *rate, '-pix_fmt', 'yuv420p', '-g', str(fps), '-bf', '0',
            '-an', '-f', 'mpegts', '-muxdelay', '0', '-flush_packets', '1', 'pipe:1']


def chromium_args() -> List[str]:
    """Software-WebGL bleibt als Rueckfall erlaubt; auf der GPU nutzt Chromium sie von selbst."""
    base = ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--ignore-gpu-blocklist',
            '--enable-unsafe-swiftshader']
    return base + os.environ.get('AI_VIS_CHROMIUM_ARGS', '').split()


def _public_host(host: str) -> bool:
    try:
        infos = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
    except OSError:
        return False
    return bool(infos) and all(ipaddress.ip_address(i[4][0]).is_global for i in infos)


def fetch_media(src: str, directory: Path, name: str) -> Path:
    """Medium auf die lokale Platte holen. https only, nur oeffentliche Adressen, Groessendeckel."""
    target = directory / name
    if src.startswith('data:'):
        header, _, payload = src.partition(',')
        if ';base64' not in header:
            raise ConfigError('data URI must be base64')
        data = base64.b64decode(payload, validate=True)
        if len(data) > MAX_MEDIA_BYTES:
            raise ConfigError('media too large')
        target.write_bytes(data)
        return target
    parsed = urlparse(src)
    if parsed.scheme != 'https' or not parsed.hostname or not _public_host(parsed.hostname):
        raise ConfigError('media host not allowed')
    request = urllib.request.Request(src, headers={'User-Agent': 'audiomonastry-vis'})
    written = 0
    with urllib.request.urlopen(request, timeout=30) as response, open(target, 'wb') as out:
        for block in iter(lambda: response.read(1 << 20), b''):
            written += len(block)
            if written > MAX_MEDIA_BYTES:
                raise ConfigError('media too large')
            out.write(block)
    return target


class SceneBrowser:
    """Chromium-Seite mit der gebuendelten Szene; alle Aufrufe aus demselben Thread."""

    def __init__(self, cfg: Dict[str, Any], quality: float = 0.88):
        self.cfg = cfg
        self.quality = quality
        self._pw = None
        self._browser = None
        self._page = None
        self._tmp: Optional[tempfile.TemporaryDirectory] = None
        self.renderer = 'unknown'
        self.loaded_scenes = 0
        self.skipped_scenes = 0

    def start(self) -> None:
        from playwright.sync_api import sync_playwright
        self._tmp = tempfile.TemporaryDirectory(prefix='audiomonastry-vis-')
        directory = Path(self._tmp.name)
        files: Dict[str, Path] = {}
        scenes = []
        for index, scene in enumerate(self.cfg['scenes']):
            suffix = '.mp4' if scene['kind'] == 'clip' else '.img'
            name = 'm%d%s' % (index, suffix)
            try:
                files[name] = fetch_media(scene['src'], directory, name)
            except (ConfigError, OSError, ValueError):
                continue
            scenes.append({**scene, 'src': '%s/media/%s' % (ORIGIN, name)})
        self._pw = sync_playwright().start()
        launch: Dict[str, Any] = {'headless': True, 'args': chromium_args()}
        if os.environ.get('AI_VIS_CHROMIUM_PATH'):
            launch['executable_path'] = os.environ['AI_VIS_CHROMIUM_PATH']
        self._browser = self._pw.chromium.launch(**launch)
        self._page = self._browser.new_page(viewport={'width': self.cfg['width'], 'height': self.cfg['height']})
        self._page.route(ORIGIN + '/**', lambda route: self._serve(route, files))
        self._page.goto(ORIGIN + '/scene.html')
        result = self._page.evaluate('cfg => window.__vis.init(cfg)', {
            'width': self.cfg['width'], 'height': self.cfg['height'], 'fps': self.cfg['fps'],
            'presetId': self.cfg['presetId'], 'seed': self.cfg['seed'],
            'scenes': scenes, 'show': self.cfg['show']})
        self.renderer = result['renderer']
        self.loaded_scenes = result['loadedScenes']
        self.skipped_scenes = result['skippedScenes'] + (len(self.cfg['scenes']) - len(scenes))

    @staticmethod
    def _serve(route, files: Dict[str, Path]) -> None:
        path = urlparse(route.request.url).path
        if path in ('/scene.html', '/scene.js'):
            file = HERE / path.lstrip('/')
            route.fulfill(body=file.read_bytes(), content_type=mimetypes.guess_type(file.name)[0] or 'text/plain')
            return
        name = path.rsplit('/', 1)[-1]
        file = files.get(name) if path.startswith('/media/') else None
        if file is None:
            route.fulfill(status=404, body=b'')
            return
        data = file.read_bytes()
        kind = 'video/mp4' if name.endswith('.mp4') else 'image/jpeg'
        if file.suffix == '.img':
            kind = _sniff_image(data[:16])
        match = re.fullmatch(r'bytes=(\d+)-(\d*)', route.request.headers.get('range', ''))
        if match:
            start = int(match.group(1))
            end = min(int(match.group(2)) if match.group(2) else len(data) - 1, len(data) - 1)
            route.fulfill(status=206, body=data[start:end + 1], headers={
                'Content-Type': kind, 'Accept-Ranges': 'bytes',
                'Content-Range': 'bytes %d-%d/%d' % (start, end, len(data))})
        else:
            route.fulfill(status=200, body=data, headers={'Content-Type': kind, 'Accept-Ranges': 'bytes'})

    def frame(self, features: Dict[str, float], index: int) -> Tuple[Dict[str, Any], bytes]:
        result = self._page.evaluate('([f, i, q]) => window.__vis.frame(f, i, q)', [features, index, self.quality])
        return result['info'], base64.b64decode(result['jpeg'].split(',', 1)[1])

    def close(self) -> None:
        for step in (lambda: self._page and self._page.evaluate('window.__vis && window.__vis.dispose()'),
                     lambda: self._browser and self._browser.close(),
                     lambda: self._pw and self._pw.stop(),
                     lambda: self._tmp and self._tmp.cleanup()):
            try:
                step()
            except Exception:  # noqa: BLE001 - Aufraeumen darf nie den Hauptfehler ersetzen
                pass


def _sniff_image(head: bytes) -> str:
    if head.startswith(b'\x89PNG'):
        return 'image/png'
    if head.startswith(b'\xff\xd8'):
        return 'image/jpeg'
    if head[:4] == b'RIFF' and head[8:12] == b'WEBP':
        return 'image/webp'
    if head[:3] == b'GIF':
        return 'image/gif'
    return 'application/octet-stream'


class VisualSession:
    """Eine laufende Live-Sitzung: Browser + ffmpeg + Verteiler fuer Zuschauer."""

    def __init__(self, cfg: Dict[str, Any], encoder: Optional[str] = None,
                 browser_factory: Callable[[Dict[str, Any]], Any] = SceneBrowser):
        self.cfg = cfg
        self.encoder = encoder or os.environ.get('AI_VIS_ENCODER', 'h264_nvenc')
        self._factory = browser_factory
        self._features: Dict[str, float] = normalize_features({})
        self._lock = threading.Lock()
        self._subscribers: List[queue.Queue] = []
        self._stop = threading.Event()
        self._ready = threading.Event()
        self._error: Optional[str] = None
        self._thread: Optional[threading.Thread] = None
        self._browser: Any = None
        self.frames = 0
        self.late_frames = 0
        self.started_at = 0.0
        self.last_frame_ms = 0.0
        self.scene_index = -1

    def start(self, timeout: float = 120.0) -> None:
        self._thread = threading.Thread(target=self._run, name='vis-session', daemon=True)
        self._thread.start()
        if not self._ready.wait(timeout) or self._error:
            self.stop()
            raise RuntimeError(self._error or 'visual session start timed out')

    def set_features(self, raw: Dict[str, Any]) -> None:
        with self._lock:
            self._features = {**self._features, **normalize_features(raw)}

    def subscribe(self) -> queue.Queue:
        subscriber: queue.Queue = queue.Queue(maxsize=256)
        with self._lock:
            self._subscribers.append(subscriber)
        return subscriber

    def unsubscribe(self, subscriber: queue.Queue) -> None:
        with self._lock:
            if subscriber in self._subscribers:
                self._subscribers.remove(subscriber)

    def status(self) -> Dict[str, Any]:
        elapsed = max(time.monotonic() - self.started_at, 1e-6) if self.started_at else 0
        browser = self._browser
        renderer = getattr(browser, 'renderer', None)
        return {'running': self._ready.is_set() and not self._stop.is_set() and not self._error,
                'resolution': '%dx%d' % (self.cfg['width'], self.cfg['height']), 'fps': self.cfg['fps'],
                'encoder': self.encoder, 'renderer': renderer,
                'softwareRenderer': bool(renderer and 'swiftshader' in str(renderer).lower()),
                'frames': self.frames, 'lateFrames': self.late_frames,
                'achievedFps': round(self.frames / elapsed, 2) if elapsed else 0,
                'lastFrameMs': round(self.last_frame_ms, 1), 'sceneIndex': self.scene_index,
                'loadedScenes': getattr(browser, 'loaded_scenes', 0),
                'skippedScenes': getattr(browser, 'skipped_scenes', 0),
                'viewers': len(self._subscribers), 'error': self._error}

    def stop(self) -> None:
        self._stop.set()
        thread = self._thread
        if thread and thread is not threading.current_thread():
            thread.join(timeout=15)

    def _broadcast(self, chunk: bytes) -> None:
        with self._lock:
            subscribers = list(self._subscribers)
        for subscriber in subscribers:
            try:
                subscriber.put_nowait(chunk)
            except queue.Full:
                try:
                    subscriber.get_nowait()   # Live: der aelteste Block ist wertlos
                    subscriber.put_nowait(chunk)
                except (queue.Empty, queue.Full):
                    pass

    def _pump(self, process: subprocess.Popen) -> None:
        while True:
            chunk = os.read(process.stdout.fileno(), 65536)
            if not chunk:
                break
            self._broadcast(chunk)
        self._broadcast(b'')

    def _run(self) -> None:
        process = None
        try:
            self._browser = self._factory(self.cfg)
            self._browser.start()
            process = subprocess.Popen(ffmpeg_args(self.cfg, self.encoder), stdin=subprocess.PIPE,
                                       stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            threading.Thread(target=self._pump, args=(process,), daemon=True).start()
            self.started_at = time.monotonic()
            self._ready.set()
            interval = 1.0 / self.cfg['fps']
            deadline = time.monotonic()
            index = 0
            while not self._stop.is_set():
                begin = time.monotonic()
                with self._lock:
                    features = dict(self._features)
                info, jpeg = self._browser.frame(features, index)
                process.stdin.write(jpeg)
                process.stdin.flush()
                self.scene_index = info.get('sceneIndex', -1)
                index += 1
                self.frames = index
                done = time.monotonic()
                self.last_frame_ms = (done - begin) * 1000
                deadline += interval
                pause = deadline - done
                if pause > 0:
                    time.sleep(pause)
                else:
                    self.late_frames += 1
                    deadline = done      # nicht aufholen: Live zeigt den naechsten Frame, keinen Stau
        except Exception as exc:  # noqa: BLE001
            self._error = type(exc).__name__ + ': ' + str(exc)[:200]
        finally:
            self._ready.set()
            self._stop.set()
            if process is not None:
                try:
                    process.stdin.close()
                except OSError:
                    pass
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
            if self._browser is not None:
                self._browser.close()
            self._broadcast(b'')
