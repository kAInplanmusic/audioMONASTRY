#!/usr/bin/env python3
"""
audioMONASTRY · Vast-Instanzen waehrend `vast-pods.py up` beobachten (nur lesend)
================================================================================
Belegt den Kaltstart statt ihn zu raten: Zeitstempel jedes Statuswechsels (JSONL) und in festen Abstaenden die Container-Logs.
Quellen (docs.vast.ai): `actual_status`/`status_msg` aus GET /api/v0/instances/; Logs ueber PUT /api/v0/instances/request_logs/{id}
(`result_url` zeigt auf eine S3-Datei). Statuswerte laut Doku: loading = Docker-Image wird geladen, exited/unknown/offline erreichen
nie `running`. Aufrufe halten die dokumentierten Mindestabstaende ein (vast-pods.py api(): >= 1,1 s).

Ausgabe: <out>/timeline.jsonl und <out>/logs/<label>-<sekunden>s.log (URLs und lange Tokens entfernt).
Aufruf:  python3 scripts/vast-observe.py --out DIR [--interval 10] [--logs-every 45] [--seconds 3600] [--stop-file DATEI]
"""
import argparse
import importlib.util
import json
from pathlib import Path
import re
import sys
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


def load_pods():
    spec = importlib.util.spec_from_file_location('vast_pods_observe', ROOT / 'scripts/vast-pods.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def sanitize(text):
    """Keine signierten URLs, Token oder Schluessel in gespeicherte Logs."""
    text = re.sub(r'https?://\S+', '[url]', text)
    text = re.sub(r'(?i)(authorization|bearer|token|password|secret|key)(["\s:=]+)[^\s"\']{6,}', r'\1\2[redacted]', text)
    return re.sub(r'[A-Za-z0-9_\-]{40,}', '[token]', text)


def snapshot(instance):
    """Die fuer den Kaltstart aussagekraeftigen Felder einer Instanz (ohne Secrets)."""
    ports = instance.get('ports') or {}
    return {'id': instance.get('id'), 'label': instance.get('label'), 'actual': instance.get('actual_status'),
            'intended': instance.get('intended_status'), 'msg': sanitize(str(instance.get('status_msg') or ''))[:200],
            'port8000': bool(ports.get('8000/tcp')), 'machine': instance.get('machine_id'), 'gpu': instance.get('gpu_name'),
            'inetDown': instance.get('inet_down')}


def changed(previous, current):
    keys = ('actual', 'intended', 'msg', 'port8000')
    return previous is None or any(previous.get(k) != current.get(k) for k in keys)


LAST_LOG_REASON = ''      # warum der letzte fetch_logs() nichts lieferte (nur Diagnose, nie Zugangsdaten)


def fetch_logs(pods, ident, tail=300, attempts=4):
    """Container-Logs anfordern und herunterladen; None, wenn (noch) nichts verfuegbar ist (Grund in LAST_LOG_REASON)."""
    global LAST_LOG_REASON
    answer = pods.api('PUT', '/api/v0/instances/request_logs/%d' % int(ident), {'tail': str(tail)})
    url = answer.get('result_url') if isinstance(answer, dict) else None
    if not url or not url.startswith('https://'):
        LAST_LOG_REASON = 'keine result_url in der Antwort (%s)' % sanitize(json.dumps(answer, default=str))[:120]
        return None
    for _ in range(attempts):
        time.sleep(3)
        try:
            with urllib.request.urlopen(url, timeout=30) as response:      # vorsignierte Vast-S3-URL, kein Vast-Schluessel noetig
                return sanitize(response.read().decode('utf-8', errors='replace'))
        except OSError as exc:
            LAST_LOG_REASON = 'Download fehlgeschlagen: %s %s' % (type(exc).__name__, getattr(exc, 'code', ''))
            continue
    return None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--interval', type=float, default=10.0)
    parser.add_argument('--logs-every', type=float, default=45.0)
    parser.add_argument('--seconds', type=float, default=3600.0)
    parser.add_argument('--stop-file', type=Path)
    args = parser.parse_args()
    pods = load_pods()
    (args.out / 'logs').mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    last_seen, last_logs = {}, {}
    timeline = args.out / 'timeline.jsonl'
    while time.monotonic() - started < args.seconds and not (args.stop_file and args.stop_file.exists()):
        elapsed = time.monotonic() - started
        try:
            live = [i for i in pods.instances() if str(i.get('label') or '').startswith(pods.PREFIX)]
        except Exception as exc:  # noqa: BLE001  (Beobachtung darf `up` nie stoeren)
            print('observe: %s' % type(exc).__name__, file=sys.stderr)
            time.sleep(args.interval)
            continue
        for instance in live:
            now_snapshot = snapshot(instance)
            ident = str(now_snapshot['id'])
            if changed(last_seen.get(ident), now_snapshot):
                row = {'t': round(elapsed, 1), **now_snapshot}
                with timeline.open('a') as handle:
                    handle.write(json.dumps(row) + '\n')
                print('%7.1fs %-34s %-9s %s' % (elapsed, now_snapshot['label'], now_snapshot['actual'], now_snapshot['msg'][:80]), flush=True)
                last_seen[ident] = now_snapshot
            if now_snapshot['actual'] in ('loading', 'running') and elapsed - last_logs.get(ident, -1e9) >= args.logs_every:
                last_logs[ident] = elapsed
                try:
                    text = fetch_logs(pods, ident)
                except Exception as exc:  # noqa: BLE001
                    text = None
                    print('observe logs: %s' % type(exc).__name__, file=sys.stderr)
                if not text:
                    print('%7.1fs   log %-30s keine Logs: %s' % (elapsed, str(now_snapshot['label'])[-30:], LAST_LOG_REASON or 'leer'), flush=True)
                if text:
                    name = '%s-%ds.log' % (re.sub(r'[^A-Za-z0-9_-]', '_', str(now_snapshot['label'])), int(elapsed))
                    (args.out / 'logs' / name).write_text(text[-20000:])
                    lines = [l for l in text.splitlines() if l.strip()]
                    print('%7.1fs   log %-30s %s' % (elapsed, now_snapshot['label'][-30:], (lines[-1] if lines else '')[:140]), flush=True)
        time.sleep(args.interval)
    return 0


if __name__ == '__main__':
    sys.exit(main())
