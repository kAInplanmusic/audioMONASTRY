#!/usr/bin/env python3
"""GPU-Selbsttest des vis-Renderers (laeuft AUF der gemieteten Maschine, nicht im Repo-CI).

Klaert die offenen Fragen aus docs/VIS_RENDERER_PLAN.md mit Messwerten:
  1. Nutzt Chromium die GPU fuer WebGL (nicht SwiftShader)? Welche Startoptionen helfen?
  2. Kodiert h264_nvenc, und wie schnell?
  3. Was kostet jeder der 25 Effekte in 1080p (ms/Frame), mit Bildern UND Clips?
  4. Haelt die ganze Kette (Chromium -> ffmpeg -> H.264) 24/25/30 fps in 1080p/1440p?

Medien: liegt `media.json` neben dem Skript (Liste {id, kind, url} mit zeitlich begrenzten R2-Links), werden diese echten
Medien vom Pod selbst geladen (der Weg im Betrieb); sonst entstehen sie auf der Maschine per ffmpeg (lavfi). VIS_QUICK=1 = kurzer Probelauf mit kleinen Bildgroessen (nur fuer lokale Fehlersuche).
Ergebnisse: $VIS_RESULTS (Standard ./results) als results.json plus Beispielbilder und Mitschnitte.
"""
import base64
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import threading
import time
import traceback

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import visual_renderer as vr  # noqa: E402

QUICK = os.environ.get('VIS_QUICK') == '1'
RESULTS = Path(os.environ.get('VIS_RESULTS', str(HERE / 'results')))
RESULTS.mkdir(parents=True, exist_ok=True)
(RESULTS / 'effects').mkdir(exist_ok=True)
SIZE = {'1080p': '640x360', '1440p': '800x450'} if QUICK else {'1080p': '1080p', '1440p': '1440p'}
report = {'quick': QUICK, 'stages': {}}


def sh(command, timeout=120):
    done = subprocess.run(command, shell=True, capture_output=True, text=True, timeout=timeout)
    return {'rc': done.returncode, 'out': (done.stdout or '').strip()[-2000:], 'err': (done.stderr or '').strip()[-600:]}


def stage(name):
    def wrap(fn):
        started = time.time()
        try:
            report['stages'][name] = {'ok': True, 'result': fn(), 'seconds': round(time.time() - started, 1)}
        except Exception as exc:  # noqa: BLE001 - jede Stufe soll die anderen nicht verhindern
            report['stages'][name] = {'ok': False, 'error': type(exc).__name__ + ': ' + str(exc)[:400],
                                      'trace': traceback.format_exc()[-800:], 'seconds': round(time.time() - started, 1)}
        print('STAGE', name, 'ok' if report['stages'][name]['ok'] else 'FAILED', flush=True)
        (RESULTS / 'results.json').write_text(json.dumps(report, indent=1))
        return fn
    return wrap


@stage('environment')
def environment():
    return {
        'gpu': sh('nvidia-smi --query-gpu=name,driver_version,memory.total,pcie.link.gen.current --format=csv,noheader'),
        'capabilities': os.environ.get('NVIDIA_DRIVER_CAPABILITIES'),
        'nvidia_libs': sh("find / \\( -name 'libEGL_nvidia*' -o -name 'libGLX_nvidia*' -o -name 'libnvidia-encode*' "
                          "-o -name 'nvidia_icd.json' -o -name 'libnvidia-glvkspirv*' \\) -not -path '/proc/*' 2>/dev/null | head -12"),
        'vulkan_icd': sh('ls /usr/share/vulkan/icd.d /etc/vulkan/icd.d 2>&1 | head'),
        'ffmpeg_nvenc': sh('ffmpeg -hide_banner -encoders 2>/dev/null | grep -i nvenc'),
        'ffmpeg_version': sh('ffmpeg -version | head -1'),
        'cpus': os.cpu_count(),
        'memory': sh("free -m | sed -n 2p"),
        'container_id': os.environ.get('CONTAINER_ID'),
    }


@stage('nvenc_probe')
def nvenc_probe():
    started = time.time()
    done = sh('ffmpeg -hide_banner -loglevel error -f lavfi -i testsrc2=s=1920x1080:r=30 -t 4 -c:v h264_nvenc -preset p1 -tune ll -f null -', 90)
    if done['rc'] != 0:
        raise RuntimeError('NVENC nicht nutzbar auf diesem Host: ' + done['err'][:300])
    return {'rc': done['rc'], 'err': done['err'], 'seconds_for_4s_1080p30': round(time.time() - started, 2)}


