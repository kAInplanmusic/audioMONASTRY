#!/usr/bin/env python3
"""Wertet das Auftragsprotokoll der Ersatz-Pods (requests.jsonl) gegen die Soll-Verdrahtung aus.

Soll: MODEL_POD in src/core/ai/orchestrator/podRouting.ts (Modell -> Pod-Rolle) und die Flotte (pod-fleet.json).
Ausgabe: JSON (--json) und Markdown-Bericht (--md). Exit 0 = keine Fehlleitung; 1 = Fehlleitungen oder Fehlerantworten.
Aufruf: python3 scripts/sim/evaluate_wiring.py sim/requests.jsonl --app-calls sim/app-calls.jsonl --md sim/wiring-report.md --json sim/wiring-report.json [--expect-models all|a,b]
--app-calls wertet zusaetzlich die App-Seite aus (scripts/sim/app-call-check.ts): fehlgeschlagene Auftraege und Vorlade-Modelle,
die auf keinem Pod liegen.
"""
import argparse
import collections
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
# Modelle, die bewusst auf mehreren Pods liegen (podRoleFor: voiceGen -> voice, sonst music)
SHARED = {'acestep-v15-shared': 'voice|music'}


def model_pod():
    ts = (ROOT / 'src/core/ai/orchestrator/podRouting.ts').read_text()
    block = ts[ts.index('const MODEL_POD'):ts.index('};', ts.index('const MODEL_POD'))]
    return {k: v for k, v in re.findall(r"['\"]?([\w.\-]+)['\"]?\s*:\s*'([\w-]+)'", block)}


def fleet_models():
    fleet = json.loads((ROOT / 'deploy/gpu/pod-fleet.json').read_text())
    out = set()
    for pod in fleet.get('pods', []) + ([fleet['visPod']] if fleet.get('visPod') else []):
        for key in ('models', 'preloadModels', 'residentModels'):
            out.update(m if isinstance(m, str) else m.get('id', '') for m in pod.get(key, []) or [])
    return out


def main():
    p = argparse.ArgumentParser()
    p.add_argument('log')
    p.add_argument('--md')
    p.add_argument('--json')
    p.add_argument('--expect-models', default='', help='Kommaliste oder "all" (= alle aus MODEL_POD): diese Modelle MUESSEN angesprochen worden sein')
    p.add_argument('--app-calls', help='JSONL von scripts/sim/app-call-check.ts')
    a = p.parse_args()
    log = pathlib.Path(a.log)
    rows = [json.loads(l) for l in log.read_text().splitlines() if l.strip()] if log.exists() else []
    soll = model_pod()
    wrong, unknown = [], []
    seen = collections.Counter()
    for r in rows:
        if r['task'] == 'warmup':
            continue
        seen[(r['role'], r['task'], r['model'])] += 1
        expected = SHARED.get(r['model']) or soll.get(r['model'])
        if expected is None:
            unknown.append(r)
        elif r['role'] not in expected.split('|') or not r.get('modelOnThisPod'):
            wrong.append({**r, 'expectedRole': expected})
    models_hit = {m for (_, _, m) in seen}
    expect = sorted(soll) if a.expect_models == 'all' else [m for m in a.expect_models.split(',') if m]
    missing = [m for m in expect if m not in models_hit]
    report = {'requests': len(rows), 'warmups': sum(1 for r in rows if r['task'] == 'warmup'), 'misrouted': wrong,
              'unknownModels': unknown, 'expectedButNotHit': missing,
              'coverage': [{'role': k[0], 'task': k[1], 'model': k[2], 'count': v} for k, v in sorted(seen.items())],
              'modelsNeverHit': sorted(set(soll) - models_hit)}
    app_failed, preload_gaps = [], []
    if a.app_calls:
        known = set(soll) | fleet_models() | set(SHARED)
        for r in (json.loads(l) for l in pathlib.Path(a.app_calls).read_text().splitlines() if l.strip()):
            if r.get('part') == 'A':
                gap = [m for m in r.get('models') or [] if m not in known]
                if gap:
                    preload_gaps.append({'role': r['role'], 'models': gap})
                if not r.get('ok') and r.get('error') != 'pod not ready/configured':
                    app_failed.append(r)
            elif not r.get('ok'):
                app_failed.append(r)
    report['appCallsFailed'] = app_failed
    report['preloadNotInFleet'] = preload_gaps
    ok = not wrong and not unknown and not missing and not app_failed
    report['passed'] = ok
    if a.json:
        pathlib.Path(a.json).write_text(json.dumps(report, indent=1))
    if a.md:
        lines = ['# Verkabelungstest: Auswertung', '', '**Ergebnis: %s**' % ('BESTANDEN' if ok else 'NICHT BESTANDEN'), '',
                 'Aufträge: %d (davon warmup %d), Fehlleitungen: %d, unbekannte Modelle: %d, erwartet aber nicht angesprochen: %d' % (
                     report['requests'], report['warmups'], len(wrong), len(unknown), len(missing)), '',
                 '| Rolle | Task | Modell | Anzahl |', '| --- | --- | --- | --- |']
        lines += ['| %s | %s | %s | %d |' % (c['role'], c['task'], c['model'], c['count']) for c in report['coverage']]
        if wrong:
            lines += ['', '## Fehlleitungen', ''] + ['- %s/%s landete auf %s, erwartet %s' % (w['task'], w['model'], w['role'], w['expectedRole']) for w in wrong]
        if app_failed:
            lines += ['', '## Fehlgeschlagene App-Aufrufe', ''] + ['- %s %s %s: %s' % (f['role'], f['task'], f.get('model') or '', f.get('error')) for f in app_failed]
        if preload_gaps:
            lines += ['', '## Warnung: Vorlade-Modelle ohne Pod (GPU_ROLES.preload; warmup meldet auf dem Pod nur den Stand, daher kein Fehler)', ''] + ['- %s: %s' % (g['role'], ', '.join(g['models'])) for g in preload_gaps]
        if missing:
            lines += ['', '## Erwartet, aber nicht angesprochen', ''] + ['- ' + m for m in missing]
        lines += ['', '## Nie angesprochene Modelle (Abdeckungslücke, kein Fehler)', ''] + ['- ' + m for m in report['modelsNeverHit']]
        pathlib.Path(a.md).write_text('\n'.join(lines) + '\n')
    print(json.dumps({'passed': ok, 'requests': report['requests'], 'misrouted': len(wrong), 'unknownModels': len(unknown),
                      'expectedButNotHit': missing, 'modelsNeverHit': len(report['modelsNeverHit']),
                      'appCallsFailed': len(app_failed), 'preloadNotInFleet': preload_gaps}))
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
