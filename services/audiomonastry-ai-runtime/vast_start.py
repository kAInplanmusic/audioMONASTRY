"""TLS envelope for the unchanged, digest-pinned role image and model set."""
import base64
import os
import zlib
from pathlib import Path
import pod_start
from vast_bootstrap import supervise


def main():
    os.environ['AI_VAST_TLS_WRAPPER'] = '1'
    packed = os.environ.pop('VAST_WEIGHTS_ZLIB_B64', '')
    if packed:
        decoder = zlib.decompressobj()
        raw = decoder.decompress(base64.b64decode(packed, validate=True), 2 * 1024 * 1024)
        if not decoder.eof or decoder.unconsumed_tail or decoder.unused_data:
            raise RuntimeError('Invalid or oversized compressed weight manifest')
        os.environ['AI_WEIGHTS_URLS'] = raw.decode('utf-8')
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
    return supervise()


if __name__ == '__main__':
    raise SystemExit(main())
