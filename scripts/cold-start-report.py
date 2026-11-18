#!/usr/bin/env python3
"""Haengt einen Kaltstart-Bericht (cold-start-report.json) an das fortlaufende Repo-Log docs/COLD_START_LOG.md an.

Nur anhaengen, nie ueberschreiben. Aufruf nach einem Lauf:
  python3 scripts/cold-start-report.py <state-dir>/cold-start-report.json [--log docs/COLD_START_LOG.md] [--when "2026-11-18 17:00"]
Das Log enthaelt keine Zugangsdaten (der Bericht enthaelt keine).
"""
import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import cold_start_report as csr  # noqa: E402

HEADER = ('# Kaltstart-Log (nur anhängen)\n\n'
          'Ziel: alle Rollen in 15 Minuten bereit; eine Rolle darf bis 30 Minuten laufen. Jeder Eintrag stammt aus `cold-start-report.json`. '
          'Rollen über dem Ziel haben einen Hinweis zur Workflow-Optimierung.\n\n')


def append(report, log_path, when=None):
    log_path = Path(log_path)
    when = when or datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')
    block = csr.to_markdown(report, when)
    existing = log_path.read_text(encoding='utf-8') if log_path.exists() else HEADER
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log_path.write_text(existing.rstrip('\n') + '\n\n' + block, encoding='utf-8')
    return block


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('report', type=Path)
    parser.add_argument('--log', type=Path, default=ROOT / 'docs/COLD_START_LOG.md')
    parser.add_argument('--when')
    args = parser.parse_args()
    report = json.loads(args.report.read_text(encoding='utf-8'))
    append(report, args.log, args.when)
    print('Eintrag angehängt:', args.log)
    return 0


if __name__ == '__main__':
    sys.exit(main())
