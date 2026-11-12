"""A bounded, real SSH maintenance session using the existing deploy PID lock.

Both idle mechanisms remain enabled: `who` sees the PTY, and
fleet-idle-teardown.py sees this live PID. No activity is fabricated.
"""
import os
from pathlib import Path
import signal
import time


def main():
    os.umask(0o077)
    lock = Path(os.environ.get('PRODUCTION_DEPLOY_LOCK_PATH', '/tmp/audiomonastry-deploy.lock'))
    if lock.exists():
        try:
            previous = int(lock.read_text().strip())
            os.kill(previous, 0)
        except (ValueError, ProcessLookupError):
            lock.unlink(missing_ok=True)
        else:
            raise RuntimeError('ANOTHER_DEPLOYMENT_IS_RUNNING')
    descriptor = os.open(lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'w') as handle:
        handle.write(str(os.getpid()))
    def finish(signum, frame):
        raise SystemExit(0)
    for signum in (signal.SIGHUP, signal.SIGTERM, signal.SIGINT):
        signal.signal(signum, finish)
    try:
        print('MAINTENANCE_READY', flush=True)
        time.sleep(5400)
    finally:
        if lock.exists() and lock.read_text().strip() == str(os.getpid()):
            lock.unlink()


if __name__ == '__main__':
    main()