def data_uri(path, mime):
    return 'data:%s;base64,%s' % (mime, base64.b64encode(Path(path).read_bytes()).decode())


MEDIA = {}
REAL = {}


@stage('make_media')
def make_media():
    directory = RESULTS / 'media'
    directory.mkdir(exist_ok=True)
    w, h = (640, 360) if QUICK else (1920, 1080)
    images = {'mandelbrot': 'mandelbrot=s=%dx%d' % (w, h), 'testsrc2': 'testsrc2=s=%dx%d' % (w, h),
              'rgbtest': 'rgbtestsrc=s=%dx%d' % (w, h), 'smpte': 'smptehdbars=s=%dx%d' % (w, h)}
    clips = {'mandelbrot_clip': 'mandelbrot=s=%dx%d:r=30' % (w // 2 if not QUICK else w, h // 2 if not QUICK else h),
             'life_clip': 'life=s=%dx%d:r=30:ratio=0.1:mold=12:life_color=#00ff88:death_color=#aa0044'
                          % (w // 2 if not QUICK else w, h // 2 if not QUICK else h)}
    made = {}
    for name, source in images.items():
        target = directory / (name + '.jpg')
        done = sh('ffmpeg -v error -f lavfi -i "%s" -frames:v 1 -q:v 3 -y %s' % (source, target))
        if done['rc'] == 0 and target.exists():
            MEDIA[name] = ('image', data_uri(target, 'image/jpeg'))
            made[name] = target.stat().st_size
    for name, source in clips.items():
        target = directory / (name + '.mp4')
        done = sh('ffmpeg -v error -f lavfi -i "%s" -t 5 -c:v libx264 -preset veryfast -crf 30 -pix_fmt yuv420p -y %s' % (source, target), 180)
        if done['rc'] == 0 and target.exists():
            MEDIA[name] = ('clip', data_uri(target, 'video/mp4'))
            made[name] = target.stat().st_size
    listing = HERE / 'media.json'
    if listing.exists() and os.environ.get('VIS_MEDIA', 'real') == 'real':
        for entry in json.loads(listing.read_text()):
            REAL[entry['id']] = (entry['kind'], entry['url'])
        made['real_media_scenes'] = len(REAL)
    return made


def scenes():
    # media.json (neben dem Skript): echte Medien als zeitlich begrenzte https-Links, vom Aufrufer erzeugt.
    source = REAL or MEDIA
    return [{'id': n, 'kind': k, 'src': src, 'durationS': 6, 'label': n} for n, (k, src) in source.items()]


def config(resolution, fps, effects='off', **extra):
    return vr.validate_config({'resolution': SIZE[resolution], 'fps': fps, 'effects': effects, 'scenes': scenes(), **extra},
                              allow_test_sizes=QUICK)


CHOSEN = {'args': ''}


@stage('chromium_variants')
def chromium_variants():
    variants = [('default', ''), ('angle-gl-egl', '--use-angle=gl-egl'),
                ('angle-vulkan', '--use-angle=vulkan --enable-features=Vulkan --disable-vulkan-surface'),
                ('gl-egl', '--use-gl=egl'), ('angle-gl', '--use-angle=gl --use-gl=angle')]
    out = []
    for name, args in variants:
        os.environ['AI_VIS_CHROMIUM_ARGS'] = args
        started = time.time()
        browser = vr.SceneBrowser(config('1080p', 30))
        try:
            browser.start()
            info, jpeg = browser.frame(vr.normalize_features({}), 0)
            renderer = browser.renderer
            out.append({'variant': name, 'args': args, 'renderer': renderer, 'hardware': 'swiftshader' not in renderer.lower(),
                        'start_seconds': round(time.time() - started, 1)})
        except Exception as exc:  # noqa: BLE001
            out.append({'variant': name, 'args': args, 'error': type(exc).__name__ + ': ' + str(exc)[:200]})
        finally:
            browser.close()
    hardware = [v for v in out if v.get('hardware')]
    CHOSEN['args'] = (hardware[0] if hardware else out[0] if out else {}).get('args', '')
    os.environ['AI_VIS_CHROMIUM_ARGS'] = CHOSEN['args']
    return {'variants': out, 'chosen_args': CHOSEN['args'], 'hardware_found': bool(hardware)}


@stage('effect_cost_1080p')
def effect_cost():
    browser = vr.SceneBrowser(config('1080p', 30))
    browser.start()
    try:
        quiet = vr.normalize_features({'bass': 0.2, 'mid': 0.3, 'treble': 0.3, 'rms': 0.3, 'onset': 0.1, 'energy': 0.3})
        loud = vr.normalize_features({'bass': 0.9, 'mid': 0.7, 'treble': 0.6, 'rms': 0.8, 'onset': 0.9, 'energy': 0.8})
        frames = 12 if QUICK else 60

        def measure(mode, label, save=None):
            browser.set_effects(mode)
            for k in range(6):
                browser.frame(loud if k % 2 else quiet, k)
            started = time.perf_counter()
            last = b''
            for k in range(frames):
                _, last = browser.frame(loud if k % 2 else quiet, 100 + k)
            ms = (time.perf_counter() - started) / frames * 1000
            if save:
                (RESULTS / 'effects' / save).write_bytes(last)
            return {'effect': label, 'ms_per_frame': round(ms, 1), 'max_fps': round(1000 / ms, 1), 'jpeg_bytes': len(last)}

        rows = [measure('off', 'baseline (kein Effekt)', '00_baseline.jpg')]
        for number, effect in enumerate(vr.EFFECT_IDS, start=1):
            rows.append(measure([{'id': effect, 'amount': 1.0}], effect, '%02d_%s.jpg' % (number, effect)))
        rows.append(measure('auto', 'auto (Regisseur, max 3)', '99_auto.jpg'))
        return {'renderer': browser.renderer, 'frames_each': frames, 'rows': rows}
    finally:
        browser.close()


def process_snapshot():
    """Wer verbraucht CPU, und leben noch Reste frueherer Laeufe? (Diagnose fuer wechselnd langsame Sessions)"""
    top = sh("ps -eo pid,pcpu,etimes,comm --sort=-pcpu | head -9")['out']
    return {'chrome_procs': sh('pgrep -c -f chrom')['out'], 'ffmpeg_procs': sh('pgrep -c ffmpeg')['out'],
            'loadavg': sh('cat /proc/loadavg')['out'], 'top': top}


def run_session(resolution, fps, encoder, seconds, keep, raw=True):
    os.environ['AI_VIS_RAW'] = '1' if raw else '0'   # '0' = JPEG-Rueckfallpfad zum Vergleich
    before = process_snapshot()                       # vor dem Start: Reste vom Vorlauf?
    during = {}
    threading.Timer(seconds / 2, lambda: during.update(process_snapshot())).start()
    session = vr.VisualSession(config(resolution, fps, 'auto'), encoder=encoder)
    session.start(timeout=240)
    subscriber = session.subscribe()
    target = RESULTS / ('stream_%s_%d_%s.ts' % (resolution, fps, encoder))
    stop = threading.Event()

    def collect():
        with open(target, 'wb') as out:
            while not stop.is_set():
                try:
                    chunk = subscriber.get(timeout=1)
                except Exception:  # noqa: BLE001
                    continue
                if not chunk:
                    return
                out.write(chunk)

    def drive():
        started = time.monotonic()
        while not stop.is_set():
            t = time.monotonic() - started
            phase = (t * 128 / 60) % 1.0                      # 128 BPM
            kick = max(0.0, 1.0 - phase * 4.0)
            session.set_features({'bass': 0.25 + 0.7 * kick, 'mid': 0.35 + 0.2 * abs(((t * 0.7) % 2) - 1),
                                  'treble': 0.3 + 0.3 * abs(((t * 1.9) % 2) - 1), 'rms': 0.4 + 0.4 * kick,
                                  'onset': 1.0 if phase < 0.06 else 0.0, 'energy': 0.4 + 0.4 * kick, 'bpm': 128})
            time.sleep(1 / 60)

    threads = [threading.Thread(target=collect, daemon=True), threading.Thread(target=drive, daemon=True)]
    for thread in threads:
        thread.start()
    time.sleep(seconds)
    status = session.status()
    stop.set()
    session.stop()
    for thread in threads:
        thread.join(timeout=5)
    probe = sh('ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,width,height,r_frame_rate,bit_rate '
               '-show_entries format=duration,size -of json %s' % target, 60)
    try:
        info = json.loads(probe['out'])
    except ValueError:
        info = {'raw': probe}
    if not keep and target.exists():
        target.unlink()
    return {'status': status, 'ffprobe': info, 'kept': keep, 'procs_before': before, 'procs_during': during, 'procs_after': process_snapshot()}


@stage('sessions')
def sessions():
    seconds = 6 if QUICK else 14
    plan = [('1080p', 30, 'h264_nvenc', True, True), ('1080p', 30, 'h264_nvenc', False, True),
            ('1080p', 30, 'h264_nvenc', False, True), ('1080p', 30, 'h264_nvenc', False, True),
            ('1080p', 25, 'h264_nvenc', False, True), ('1080p', 24, 'h264_nvenc', False, True),
            ('1440p', 30, 'h264_nvenc', True, True), ('1440p', 24, 'h264_nvenc', False, True),
            ('1080p', 30, 'libx264', False, True),
            ('1080p', 30, 'h264_nvenc', False, False)]   # letzter Lauf: JPEG-Pfad zum Vergleich
    out = []
    for resolution, fps, encoder, keep, raw in plan:
        name = '%s@%d %s%s' % (resolution, fps, encoder, '' if raw else ' (JPEG-Pfad)')
        try:
            out.append({'run': name, **run_session(resolution, fps, encoder, seconds, keep, raw)})
        except Exception as exc:  # noqa: BLE001
            out.append({'run': name, 'error': type(exc).__name__ + ': ' + str(exc)[:300]})
    return out


@stage('raw_pack_check')
def raw_pack_check():
    """GPU-Packer (yuv420p) gegen CPU-Referenz auf der echten GPU: Hoechstabweichung je Ebene in Stufen (Rundung <= 1)."""
    out = {}
    for resolution in ('1080p', '1440p'):
        browser = vr.SceneBrowser(config(resolution, 30))
        browser.start()
        try:
            page = browser._page  # noqa: SLF001
            out[resolution] = {'raw_supported': browser.raw_supported(), 'checks': [
                page.evaluate('([f, i]) => window.__vis.rawSelfTest(f, i)', [vr.normalize_features({'bass': 0.7, 'onset': 0.5}), i])
                for i in range(3)]}
        finally:
            browser.close()
    return out


def summary():
    lines = ['SUMMARY']
    for name, entry in report['stages'].items():
        lines.append('  %-20s %s' % (name, 'ok' if entry['ok'] else 'FAILED ' + entry.get('error', '')))
    cost = report['stages'].get('effect_cost_1080p', {}).get('result')
    if cost:
        lines.append('  renderer: ' + cost['renderer'])
        for row in cost['rows']:
            lines.append('    %-26s %7.1f ms  (%6.1f fps max)' % (row['effect'], row['ms_per_frame'], row['max_fps']))
    for run in report['stages'].get('sessions', {}).get('result', []):
        status = run.get('status', {})
        lines.append('  %-34s fps %s late %s lastFrameMs %s mode %s software %s %s' % (
            run['run'], status.get('achievedFps'), status.get('lateFrames'), status.get('lastFrameMs'),
            status.get('frameMode'), status.get('softwareRenderer'), (run.get('error') or status.get('error') or '')))
        before = run.get('procs_before') or {}
        during = run.get('procs_during') or {}
        lines.append('      procs before chrome=%s ffmpeg=%s load=%s | during top: %s' % (
            before.get('chrome_procs'), before.get('ffmpeg_procs'), (before.get('loadavg') or '')[:14],
            ' ; '.join(' '.join(l.split()[1:4]) for l in (during.get('top') or '').split('\n')[1:5])))
        if status.get('rawTimingMs') or status.get('encoderFallback') or status.get('ffmpegStderr'):
            lines.append('      timing %s sink %s fallback %s ffmpeg %s' % (status.get('rawTimingMs'), status.get('sinkMs'), status.get('encoderFallback'),
                                                                     (status.get('ffmpegStderr') or '')[:160].replace('\n', ' | ')))
    for resolution, entry in (report['stages'].get('raw_pack_check', {}).get('result') or {}).items():
        lines.append('  raw_pack_check %s supported=%s %s' % (resolution, entry['raw_supported'], entry['checks'][-1]))
    return '\n'.join(lines)


print(summary(), flush=True)
(RESULTS / 'summary.txt').write_text(summary())
