#!/usr/bin/env python3
"""Compatibility entrypoint for the unified Vast/Hetzner lifecycle."""
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]

def main():
    if len(sys.argv) < 2 or sys.argv[1] not in ('start', 'stop'):
        print('Usage: fleet_manager.py start|stop [--dry-run] [--no-backup]')
        return 2
    action = 'fleet-start.py' if sys.argv[1] == 'start' else 'fleet-teardown.py'
    flags = [x for x in sys.argv[2:] if x != '--dry-run']
    flags = ['--no-snapshot' if x == '--no-backup' else x for x in flags]
    if '--dry-run' not in sys.argv[2:] and '--yes' not in flags:
        flags.append('--yes')
    return subprocess.call([sys.executable, str(ROOT / 'scripts' / action), *flags])

if __name__ == '__main__':
    raise SystemExit(main())
