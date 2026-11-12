"""Run the unchanged strict RT gate inside the actual production app container."""
import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess

ROOT = Path('/opt/audiomonastry')
spec = importlib.util.spec_from_file_location('production_bootstrap', ROOT / 'scripts/production/bootstrap.py')
bootstrap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bootstrap)


def main():
    path = Path('/root/audiomonastry-production.json')
    config = json.loads(path.read_text())
    bundle = base64.b64decode(config['rtBundleB64'], validate=True)
    digest = hashlib.sha256(bundle).hexdigest()
    report = {'role':'app','stage':'failed','commit':config['commit'],
              'bundleSha256':digest,'ciToleranceEnabled':False}
    try:
        if digest != config['rtBundleSha256']:
            raise RuntimeError('RT_BUNDLE_IDENTITY_MISMATCH')
        result = subprocess.run(['docker','exec','-i','-e','CI=','audiomonastry','node',
            '--input-type=module','-','--json','--gate'],input=bundle,capture_output=True,timeout=240)
        measurement = json.loads(result.stdout.decode().strip().splitlines()[-1])
        report['measurement'] = measurement
        report['stage'] = 'passed' if result.returncode == 0 and measurement.get('checks') and all(
            check.get('ok') is True for check in measurement['checks']) else 'failed'
    except Exception as exc:
        report['errorCode'] = type(exc).__name__
    finally:
        body = json.dumps(report).encode()
        bootstrap.s3_request(config,'PUT','deployment/2026-11-12-production/rt-app.json',body)
        bootstrap.s3_request(config,'PUT',config['evidencePrefix']+'/rt-app.json',body)
        path.unlink(missing_ok=True)
    if report['stage'] != 'passed':
        raise SystemExit(2)


if __name__ == '__main__':
    main()
