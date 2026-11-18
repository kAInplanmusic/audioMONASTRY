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
import hashlib
import ipaddress
import json
import mimetypes
import os
import queue
import re
import socket
import struct
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
PHASE_FEATURE_KEYS = ('beatPhase', 'barPhase')      # optional: Position im Schlag/Takt, 0 <= x < 1
QUANTIZE_CHOICES = ('off', 'beat', 'bar')
# Effektliste aus derselben Registry wie die Szene (scripts/build-vis-scene.mjs).
EFFECT_IDS = tuple(e['id'] for e in json.loads((HERE / 'effects.json').read_text())['effects'])
# Phasen-Makros (Aufbau/Trance/Hoehepunkt/Aufloesung) aus src/core/visual/visPhases.ts.
PHASES = {p['id']: p for p in json.loads((HERE / 'phases.json').read_text())['phases']}


def validate_effects(raw: Any) -> Any:
    """'auto', 'off' oder eine feste Liste {id, amount}; Rueckgabe normalisiert."""
    if raw is None or raw == 'auto':
        return 'auto'
    if raw == 'off':
        return 'off'
    if not isinstance(raw, list) or len(raw) > 6:
        raise ConfigError("effects must be 'auto', 'off' or a list of at most 6 entries")
    picks = []
    for entry in raw:
        entry = {'id': entry} if isinstance(entry, str) else entry
        if not isinstance(entry, dict) or entry.get('id') not in EFFECT_IDS:
            raise ConfigError('unknown effect id; allowed: ' + ', '.join(EFFECT_IDS))
        amount = _number(entry.get('amount', 0.7), 0.0, 1.0, 'amount')
        picks.append({'id': entry['id'], 'amount': amount})
    return picks


def _validate_show(show_in: Any) -> Dict[str, Any]:
    if not isinstance(show_in, dict):
        raise ConfigError('show must be an object')
    show = {key: _number(value, *SHOW_KEYS[key], key) for key, value in show_in.items() if key in SHOW_KEYS}
    if 'quantize' in show_in:
        if show_in['quantize'] not in QUANTIZE_CHOICES:
            raise ConfigError('quantize must be one of ' + ', '.join(QUANTIZE_CHOICES))
        show['quantize'] = show_in['quantize']
    return show


def validate_look(raw: Any) -> Dict[str, Any]:
    """Live-Aenderung von Preset und Show-Optionen ({presetId, show:{fadeS,minDwellS,...}})."""
    if not isinstance(raw, dict):
        raise ConfigError('look must be an object')
    out: Dict[str, Any] = {}
    if 'presetId' in raw:
        preset = raw['presetId']
        if preset is not None and (not isinstance(preset, str) or len(preset) > 64):
            raise ConfigError('presetId must be a short string or null')
        out['presetId'] = preset
    show_in = raw.get('show')
    if show_in is not None:
        out['show'] = _validate_show(show_in)
    if not out:
        raise ConfigError('look needs presetId and/or show')
    return out


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
    show = _validate_show(raw.get('show') or {})
    effects = validate_effects(raw.get('effects'))
    layer_roles = raw.get('layerRoles', True)
    if not isinstance(layer_roles, bool):
        raise ConfigError('layerRoles must be true or false')
    max_effects = raw.get('maxEffects', 3)
    if isinstance(max_effects, bool) or not isinstance(max_effects, int) or not 1 <= max_effects <= 4:
        raise ConfigError('maxEffects must be an integer from 1 to 4')
    seed = raw.get('seed')
    if seed is not None and (isinstance(seed, bool) or not isinstance(seed, int)):
        raise ConfigError('seed must be an integer')
    preset = raw.get('presetId')
    if preset is not None and (not isinstance(preset, str) or len(preset) > 64):
        raise ConfigError('presetId must be a short string')
    return {'resolution': resolution, 'width': width, 'height': height, 'fps': int(fps),
            'presetId': preset, 'seed': seed, 'scenes': scenes, 'show': show,
            'effects': effects, 'maxEffects': max_effects, 'layerRoles': layer_roles}


def normalize_features(raw: Dict[str, Any]) -> Dict[str, float]:
    out = {key: min(max(float(raw.get(key, 0) or 0), 0.0), 1.0) for key in FEATURE_KEYS if
           isinstance(raw.get(key, 0), (int, float)) and not isinstance(raw.get(key, 0), bool)}
    bpm = raw.get('bpm', 0)
    out['bpm'] = min(max(float(bpm), 0.0), 300.0) if isinstance(bpm, (int, float)) and not isinstance(bpm, bool) else 0.0
    for key in PHASE_FEATURE_KEYS:                       # nur setzen, wenn geliefert (sonst keine Taktbindung)
        value = raw.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool) and value == value and abs(value) != float('inf'):
            out[key] = float(value) - int(float(value) // 1)         # auf [0, 1) abbilden
    return out


NVENC_LOW_LATENCY = ['-zerolatency', '1', '-delay', '0', '-surfaces', '2', '-rc-lookahead', '0']
_FLAGS_PROBE: Dict[str, bool] = {}


def low_latency_flags(encoder: str) -> List[str]:
    """Zusatz-Flags fuer weniger Encoder-Verzug. Gemessen auf einer RTX 4090 (ffmpeg 6.1, 1080p30, p1/ll/cbr): ohne sie ~104 ms
    je Frame (5 Frames Vorlauf), mit -zerolatency + -delay 0 + -surfaces 2 + -rc-lookahead 0 ~39 ms (3 Frames); -zerolatency
    allein, AQ aus und tune ull brachten nichts. Aeltere ffmpeg-Versionen kennen einzelne Optionen nicht: Probelauf, sonst leer."""
    if encoder != 'h264_nvenc' or os.environ.get('AI_VIS_LOW_LATENCY', '1') == '0':
        return []
    if encoder not in _FLAGS_PROBE:
        try:
            done = subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=1280x720:r=30',
                                   '-frames:v', '2', '-c:v', encoder, *NVENC_LOW_LATENCY, '-f', 'null', '-'],
                                  capture_output=True, timeout=30)
            _FLAGS_PROBE[encoder] = done.returncode == 0
        except (OSError, subprocess.SubprocessError):
            _FLAGS_PROBE[encoder] = False
    return list(NVENC_LOW_LATENCY) if _FLAGS_PROBE[encoder] else []


