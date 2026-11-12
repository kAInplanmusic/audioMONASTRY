"""Bounded Vast acceptance on the production orchestrator, with independent cleanup."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import base64
import hashlib

ROOT=Path('/opt/audiomonastry')
spec=importlib.util.spec_from_file_location('bootstrap',ROOT/'scripts/production/bootstrap.py')
bootstrap=importlib.util.module_from_spec(spec)
spec.loader.exec_module(bootstrap)


def main():
    os.umask(0o077)
    config=json.loads(Path('/root/audiomonastry-production.json').read_text())
    os.environ.update(bootstrap.env_read())
    os.environ.update(config['updates'])
    base=Path('/var/lib/audiomonastry-vast')
    base.mkdir(mode=0o700,exist_ok=True)
    state=base/('acceptance-'+str(int(time.time())))
    state.mkdir(mode=0o700)
    executor_bundle=base64.b64decode(config['executorBundleB64'],validate=True)
    if hashlib.sha256(executor_bundle).hexdigest()!=config['executorBundleSha256']:
        raise RuntimeError('EXECUTOR_PROBE_IDENTITY_MISMATCH')
    executor_file=state/'executor-probe.mjs'
    executor_file.write_bytes(executor_bundle)
    executor_image=json.loads(subprocess.check_output(['docker','inspect','audiomonastry']))[0]['Image']
    os.environ.update(VAST_EXECUTOR_PROBE_FILE=str(executor_file),VAST_EXECUTOR_PROBE_IMAGE=executor_image)
    os.environ.update(VAST_PLAN_OFFER_LIMIT='25',VAST_SEARCH_QUOTA_STATE=str(base/'search-quota.json'))
    report={'passed':False,'instancesCreated':0,'stage':'preflight',
            'commit':config['commit'],'runId':config['updates'].get('VAST_LABEL_TIMESTAMP')}
    unit='audiomonastry-vast-acceptance-cleanup-'+state.name.removeprefix('acceptance-')
    python=ROOT/'.venv-vast-acceptance/bin/python'
    def run(args,timeout=600):
        return subprocess.run([str(x) for x in args],cwd=ROOT,timeout=timeout).returncode
    try:
        bootstrap.s3_request(config,'PUT','deployment/2026-11-12-production/ai-acceptance.json',json.dumps(report).encode())
        if config.get('evidencePrefix'):
            bootstrap.s3_request(config,'PUT',config['evidencePrefix']+'/ai-acceptance.json',json.dumps(report).encode())
        # Old snapshots lack Debian's ensurepip package. Validate dependencies
        # before planning or buying GPUs, including a partially created venv.
        probe=subprocess.run([sys.executable,'-c','import ensurepip'],capture_output=True)
        if probe.returncode:
            if run(['apt-get','update','-qq'],timeout=180):raise RuntimeError('QA_VENV_FAILED')
            if run(['apt-get','-o','DPkg::Lock::Timeout=120','install','-y','python3-venv'],timeout=300):raise RuntimeError('QA_VENV_FAILED')
        valid=python.exists() and subprocess.run([python,'-m','pip','--version'],capture_output=True).returncode==0
        if not valid:
            if run([sys.executable,'-m','venv',python.parent.parent]):raise RuntimeError('QA_VENV_FAILED')
        dependencies=subprocess.run([python,'-c','import numpy,soundfile'],capture_output=True)
        if dependencies.returncode:
            if run([python,'-m','pip','install','numpy==2.2.6','soundfile==0.13.1']):raise RuntimeError('QA_DEPENDENCIES_FAILED')
        inventory=state/'inventory.json'
        if run([python,'scripts/vast-transfer-inventory.py','--output',inventory]):raise RuntimeError('TRANSFER_INVENTORY_FAILED')
        plan=state/'plan.json'
        code=run([python,'scripts/vast-fleet-plan.py','--region','global','--transfer-inventory',inventory,'--image-sizes','deploy/vast/image-sizes.json','--output',plan])
        if code==42:
            report['failureCode']='VAST_SEARCH_COOLDOWN'
            report['cooldown']=json.loads((base/'search-quota.json').read_text())
            return 42
        if code:raise RuntimeError('NO_COMPLETE_BUDGETED_ASSIGNMENT')
        cleanup=ROOT/'scripts/production/vast-cleanup.py'
        if run(['systemd-run','--unit='+unit,'--on-active=28m',sys.executable,cleanup,state]):raise RuntimeError('INDEPENDENT_CLEANUP_NOT_ARMED')
        report['stage']='running'
        bootstrap.s3_request(config,'PUT','deployment/2026-11-12-production/ai-acceptance.json',json.dumps(report).encode())
        code=run(['timeout','--signal=TERM','--kill-after=30','28m',python,'-u','scripts/vast-http-fleet-qa.py','--plan',plan,'--images','deploy/vast/images.json','--state-dir',state,'--output',state/'validation.json','--production-app'],timeout=1740)
        if (state/'validation.json').exists():report=json.loads((state/'validation.json').read_text())
        report['stage']='passed' if code==0 else 'failed'
        return code
    except Exception as exc:
        allowed={'QA_VENV_FAILED','QA_DEPENDENCIES_FAILED','TRANSFER_INVENTORY_FAILED','NO_COMPLETE_BUDGETED_ASSIGNMENT','INDEPENDENT_CLEANUP_NOT_ARMED'}
        report.update(stage='failed',failureCode=str(exc) if str(exc) in allowed else type(exc).__name__)
        return 2
    finally:
        # The systemd timer is an additional safety net if this process is lost.
        cleanup_code=run([sys.executable,ROOT/'scripts/production/vast-cleanup.py',state],timeout=120) if (state/'state.json').exists() else 0
        report['independentCleanupPassed']=cleanup_code==0
        report.update(commit=config['commit'],runId=config['updates'].get('VAST_LABEL_TIMESTAMP'))
        if cleanup_code==0:run(['systemctl','stop',unit+'.timer'])
        bootstrap.s3_request(config,'PUT','deployment/2026-11-12-production/ai-acceptance.json',json.dumps(report).encode())
        if config.get('evidencePrefix'):
            bootstrap.s3_request(config,'PUT',config['evidencePrefix']+'/ai-acceptance.json',json.dumps(report).encode())
        Path('/root/audiomonastry-production.json').unlink(missing_ok=True)

if __name__=='__main__':raise SystemExit(main())
