"""TLS envelope for the unchanged, digest-pinned role image and model set."""
import base64
import os
from pathlib import Path
import pod_start


def main():
    directory = Path('/data/vast-tls')
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    for kind, field in [('cert', 'AI_TLS_CERT_FILE'), ('key', 'AI_TLS_KEY_FILE')]:
        value = os.environ.pop('VAST_TLS_' + kind.upper() + '_B64', '')
        if not value:
            raise RuntimeError('Vast TLS material missing')
        path = directory / (kind + '.pem')
        path.touch(mode=0o600)
        path.chmod(0o600)
        path.write_bytes(base64.b64decode(value, validate=True))
        os.environ[field] = str(path)
    return pod_start.main()


if __name__ == '__main__':
    raise SystemExit(main())