def ffmpeg_args(cfg: Dict[str, Any], encoder: str, raw: bool = False, extra: Optional[List[str]] = None) -> List[str]:
    """Frames von stdin -> H.264/MPEG-TS auf stdout; kurzes GOP, keine B-Frames.

    raw=False: JPEG-Frames (image2pipe/mjpeg), Rueckfall ohne GPU-Packer.
    raw=True : yuv420p-Rohframes (BT.601 limited) vom GPU-Packer der Szene, ohne JPEG-Kodierung und -Dekodierung.
    """
    if encoder not in ENCODERS:
        raise ConfigError('encoder must be one of ' + ', '.join(ENCODERS))
    fps = cfg['fps']
    kbps = KBPS[cfg['resolution']]
    rate = ['-b:v', '%dk' % kbps, '-maxrate', '%dk' % kbps, '-bufsize', '%dk' % (kbps // 2)]
    if encoder == 'h264_nvenc':
        codec = ['-c:v', 'h264_nvenc', *(extra or []), '-preset', 'p1', '-tune', 'll', '-rc', 'cbr', '-profile:v', 'high']
    else:
        codec = ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-profile:v', 'high']
    # Kein Vorab-Pruefen des Eingangs (Standard: bis 5 s / 5 MB): sonst kommt das erste Byte viel zu spaet.
    source = (['-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-s', '%dx%d' % (cfg['width'], cfg['height']),
               '-framerate', str(fps), '-i', 'pipe:0'] if raw else
              ['-f', 'image2pipe', '-framerate', str(fps), '-c:v', 'mjpeg', '-i', 'pipe:0'])
    return ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-fflags', 'nobuffer', '-probesize', '32',
            '-analyzeduration', '0', *source, *codec, *rate, '-pix_fmt', 'yuv420p', '-g', str(fps), '-bf', '0',
            '-an', '-f', 'mpegts', '-muxdelay', '0', '-flush_packets', '1', 'pipe:1']


_ENCODER_PROBE: Dict[str, Optional[str]] = {}


def probe_encoder(encoder: str) -> Optional[str]:
    """None = der Encoder arbeitet; sonst der Grund. Einmal je Prozess (NVENC kann auf einzelnen Hosts fehlen)."""
    if encoder in _ENCODER_PROBE:
        return _ENCODER_PROBE[encoder]
    reason: Optional[str] = None
    if encoder != 'libx264':
        try:
            done = subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
                                   'color=c=black:s=1280x720:r=30', '-frames:v', '2', '-c:v', encoder, '-f', 'null', '-'],
                                  capture_output=True, timeout=30)
            if done.returncode != 0:
                lines = (done.stderr or b'').decode(errors='replace').strip().splitlines()
                reason = lines[0][:200] if lines else 'exit %d' % done.returncode
        except (OSError, subprocess.SubprocessError) as exc:
            reason = type(exc).__name__ + ': ' + str(exc)[:150]
    _ENCODER_PROBE[encoder] = reason
    return reason


def marked_pids(marker: str) -> List[int]:
    """PIDs aller Prozesse, deren Kommandozeile `marker` enthaelt (Linux /proc; sonst leer)."""
    found: List[int] = []
    try:
        names = os.listdir('/proc')
    except OSError:
        return found
    needle = marker.encode()
    for name in names:
        if not name.isdigit() or int(name) == os.getpid():
            continue
        try:
            with open('/proc/%s/cmdline' % name, 'rb') as handle:
                if needle in handle.read():
                    found.append(int(name))
        except OSError:
            continue
    return found


def _ppid(pid: int) -> int:
    try:
        with open('/proc/%d/stat' % pid, 'rb') as handle:
            data = handle.read().decode(errors='replace')
        return int(data[data.rindex(')') + 2:].split()[1])      # Feld 4 hinter "(comm)": parent pid
    except (OSError, ValueError, IndexError):
        return 0


def child_pids(parent: int) -> List[int]:
    """Direkte Kindprozesse (Linux /proc; sonst leer)."""
    try:
        names = [int(n) for n in os.listdir('/proc') if n.isdigit()]
    except OSError:
        return []
    return [pid for pid in names if pid != parent and _ppid(pid) == parent]


def subtree_pids(root: int) -> List[int]:
    """root und alle Nachkommen. Unabhaengig von Kommandozeilen: Chromium gibt unbekannte Startflags nicht an seine
    Kindprozesse (GPU, Renderer) weiter, eine Markierung per Flag findet sie deshalb nicht."""
    try:
        names = [int(n) for n in os.listdir('/proc') if n.isdigit()]
    except OSError:
        return []
    children: Dict[int, List[int]] = {}
    for pid in names:
        children.setdefault(_ppid(pid), []).append(pid)
    found, stack = [], [root]
    while stack:
        current = stack.pop()
        if current in found:
            continue
        found.append(current)
        stack.extend(children.get(current, []))
    return [pid for pid in found if pid != os.getpid()]


def kill_subtree(root: Optional[int]) -> int:
    """SIGKILL fuer root und alle Nachkommen (Kinder zuerst). Liefert die Zahl der Signale, die zugestellt wurden."""
    import signal
    if not root:
        return 0
    killed = 0
    for pid in reversed(subtree_pids(root)):
        try:
            os.kill(pid, signal.SIGKILL)
            killed += 1
        except OSError:
            pass
    return killed


def reap_marked(marker: str, grace: float = 3.0) -> int:
    """Wartet kurz, bis die markierten Prozesse von selbst enden, beendet den Rest (TERM, dann KILL). Liefert deren Zahl.

    Auf GPU-Hosts blieben Chromium-Prozesse nach browser.close() ueber den naechsten Lauf hinaus am Leben und
    verlangsamten ihn (siehe docs/VIS_GPU_MESSUNG.md); ein Live-Pod darf keine Reste einer frueheren Session mitschleppen.
    """
    import signal
    deadline = time.monotonic() + grace
    while time.monotonic() < deadline and marked_pids(marker):
        time.sleep(0.1)
    left = marked_pids(marker)
    needed = len(left)                      # so viele mussten beendet werden
    for sig in (signal.SIGTERM, signal.SIGKILL):
        for pid in left:
            try:
                os.kill(pid, sig)
            except OSError:
                pass
        if sig == signal.SIGTERM and left:
            time.sleep(1.0)
            left = marked_pids(marker)
    return needed


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


