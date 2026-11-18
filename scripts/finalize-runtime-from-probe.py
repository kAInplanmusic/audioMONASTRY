#!/usr/bin/env python3
"""Waehlt je Rolle den Host, der laut externer Messung (pod_reach_probe.py) zuerst bereit war, zerstoert den anderen und schreibt die
Runtime-Umgebung der App (ohne Vast-Schluessel).

Eingaben: State-Verzeichnis von `vast-pods.py up` (VAST_RENT_ONLY=1, Zweit-Hosts) und das Messergebnis (JSON). Ausgabe: runtime.env + ca.pem.
Eine Rolle ohne bereiten Host bricht ab (Exit 3), ohne dass etwas zerstoert wird: der Aufrufer entscheidet (weiter messen oder abbrechen).
Der Vast-Schluessel gehoert nicht in diese Datei; wer die Pods spaeter beenden will, braucht ihn separat.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]


def choose_winners(state, result):
    """Je Rolle (Primaer `role`, Zweit-Host `role-hedge`) der Eintrag mit der kleinsten `firstReadyS`. Rueckgabe: ({rolle: (art, item)}, [fehlende Rollen])."""
    winners, missing = {}, []
    targets = result.get('targets', {})
    for role, primary in state.get('instances', {}).items():
        candidates = [('primary', primary, role)]
        hedge = state.get('hedges', {}).get(role)
        if hedge:
            candidates.append(('hedge', hedge, role + '-hedge'))
        ready = [(targets.get(name, {}).get('firstReadyS'), kind, item) for kind, item, name in candidates
                 if targets.get(name, {}).get('firstReadyS') is not None]
        if not ready:
            missing.append(role)
            continue
        _, kind, item = min(ready, key=lambda row: row[0])
        winners[role] = (kind, item)
    return winners, missing


def runtime_lines(winners, ports, token, eur_by_role=None):
    lines = ['AI_GPU_PROVIDER=vast', 'AI_FLEET_MODE=pods', 'AI_MAX_AI_EUR_PER_HOUR=8', 'AI_MAX_FLEET_EUR_PER_HOUR=8',
             'NODE_EXTRA_CA_CERTS=/etc/audiomonastry-vast/ca.pem', 'AI_POD_TOKEN=' + token]
    for role, (_, item) in sorted(winners.items()):
        name = role.upper().replace('-', '_')
        lines += ['VAST_POD_URL_%s=https://%s:%s' % (name, item['host'], ports[str(item['id'])]),
                  'VAST_POD_ID_%s=%s' % (name, item['id']),
                  'VAST_POD_EUR_PER_HOUR_%s=%s' % (name, (eur_by_role or {}).get(role, item.get('eurPerHour')))]
    return lines


def load_pods():
    spec = importlib.util.spec_from_file_location('vast_pods_finalize', ROOT / 'scripts/vast-pods.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--state-dir', type=Path, required=True)
    parser.add_argument('--probe-result', type=Path, required=True)
    parser.add_argument('--out-dir', type=Path, required=True)
    parser.add_argument('--keep-losers', action='store_true', help='unterlegene Hosts nicht zerstoeren (Pruefmodus)')
    args = parser.parse_args()
    state = json.loads((args.state_dir / 'state.json').read_text())
    result = json.loads(args.probe_result.read_text())
    winners, missing = choose_winners(state, result)
    print(json.dumps({'winners': {r: k for r, (k, _) in winners.items()}, 'missing': missing}), flush=True)
    if missing:
        return 3
    vp = load_pods()
    live = {str(row['id']): row for row in vp.instances()}
    ports = {}
    for role, (_, item) in winners.items():
        found = (live.get(str(item['id']), {}).get('ports') or {}).get('8000/tcp')
        if not found:
            raise SystemExit('Kein Port fuer %s (Instanz %s)' % (role, item['id']))
        ports[str(item['id'])] = found[0]['HostPort']
    winner_ids = {str(item['id']) for _, item in winners.values()}
    if not args.keep_losers:
        losers = [item for item in list(state['instances'].values()) + list(state.get('hedges', {}).values()) if str(item['id']) not in winner_ids]
        for item in losers:
            row = live.get(str(item['id']))
            if row and str(row.get('label', '')).startswith(vp.PREFIX) and row.get('label') == item.get('label'):
                vp.destroy(item['id'])
                print(json.dumps({'destroyed': item['id'], 'label': item.get('label')}), flush=True)
    token = os.environ['AI_POD_TOKEN']
    args.out_dir.mkdir(parents=True, exist_ok=True)
    (args.out_dir / 'runtime.env').write_text('\n'.join(runtime_lines(winners, ports, token)) + '\n')
    os.chmod(args.out_dir / 'runtime.env', 0o600)
    (args.out_dir / 'ca.pem').write_text(''.join(Path(item['cert']).read_text() for _, item in winners.values()))
    state['instances'] = {role: item for role, (_, item) in winners.items()}
    state['hedges'] = {}
    state['promoted'] = True
    (args.state_dir / 'state.json').write_text(json.dumps(state))
    print(json.dumps({'runtimeEnv': str(args.out_dir / 'runtime.env'), 'roles': sorted(winners)}), flush=True)
    return 0


if __name__ == '__main__':
    sys.exit(main())
