#!/usr/bin/env python3
"""
audioMONASTRY · vis-Pod messen (nach `vast-pods.py up`)
=======================================================
Liest URL, Token und CA aus dem Statusverzeichnis von `vast-pods.py` (runtime.env, ca.pem), fragt `/visual/capabilities`, startet
je Konfiguration eine Session, sendet 20 Hz Audio-Features, liest `/visual/status` und beendet die Session wieder.
Ausgabe: eine Tabelle und `vis-pod-measure.json` im Statusverzeichnis. Keine Secrets in der Ausgabe.

Aufruf:  python3 scripts/vis-pod-measure.py [--state-dir /data/vast-fleet] [--seconds 20] [--media media.json]
`--media`: optionale Liste [{id, kind, url}] (https-Links, z. B. frisch signierte R2-Links); ohne sie laeuft die Szene mit dem
generativen Feld (kein Medien-Vergleich zu den frueheren Messungen).
"""
import argparse
import json
import os
from pathlib import Path
import ssl
import sys
import time
import urllib.request

RUNS = [('1080p', 30), ('1080p', 25), ('1080p', 24), ('1440p', 30), ('1440p', 24)]


def read_env(path):
    values = {}
    for line in Path(path).read_text().splitlines():
        if '=' in line and not line.startswith('#'):
            key, value = line.split('=', 1)
            values[key.strip()] = value.strip()
    return values


class Pod:
    def __init__(self, url, token, ca):
        self.url, self.token = url.rstrip('/'), token
        self.context = ssl.create_default_context(cafile=ca)

    def call(self, method, path, body=None, timeout=120):
        data = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request(self.url + path, data=data, method=method, headers={
            'Authorization': 'Bearer ' + self.token, 'Content-Type': 'application/json'})
        with urllib.request.urlopen(request, context=self.context, timeout=timeout) as response:
            raw = response.read()
        return json.loads(raw) if raw else {}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--state-dir', type=Path, default=Path(os.environ.get('VAST_STATE_DIR', '/data/vast-fleet')))
    parser.add_argument('--seconds', type=int, default=20)
    parser.add_argument('--media', type=Path)
    args = parser.parse_args()
    env = read_env(args.state_dir / 'runtime.env')
    pod = Pod(env['VAST_POD_URL_VIS'], env['AI_POD_TOKEN'], str(args.state_dir / 'ca.pem'))
    scenes = []
    if args.media:
        scenes = [{'id': m['id'], 'kind': m['kind'], 'src': m['url'], 'durationS': 6} for m in json.loads(args.media.read_text())]
    report = {'capabilities': pod.call('GET', '/visual/capabilities'), 'runs': []}
    print('capabilities:', json.dumps(report['capabilities']))
    if not report['capabilities'].get('nvenc'):
        print('WARNUNG: dieser vis-Host hat kein nutzbares NVENC (CPU-Encoder wird benutzt)')
    for resolution, fps in RUNS:
        row = {'run': '%s@%d' % (resolution, fps)}
        try:
            pod.call('POST', '/visual/session', {'resolution': resolution, 'fps': fps, 'scenes': scenes, 'effects': 'auto'}, timeout=300)
            end = time.monotonic() + args.seconds
            while time.monotonic() < end:
                t = time.monotonic()
                kick = max(0.0, 1.0 - ((t * 128 / 60) % 1.0) * 4.0)
                pod.call('POST', '/visual/features', {'bass': 0.25 + 0.7 * kick, 'mid': 0.4, 'treble': 0.35, 'rms': 0.4 + 0.4 * kick,
                                                      'onset': 1.0 if kick > 0.95 else 0.0, 'energy': 0.4 + 0.4 * kick, 'bpm': 128})
                time.sleep(0.05)
            status = pod.call('GET', '/visual/status')
            row.update({k: status.get(k) for k in ('achievedFps', 'lateFrames', 'lastFrameMs', 'frameMode', 'driver', 'driverNote', 'encoder',
                                                    'encoderFallback', 'encoderFlags', 'rawTimingMs', 'teardownMs', 'error')})
        except Exception as exc:  # noqa: BLE001
            row['error'] = type(exc).__name__ + ': ' + str(exc)[:200]
        finally:
            try:
                started = time.monotonic()
                pod.call('DELETE', '/visual/session')
                row['stopSeconds'] = round(time.monotonic() - started, 2)
            except Exception:  # noqa: BLE001
                pass
        report['runs'].append(row)
        print('%-10s fps %-6s late %-4s mode %-9s drv %-10s enc %-11s stop %ss %s' % (
            row['run'], row.get('achievedFps'), row.get('lateFrames'), row.get('frameMode'), row.get('driver'), row.get('encoder'),
            row.get('stopSeconds'), row.get('error') or ''))
        time.sleep(2)
    (args.state_dir / 'vis-pod-measure.json').write_text(json.dumps(report, indent=2) + '\n')
    print('geschrieben:', args.state_dir / 'vis-pod-measure.json')
    return 0


if __name__ == '__main__':
    sys.exit(main())