class FrameSink:
    """Loopback-WebSocket-Empfaenger fuer Rohframes der Szene (nur 127.0.0.1, geheimer Pfad, Origin-Pruefung).

    Warum WebSocket statt fetch/POST: Chromium braucht fuer einen 3-MB-Body per fetch ~300 ms (gemessen), per WebSocket ~22 ms.
    Jede binaere Nachricht ist genau ein Frame (`frame_bytes`); sie geht unveraendert in `write` (ffmpeg-stdin) und wird mit
    einem 1-Byte-Ack beantwortet. Blockiert `write`, stoppt auch das Lesen: der Browser staut dann (Gegendruck) statt zu wachsen.
    Nur eine Verbindung gleichzeitig. Reine Standardbibliothek.
    """

    GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

    MAX_TEXT = 65536

    def __init__(self, frame_bytes: int, write: Callable[[bytes], None],
                 on_message: Optional[Callable[[Dict[str, Any]], None]] = None, origin: str = ORIGIN):
        import secrets
        self.origin = origin                # erlaubte Origin der Szene-Seite (Pruefung im Handshake)
        self.frame_bytes = frame_bytes
        self._write = write
        self._on_message = on_message
        self._conn: Optional[socket.socket] = None
        self._send_lock = threading.Lock()
        self.connected = False          # war mindestens einmal verbunden
        self.ended = False              # Verbindung danach wieder weg
        self._path = '/f/' + secrets.token_urlsafe(16)
        self.received = 0
        self.stats: Dict[str, float] = {}      # gleitende Mittel in ms: recvMs (Frame lesen), unmaskMs, writeMs
        self._closed = threading.Event()
        self._busy = threading.Lock()
        self._server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._server.bind(('127.0.0.1', 0))
        self._server.listen(4)
        self._thread = threading.Thread(target=self._accept_loop, name='vis-frame-sink', daemon=True)
        self._thread.start()

    @property
    def url(self) -> str:
        return 'ws://127.0.0.1:%d%s' % (self._server.getsockname()[1], self._path)

    def close(self) -> None:
        self._closed.set()
        try:
            self._server.close()
        except OSError:
            pass

    def _accept_loop(self) -> None:
        while not self._closed.is_set():
            try:
                conn, _ = self._server.accept()
            except OSError:
                return
            threading.Thread(target=self._serve, args=(conn,), name='vis-frame-conn', daemon=True).start()

    def _note(self, key: str, value: float) -> None:
        old = self.stats.get(key)
        self.stats[key] = round(value if old is None else old * 0.9 + value * 0.1, 2)

    @staticmethod
    def _reply(conn: socket.socket, status: str) -> None:
        try:
            conn.sendall(('HTTP/1.1 %s\r\nContent-Length: 0\r\nConnection: close\r\n\r\n' % status).encode())
        except OSError:
            pass

    def _handshake(self, conn: socket.socket) -> bool:
        data = b''
        while b'\r\n\r\n' not in data:
            chunk = conn.recv(4096)
            if not chunk or len(data) > 16384:
                return False
            data += chunk
        lines = data.split(b'\r\n\r\n', 1)[0].decode('latin-1').split('\r\n')
        parts = lines[0].split(' ')
        headers = {}
        for line in lines[1:]:
            name, _, value = line.partition(':')
            headers[name.strip().lower()] = value.strip()
        if len(parts) < 2 or parts[0] != 'GET' or parts[1] != self._path or headers.get('origin') != self.origin:
            self._reply(conn, '403 Forbidden')
            return False
        key = headers.get('sec-websocket-key', '')
        if headers.get('upgrade', '').lower() != 'websocket' or not key:
            self._reply(conn, '400 Bad Request')
            return False
        accept = base64.b64encode(hashlib.sha1((key + self.GUID).encode()).digest()).decode()
        conn.sendall(('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
                      'Sec-WebSocket-Accept: %s\r\n\r\n' % accept).encode())
        return True

    @staticmethod
    def _recv_exact(conn: socket.socket, size: int) -> bytes:
        buffer = bytearray(size)
        view = memoryview(buffer)
        got = 0
        while got < size:
            count = conn.recv_into(view[got:])
            if not count:
                raise EOFError
            got += count
        return bytes(buffer)

    @staticmethod
    def _unmask(payload: bytes, mask: bytes) -> bytes:
        size = len(payload)
        if size == 0:
            return payload
        try:
            import numpy as np
            key = np.frombuffer((mask * (size // 4 + 1))[:size], dtype=np.uint8)
            return (np.frombuffer(payload, dtype=np.uint8) ^ key).tobytes()
        except ImportError:
            wide = (mask * (size // 4 + 1))[:size]
            return (int.from_bytes(payload, 'little') ^ int.from_bytes(wide, 'little')).to_bytes(size, 'little')

    @staticmethod
    def _close_frame(code: int) -> bytes:
        return b'\x88\x02' + struct.pack('>H', code)

    def _send(self, conn: socket.socket, data: bytes) -> None:
        with self._send_lock:        # Acks (Lese-Thread) und Features (Session-Thread) teilen sich den Socket
            conn.sendall(data)

    def send_json(self, payload: Dict[str, Any]) -> bool:
        """Textnachricht (z. B. Features) an die Szene; False, wenn keine Verbindung steht."""
        conn = self._conn
        if conn is None:
            return False
        body = json.dumps(payload, separators=(',', ':')).encode()
        head = bytes([0x81]) + (bytes([len(body)]) if len(body) < 126 else b'\x7e' + struct.pack('>H', len(body)))
        try:
            self._send(conn, head + body)
            return True
        except OSError:
            return False

    def _serve(self, conn: socket.socket) -> None:
        if not self._busy.acquire(blocking=False):
            self._reply(conn, '409 Conflict')
            conn.close()
            return
        try:
            conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            conn.settimeout(30)
            if not self._handshake(conn):
                return
            self._conn = conn
            self.connected = True
            message, kind = bytearray(), 0
            while not self._closed.is_set():
                head = self._recv_exact(conn, 2)
                fin, opcode, masked, length = bool(head[0] & 0x80), head[0] & 0x0F, bool(head[1] & 0x80), head[1] & 0x7F
                if length == 126:
                    length = struct.unpack('>H', self._recv_exact(conn, 2))[0]
                elif length == 127:
                    length = struct.unpack('>Q', self._recv_exact(conn, 8))[0]
                if not masked or length > max(2 * self.frame_bytes, self.MAX_TEXT):
                    self._send(conn, self._close_frame(1002 if not masked else 1009))
                    return
                mask = self._recv_exact(conn, 4)
                t_recv = time.perf_counter()
                raw_payload = self._recv_exact(conn, length)
                t_unmask = time.perf_counter()
                payload = self._unmask(raw_payload, mask)
                self._note('recvMs', (t_unmask - t_recv) * 1000)
                self._note('unmaskMs', (time.perf_counter() - t_unmask) * 1000)
                if opcode == 0x8:
                    self._send(conn, self._close_frame(1000))
                    return
                if opcode == 0x9:
                    self._send(conn, b'\x8a' + bytes([len(payload)]) + payload[:125])
                    continue
                if opcode in (0x1, 0x2):
                    kind = opcode
                elif opcode != 0x0:
                    self._send(conn, self._close_frame(1003))
                    return
                message += payload
                limit = self.MAX_TEXT if kind == 0x1 else self.frame_bytes
                if len(message) > limit:
                    self._send(conn, self._close_frame(1009))
                    return
                if not fin:
                    continue
                data, message = bytes(message), bytearray()
                if kind == 0x1:                                  # Text: Zaehler/Zeiten/Fehler der Szene
                    try:
                        parsed = json.loads(data.decode())
                    except ValueError:
                        parsed = None
                    if isinstance(parsed, dict) and self._on_message is not None:
                        self._on_message(parsed)
                    continue
                if len(data) != self.frame_bytes:
                    self._send(conn, self._close_frame(1009))
                    return
                try:
                    t_write = time.perf_counter()
                    self._write(data)
                    self._note('writeMs', (time.perf_counter() - t_write) * 1000)
                except (OSError, ValueError):
                    self._send(conn, self._close_frame(1011))
                    return
                self.received += 1
                self._send(conn, b'\x82\x01\x01')       # Ack: Frame ist bei ffmpeg angekommen
        except (OSError, EOFError, struct.error):
            pass
        finally:
            self._conn = None
            if self.connected:
                self.ended = True
            self._busy.release()
            try:
                conn.close()
            except OSError:
                pass



# ---------------------------------------------------------------------------------------------------------------------
# Eigener Chromium-Treiber (ohne Playwright)
# ---------------------------------------------------------------------------------------------------------------------
# Warum: Playwright schaltet bei jeder Seite die DevTools-Netzwerkbeobachtung ein; Chromium schickt dann von JEDEM WebSocket-Frame
# der Seite (3 MB bei 1080p) eine Base64-Kopie an den Treiber (~100 MB/s bei 25 fps). Das staute sich auf, bremste die Steuerleitung
# (~100 ms Verzug je Antwort), machte stop() 9-15 s lang und liess Chromium weiterlaufen (docs/VIS_GPU_MESSUNG.md). Dieser Treiber
# nutzt nur Runtime.evaluate und aktiviert keine Domaene, die Nutzdaten kopiert. Playwright bleibt als Rueckfall (AI_VIS_DRIVER=playwright).

class CdpError(RuntimeError):
    pass


class _WsClient:
    """Minimaler WebSocket-Client (RFC 6455) fuer das DevTools-Protokoll: Text-Nachrichten, maskiert gesendet."""

    def __init__(self, host: str, port: int, path: str, timeout: float = 120.0):
        self.sock = socket.create_connection((host, port), timeout=timeout)
        self.sock.settimeout(timeout)
        key = base64.b64encode(os.urandom(16)).decode()
        self.sock.sendall(('GET %s HTTP/1.1\r\nHost: %s:%d\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
                           'Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n' % (path, host, port, key)).encode())
        head = b''
        while b'\r\n\r\n' not in head:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise CdpError('devtools closed the connection during the handshake')
            head += chunk
        if b' 101 ' not in head.split(b'\r\n', 1)[0]:
            raise CdpError('devtools handshake refused: ' + head.split(b'\r\n', 1)[0].decode(errors='replace'))
        self._buffer = head.split(b'\r\n\r\n', 1)[1]

    def _read(self, size: int) -> bytes:
        while len(self._buffer) < size:
            chunk = self.sock.recv(max(65536, size - len(self._buffer)))
            if not chunk:
                raise CdpError('devtools connection closed')
            self._buffer += chunk
        data, self._buffer = self._buffer[:size], self._buffer[size:]
        return data

    def send_text(self, text: str) -> None:
        payload = text.encode()
        size = len(payload)
        head = b'\x81' + (bytes([0x80 | size]) if size < 126 else b'\xfe' + struct.pack('>H', size) if size < 65536
                          else b'\xff' + struct.pack('>Q', size))
        mask = os.urandom(4)
        masked = (int.from_bytes(payload, 'little') ^ int.from_bytes((mask * (size // 4 + 1))[:size], 'little')).to_bytes(size, 'little')
        self.sock.sendall(head + mask + masked)

    def recv_text(self) -> str:
        message = b''
        while True:
            head = self._read(2)
            fin, opcode, length = bool(head[0] & 0x80), head[0] & 0x0F, head[1] & 0x7F
            if length == 126:
                length = struct.unpack('>H', self._read(2))[0]
            elif length == 127:
                length = struct.unpack('>Q', self._read(8))[0]
            payload = self._read(length) if length else b''          # Server-Frames sind nicht maskiert
            if opcode == 0x8:
                raise CdpError('devtools closed the connection')
            if opcode == 0x9:
                self.sock.sendall(b'\x8a\x80' + os.urandom(4))       # Pong ohne Nutzlast
                continue
            if opcode in (0x1, 0x2, 0x0):
                message += payload
                if fin:
                    return message.decode()

    def close(self) -> None:
        try:
            self.sock.close()
        except OSError:
            pass


_NO_ARG = object()
_FUNCTION_LIKE = re.compile(r'^\s*(async\s+)?(function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)')


class CdpPage:
    """Das Wenige, was SceneBrowser von einer Seite braucht: evaluate und warten (Playwright-aehnliche Aufrufe)."""

    def __init__(self, client: _WsClient):
        self._client = client
        self._id = 0

    def call(self, method: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        self._id += 1
        self._client.send_text(json.dumps({'id': self._id, 'method': method, 'params': params or {}}))
        while True:
            message = json.loads(self._client.recv_text())
            if message.get('id') == self._id:
                if 'error' in message:
                    raise CdpError('%s: %s' % (method, message['error'].get('message', 'error')))
                return message.get('result', {})                    # Ereignisse (ohne id) werden uebergangen

    def evaluate(self, script: str, arg: Any = _NO_ARG) -> Any:
        """Wie Playwright: mit Argument ist `script` eine Funktion, sonst ein Ausdruck (oder eine Funktion ohne Argument)."""
        if arg is not _NO_ARG:
            expression = '(%s)(%s)' % (script, json.dumps(arg))
        elif _FUNCTION_LIKE.match(script):
            expression = '(%s)()' % script
        else:
            expression = script
        result = self.call('Runtime.evaluate', {'expression': expression, 'awaitPromise': True, 'returnByValue': True})
        if 'exceptionDetails' in result:
            details = result['exceptionDetails']
            text = (details.get('exception') or {}).get('description') or details.get('text') or 'evaluation failed'
            raise CdpError('page error: ' + str(text)[:400])
        return (result.get('result') or {}).get('value')

    def wait_for_timeout(self, ms: float) -> None:
        time.sleep(ms / 1000.0)         # kein Ereignisstrom, der abgeholt werden muss

    def close(self) -> None:
        self._client.close()


class LocalSite:
    """Loopback-HTTP-Server fuer Szene (scene.html/.js) und Medien (/media/<name>) mit Range-Unterstuetzung.

    Ersetzt die Playwright-Routen: Medien gehen direkt vom Dateisystem an Chromium, nicht durch die Steuerleitung.
    Gleiche Origin fuer Seite und Medien, daher kein CORS noetig.
    """

    def __init__(self, files: Dict[str, Path]):
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
        site = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.1'

            def log_message(self, *args: Any) -> None:  # noqa: D401
                return

            def _answer(self, send_body: bool) -> None:
                path = urlparse(self.path).path
                if path in ('/scene.html', '/scene.js'):
                    file = HERE / path.lstrip('/')
                    data, kind = file.read_bytes(), mimetypes.guess_type(file.name)[0] or 'text/plain'
                elif path.startswith('/media/') and path.rsplit('/', 1)[-1] in site.files:
                    name = path.rsplit('/', 1)[-1]
                    file = site.files[name]
                    data = file.read_bytes()
                    kind = 'video/mp4' if name.endswith('.mp4') else 'image/jpeg'
                    if file.suffix == '.img':
                        kind = _sniff_image(data[:16])
                else:
                    self.send_response(404)
                    self.send_header('Content-Length', '0')
                    self.end_headers()
                    return
                status, body, headers = 200, data, {'Content-Type': kind, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store'}
                match = re.fullmatch(r'bytes=(\d+)-(\d*)', self.headers.get('Range', ''))
                if match and int(match.group(1)) < len(data):
                    start = int(match.group(1))
                    end = min(int(match.group(2)) if match.group(2) else len(data) - 1, len(data) - 1)
                    status, body = 206, data[start:end + 1]
                    headers['Content-Range'] = 'bytes %d-%d/%d' % (start, end, len(data))
                self.send_response(status)
                for key, value in headers.items():
                    self.send_header(key, value)
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                if send_body:
                    try:
                        self.wfile.write(body)
                    except OSError:
                        pass

            def do_GET(self) -> None:  # noqa: N802
                self._answer(True)

            def do_HEAD(self) -> None:  # noqa: N802
                self._answer(False)

        self.files = files
        self._server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self._server.daemon_threads = True
        self._thread = threading.Thread(target=self._server.serve_forever, name='vis-local-site', daemon=True)
        self._thread.start()

    @property
    def origin(self) -> str:
        return 'http://127.0.0.1:%d' % self._server.server_address[1]

    def close(self) -> None:
        try:
            self._server.shutdown()
            self._server.server_close()
        except OSError:
            pass


def find_chromium() -> str:
    """AI_VIS_CHROMIUM_PATH, sonst der Pfad, den Playwright fuer seinen Chromium kennt (nur zum Nachschlagen, es wird nichts gestartet)."""
    path = os.environ.get('AI_VIS_CHROMIUM_PATH')
    if not path:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as pw:
            path = pw.chromium.executable_path
    if not path or not os.path.exists(path):
        raise CdpError('chromium executable not found: %s' % path)
    return path


CDP_BASE_ARGS = ['--headless', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-breakpad',
                 '--disable-dev-shm-usage', '--disable-background-networking', '--disable-component-update',
                 '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
                 '--disable-renderer-backgrounding', '--disable-ipc-flooding-protection', '--hide-scrollbars', '--mute-audio',
                 '--force-color-profile=srgb', '--password-store=basic', '--use-mock-keychain']


class CdpChromium:
    """Startet Chromium in eigener Prozessgruppe und verbindet sich mit dessen DevTools-Seite."""

    def __init__(self, executable: str, args: List[str], width: int, height: int, url: str, user_data_dir: str):
        self.process: Optional[subprocess.Popen] = None
        self.page: Optional[CdpPage] = None
        cmd = [executable, *CDP_BASE_ARGS, *args, '--remote-debugging-port=0', '--user-data-dir=' + user_data_dir,
               '--window-size=%d,%d' % (width, height), 'about:blank']
        self.process = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                                        start_new_session=True)
        port = self._wait_for_port()
        threading.Thread(target=self._drain_stderr, daemon=True).start()
        target = self._page_target(port)
        match = re.match(r'ws://[^/]+(/.*)$', target['webSocketDebuggerUrl'])
        self.page = CdpPage(_WsClient('127.0.0.1', port, match.group(1) if match else '/'))
        self.page.call('Emulation.setDeviceMetricsOverride', {'width': width, 'height': height, 'deviceScaleFactor': 1, 'mobile': False})
        try:
            self.page.call('Emulation.setFocusEmulationEnabled', {'enabled': True})   # Seite gilt als im Vordergrund (Timer, rAF)
        except CdpError:
            pass
        self.page.call('Page.navigate', {'url': url})

    def _wait_for_port(self, timeout: float = 30.0) -> int:
        deadline = time.monotonic() + timeout
        seen = b''
        assert self.process is not None and self.process.stderr is not None
        fd = self.process.stderr.fileno()
        import select
        while time.monotonic() < deadline:
            ready, _, _ = select.select([fd], [], [], 0.2)
            if ready:
                chunk = os.read(fd, 4096)
                if not chunk:
                    break
                seen += chunk
                found = re.search(rb'DevTools listening on ws://[^:]+:(\d+)/', seen)
                if found:
                    return int(found.group(1))
            if self.process.poll() is not None:
                break
        raise CdpError('chromium did not report a devtools port: ' + seen.decode(errors='replace')[-200:])

    def _drain_stderr(self) -> None:
        try:
            assert self.process is not None and self.process.stderr is not None
            while self.process.stderr.read(4096):
                pass
        except (OSError, ValueError):
            pass

    @staticmethod
    def _page_target(port: int) -> Dict[str, Any]:
        import http.client
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            connection = http.client.HTTPConnection('127.0.0.1', port, timeout=5)     # direkt, ohne Proxy-Umgebung
            try:
                connection.request('GET', '/json/list')
                targets = json.loads(connection.getresponse().read())
                pages = [t for t in targets if t.get('type') == 'page' and t.get('webSocketDebuggerUrl')]
                if pages:
                    return pages[0]
                connection.close()
                connection = http.client.HTTPConnection('127.0.0.1', port, timeout=5)
                connection.request('PUT', '/json/new?about:blank')
                created = json.loads(connection.getresponse().read())
                if created.get('webSocketDebuggerUrl'):
                    return created
            except (OSError, ValueError):
                pass
            finally:
                connection.close()
            time.sleep(0.2)
        raise CdpError('no devtools page target')

    def close(self) -> int:
        """Beendet Chromium samt aller Kindprozesse (eigene Prozessgruppe). Liefert die Zahl beendeter Gruppenmitglieder."""
        import signal
        if self.page is not None:
            self.page.close()
        count = 0
        if self.process is not None:
            try:
                group = os.getpgid(self.process.pid)
            except OSError:
                group = None
            members = len(subtree_pids(self.process.pid)) if group else 0
            if group is not None:
                try:
                    os.killpg(group, signal.SIGTERM)
                except OSError:
                    pass
            try:
                self.process.wait(timeout=1.0)
            except subprocess.TimeoutExpired:
                pass
            if group is not None:                       # auch Kinder (GPU-/Renderer-Prozess) lebten nach dem Hauptprozess weiter
                try:
                    os.killpg(group, signal.SIGKILL)
                except OSError:
                    pass
            try:
                self.process.wait(timeout=3.0)
            except subprocess.TimeoutExpired:
                pass
            count = members
        return count


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
        self._loopback_ok = False
        import secrets
        self._marker = 'vis-session-' + secrets.token_hex(6)
        self.reaped = 0
        self._driver_pid: Optional[int] = None
        self.driver = 'unstarted'                 # 'cdp' (eigener Treiber) oder 'playwright' (Rueckfall)
        self.driver_note: Optional[str] = None
        self.origin = ORIGIN                       # Origin der Szene-Seite (Pruefwert fuer den Frame-Empfaenger)
        self._cdp: Optional[CdpChromium] = None
        self._site: Optional[LocalSite] = None

    def start(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix='audiomonastry-vis-')
        directory = Path(self._tmp.name)
        files: Dict[str, Path] = {}
        kept: List[Tuple[Dict[str, Any], str]] = []
        for index, scene in enumerate(self.cfg['scenes']):
            suffix = '.mp4' if scene['kind'] == 'clip' else '.img'
            name = 'm%d%s' % (index, suffix)
            try:
                files[name] = fetch_media(scene['src'], directory, name)
            except (ConfigError, OSError, ValueError):
                continue
            kept.append((scene, name))
        if os.environ.get('AI_VIS_DRIVER', 'cdp') != 'playwright':
            try:
                self._start_cdp(files, kept)
                return
            except Exception as exc:  # noqa: BLE001  (z. B. Chromium nicht startbar: Rueckfall auf Playwright, sichtbar)
                self.driver_note = 'cdp driver failed, using playwright: %s: %s' % (type(exc).__name__, str(exc)[:160])
                self._stop_cdp()
        self._start_playwright(files, kept)

    def _init_config(self, scenes: List[Dict[str, Any]]) -> Dict[str, Any]:
        return {'width': self.cfg['width'], 'height': self.cfg['height'], 'fps': self.cfg['fps'],
                'presetId': self.cfg['presetId'], 'seed': self.cfg['seed'],
                'scenes': scenes, 'show': self.cfg['show'], 'effects': self.cfg['effects'],
                'maxEffects': self.cfg['maxEffects'], 'layerRoles': self.cfg['layerRoles']}

    def _finish_init(self, result: Dict[str, Any], kept: int) -> None:
        self.renderer = result['renderer']
        self.loaded_scenes = result['loadedScenes']
        self.skipped_scenes = result['skippedScenes'] + (len(self.cfg['scenes']) - kept)

    def _start_cdp(self, files: Dict[str, Path], kept: List[Tuple[Dict[str, Any], str]]) -> None:
        assert self._tmp is not None
        self._site = LocalSite(files)
        self.origin = self._site.origin
        profile = Path(self._tmp.name) / 'profile'
        profile.mkdir()
        self._cdp = CdpChromium(find_chromium(), chromium_args() + ['--vis-session=' + self._marker], self.cfg['width'], self.cfg['height'],
                                self.origin + '/scene.html', str(profile))
        self._page = self._cdp.page
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline and self._page.evaluate('typeof window.__vis') != 'object':
            time.sleep(0.1)
        scenes = [{**scene, 'src': '%s/media/%s' % (self.origin, name)} for scene, name in kept]
        result = self._page.evaluate('cfg => window.__vis.init(cfg)', self._init_config(scenes))
        self._loopback_ok = True                  # Seite und Frame-Empfaenger liegen beide auf Loopback: keine Freigabe noetig
        self.driver = 'cdp'
        self._finish_init(result, len(kept))

    def _stop_cdp(self) -> None:
        if self._cdp is not None:
            self.reaped = self._cdp.close()
            self._cdp = None
        if self._site is not None:
            self._site.close()
            self._site = None
        self._page = None
        self.origin = ORIGIN

    def _start_playwright(self, files: Dict[str, Path], kept: List[Tuple[Dict[str, Any], str]]) -> None:
        from playwright.sync_api import sync_playwright
        self.driver = 'playwright'
        scenes = [{**scene, 'src': '%s/media/%s' % (ORIGIN, name)} for scene, name in kept]
        kids_before = set(child_pids(os.getpid()))
        self._pw = sync_playwright().start()
        new_kids = [pid for pid in child_pids(os.getpid()) if pid not in kids_before]
        self._driver_pid = new_kids[0] if new_kids else None      # Node-Treiber; Chromium haengt in seinem Prozessbaum
        launch: Dict[str, Any] = {'headless': True, 'args': chromium_args() + ['--vis-session=' + self._marker]}
        if os.environ.get('AI_VIS_CHROMIUM_PATH'):
            launch['executable_path'] = os.environ['AI_VIS_CHROMIUM_PATH']
        self._browser = self._pw.chromium.launch(**launch)
        context = self._browser.new_context(viewport={'width': self.cfg['width'], 'height': self.cfg['height']})
        try:
            # Die Szene schickt Rohframes an einen Loopback-Port des Renderers; neuere Chromium-Versionen verlangen dafuer
            # die Local-Network-Access-Freigabe (nur fuer die Szene-Origin). Ohne sie bleibt der JPEG-Pfad.
            context.grant_permissions(['local-network-access'], origin=ORIGIN)
            self._loopback_ok = True
        except Exception:  # noqa: BLE001
            self._loopback_ok = False
        self._page = context.new_page()
        self._page.route(ORIGIN + '/**', lambda route: self._serve(route, files))
        self._page.goto(ORIGIN + '/scene.html')
        result = self._page.evaluate('cfg => window.__vis.init(cfg)', self._init_config(scenes))
        self._finish_init(result, len(kept))

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

    def set_effects(self, mode: Any, max_effects: Optional[int] = None) -> None:
        self._page.evaluate('([m, n]) => window.__vis.setEffects(m, n)', [validate_effects(mode), max_effects])

    def set_look(self, look: Dict[str, Any]) -> None:
        self._page.evaluate('look => window.__vis.setLook(look)', validate_look(look))

    def compiled_effects(self) -> List[str]:
        return self._page.evaluate('window.__vis.compiledEffects()')

    def frame(self, features: Dict[str, float], index: int) -> Tuple[Dict[str, Any], bytes]:
        result = self._page.evaluate('([f, i, q]) => window.__vis.frame(f, i, q)', [features, index, self.quality])
        return result['info'], base64.b64decode(result['jpeg'].split(',', 1)[1])

    def raw_supported(self) -> bool:
        if not self._loopback_ok:
            return False
        try:
            return bool(self._page.evaluate('window.__vis.rawSupported()'))
        except Exception:  # noqa: BLE001  (aeltere Szene ohne Rohpfad -> JPEG)
            return False

    def pump(self, ms: int) -> None:
        """Wartet `ms` und verarbeitet dabei Playwright-Ereignisse. Wichtig im Stream-Modus: Chromium schickt der
        Steuerleitung von jedem WebSocket-Frame der Seite eine Base64-Kopie (DevTools-Netzwerkbeobachtung). Wer diese
        Ereignisse nicht laufend abholt, laesst sie im Browser und im Treiber auflaufen; stop() brauchte dann 9-15 s."""
        self._page.wait_for_timeout(ms)

    def start_stream(self, url: str) -> None:
        """Startet den Rohframe-Takt in der Seite (kein Aufruf pro Frame; siehe podScene.startStream)."""
        self._page.evaluate('u => window.__vis.startStream(u)', url)

    def stop_stream(self) -> None:
        self._page.evaluate('window.__vis && window.__vis.stopStream && window.__vis.stopStream()')

    def close(self) -> None:
        if self.driver == 'cdp':
            try:
                if self._page is not None:
                    self._page.evaluate('window.__vis && window.__vis.dispose()')
            except Exception:  # noqa: BLE001 - Aufraeumen darf nie den Hauptfehler ersetzen
                pass
            self._stop_cdp()
            if self._tmp is not None:
                try:
                    self._tmp.cleanup()
                except OSError:
                    pass
            return
        # Sauber schliessen, aber mit Zeitlimit: haengt browser.close() (GPU-Prozess unter Last), beendet der Wachhund den
        # Prozessbaum des Treibers, dann bricht auch der blockierende Aufruf mit einem Fehler ab (wird unten verschluckt).
        driver = self._driver_pid
        watchdog = threading.Timer(4.0, lambda: kill_subtree(driver))
        watchdog.daemon = True
        watchdog.start()
        try:
            for step in (lambda: self._page and self._page.evaluate('window.__vis && window.__vis.dispose()'),
                         lambda: self._browser and self._browser.close(),
                         lambda: self._pw and self._pw.stop(),
                         lambda: self._tmp and self._tmp.cleanup()):
                try:
                    step()
                except Exception:  # noqa: BLE001 - Aufraeumen darf nie den Hauptfehler ersetzen
                    pass
        finally:
            watchdog.cancel()
        # Was vom Prozessbaum noch lebt (z. B. GPU-Prozess), wird beendet; danach markierte Reste (Notnagel).
        self.reaped = kill_subtree(driver) + reap_marked('--vis-session=' + self._marker, grace=0.2)


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
        self.requested_encoder = self.encoder
        self.encoder_fallback: Optional[str] = None
        self.encoder_flags: List[str] = []
        self.phase: Optional[str] = None
        self._ffmpeg_err = b''
        self._stream_error: Optional[str] = None
        self.teardown_ms: Dict[str, int] = {}
        self.raw_timing: Dict[str, float] = {}
        self._factory = browser_factory
        self._features: Dict[str, float] = normalize_features({})
        self._pending_effects: Optional[Tuple[Any, Optional[int]]] = None
        self._pending_look: Optional[Dict[str, Any]] = None
        self.effects: List[str] = []
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
        self.frame_mode = 'mjpeg'
        self._sink: Optional[FrameSink] = None

    def start(self, timeout: float = 120.0) -> None:
        self._thread = threading.Thread(target=self._run, name='vis-session', daemon=True)
        self._thread.start()
        if not self._ready.wait(timeout) or self._error:
            self.stop()
            raise RuntimeError(self._error or 'visual session start timed out')

    def set_features(self, raw: Dict[str, Any]) -> None:
        with self._lock:
            self._features = {**self._features, **normalize_features(raw)}

    def set_effects(self, mode: Any, max_effects: Optional[int] = None) -> None:
        """Effekte live umschalten (wird vor dem naechsten Frame im Render-Thread angewendet)."""
        checked = validate_effects(mode)
        with self._lock:
            self._pending_effects = (checked, max_effects)

    def set_look(self, look: Dict[str, Any]) -> None:
        """Preset und Show-Optionen live umschalten (im Render-Thread vor dem naechsten Frame)."""
        checked = validate_look(look)
        with self._lock:
            self._pending_look = {**(self._pending_look or {}), **checked}

    def set_phase(self, name: Any) -> Dict[str, Any]:
        """Phasen-Makro: Preset, Show-Optionen (inkl. Taktbindung) und Effektzahl gemeinsam umschalten."""
        if not isinstance(name, str) or name not in PHASES:
            raise ConfigError('phase must be one of ' + ', '.join(PHASES))
        phase = PHASES[name]
        self.set_look({'presetId': phase['presetId'], 'show': phase['show']})
        self.set_effects('auto', phase['maxEffects'])
        self.phase = name
        return {'phase': name, 'label': phase['label']}

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
                'encoder': self.encoder, 'phase': self.phase, 'driver': getattr(browser, 'driver', None), 'driverNote': getattr(browser, 'driver_note', None),
                'encoderFallback': self.encoder_fallback, 'encoderFlags': ' '.join(self.encoder_flags) or None, 'frameMode': self.frame_mode,
                'teardownMs': dict(self.teardown_ms), 'rawTimingMs': dict(self.raw_timing), 'sinkMs': dict(self._sink.stats) if self._sink else None, 'ffmpegStderr': self._ffmpeg_err.decode(errors='replace')[-300:] or None,
                'renderer': renderer,
                'softwareRenderer': bool(renderer and 'swiftshader' in str(renderer).lower()),
                'frames': self.frames, 'lateFrames': self.late_frames,
                'achievedFps': round(self.frames / elapsed, 2) if elapsed else 0,
                'lastFrameMs': round(self.last_frame_ms, 1), 'sceneIndex': self.scene_index, 'effects': self.effects,
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

    def _on_stream_message(self, message: Dict[str, Any]) -> None:
        """Zaehler und Zeiten der Szene (alle ~250 ms) bzw. ein Fehler aus ihrer Takt-Schleife."""
        if message.get('type') == 'stats':
            self.frames = int(message.get('frames', self.frames))
            self.late_frames = int(message.get('late', self.late_frames))
            self.last_frame_ms = float(message.get('lastFrameMs', self.last_frame_ms))
            self.scene_index = int(message.get('sceneIndex', self.scene_index))
            self.effects = [str(e) for e in message.get('effects', [])][:8]
            timing = message.get('timing')
            if isinstance(timing, dict):
                self.raw_timing = {str(k): round(float(v), 2) for k, v in timing.items() if isinstance(v, (int, float))}
        elif message.get('type') == 'error':
            self._stream_error = str(message.get('message', 'scene error'))[:200]

    def _loop_stream(self) -> None:
        """Rohmodus: die Szene taktet selbst; hier nur Features senden, Effekt-/Look-Aenderungen weitergeben, Ausfaelle erkennen.

        Die Browser-Steuerleitung (CDP) wird nur fuer seltene Befehle genutzt; ein Aufruf pro Frame war waehrend der
        Frame-Uebertragung ~100 ms verzoegert.
        """
        self._browser.start_stream(self._sink.url)
        last_sent: Optional[Dict[str, float]] = None
        while not self._stop.is_set():
            with self._lock:
                features = dict(self._features)
                pending, self._pending_effects = self._pending_effects, None
                pending_look, self._pending_look = self._pending_look, None
            if pending is not None:
                self._browser.set_effects(*pending)
            if pending_look is not None:
                self._browser.set_look(pending_look)
            if features != last_sent and self._sink.send_json({'type': 'features', **features}):
                last_sent = features
            if self._stream_error:
                raise RuntimeError('scene stream: ' + self._stream_error)
            if self._sink.ended:
                raise RuntimeError('scene stream closed' + (': ' + self._ffmpeg_err.decode(errors='replace')[-160:] if self._ffmpeg_err else ''))
            pump = getattr(self._browser, 'pump', None)
            if pump is not None:
                pump(20)
            else:
                time.sleep(0.02)
        try:
            self._browser.stop_stream()
        except Exception:  # noqa: BLE001  (Browser schon weg)
            pass

    def _drain_stderr(self, process: subprocess.Popen) -> None:
        """ffmpeg-Fehlermeldungen lesen (letzte ~2 KB behalten), damit die Pipe nicht blockiert und Ausfaelle erklaerbar sind."""
        try:
            for line in process.stderr:
                self._ffmpeg_err = (self._ffmpeg_err + line)[-2048:]
        except (OSError, ValueError):
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
            if self.encoder == 'h264_nvenc' and os.environ.get('AI_VIS_ENCODER_PROBE', '1') != '0':
                reason = probe_encoder(self.encoder)
                if reason:      # NVENC fehlt/laeuft auf diesem Host nicht: sichtbar auf libx264 ausweichen, nicht still scheitern
                    self.encoder_fallback = 'h264_nvenc unavailable: ' + reason
                    self.encoder = 'libx264'
            raw = bool(getattr(self._browser, 'raw_supported', lambda: False)()) and os.environ.get('AI_VIS_RAW', '1') != '0'
            self.frame_mode = 'raw-i420' if raw else 'mjpeg'
            self.encoder_flags = low_latency_flags(self.encoder)
            process = subprocess.Popen(ffmpeg_args(self.cfg, self.encoder, raw, self.encoder_flags), stdin=subprocess.PIPE,
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            threading.Thread(target=self._drain_stderr, args=(process,), daemon=True).start()
            if raw:
                stdin_lock = threading.Lock()

                def write_frame(data: bytes, _process: subprocess.Popen = process) -> None:
                    with stdin_lock:
                        _process.stdin.write(data)
                        _process.stdin.flush()

                self._sink = FrameSink(self.cfg['width'] * self.cfg['height'] * 3 // 2, write_frame, self._on_stream_message,
                                       getattr(self._browser, 'origin', ORIGIN))
            threading.Thread(target=self._pump, args=(process,), daemon=True).start()
            self.started_at = time.monotonic()
            self._ready.set()
            if self._sink is not None:
                self._loop_stream()
                return
            interval = 1.0 / self.cfg['fps']
            deadline = time.monotonic()
            index = 0
            while not self._stop.is_set():
                begin = time.monotonic()
                with self._lock:
                    features = dict(self._features)
                    pending, self._pending_effects = self._pending_effects, None
                    pending_look, self._pending_look = self._pending_look, None
                if pending is not None:
                    self._browser.set_effects(*pending)
                if pending_look is not None:
                    self._browser.set_look(pending_look)
                info, jpeg = self._browser.frame(features, index)
                process.stdin.write(jpeg)
                process.stdin.flush()
                self.effects = info.get('effects', [])
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
            torn = time.monotonic()
            if self._sink is not None:
                try:
                    self._sink.close()
                except OSError:
                    pass
            if process is not None:
                try:
                    process.stdin.close()
                except OSError:
                    pass
                try:
                    process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    process.terminate()
                    try:
                        process.wait(timeout=2)
                    except subprocess.TimeoutExpired:
                        process.kill()
            self.teardown_ms['ffmpeg'] = round((time.monotonic() - torn) * 1000)
            torn = time.monotonic()
            if self._browser is not None:
                self._browser.close()
                self.teardown_ms['browser'] = round((time.monotonic() - torn) * 1000)
                self.teardown_ms['reaped'] = getattr(self._browser, 'reaped', 0)
            self._broadcast(b'')
