"""Collect fixed, sanitized production reports; never upload controller state."""
import hashlib
import json
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
from s3lite import S3Target

FIELDS = {'role','stage','commit','checks','collaboration','errorCode','httpStatus','failureCode',
          'failureDetail','updatedAt','passed','roles','cleanupPassed','independentCleanupPassed',
          'runId','instancesCreated','instancesAllocated','allocationsEverCreated','allocatedRoles',
          'allocatedInstances','parameterProfile','responseByteLimit','applicationWakeAccepted',
          'applicationInferencePassed','applicationEnvironmentRestored','budgetEvidence','hourlyCeilingEur',
          'containerImages','containers','caddyImageId','failureFrames','errorType','cooldown',
          'bundleSha256','ciToleranceEnabled','measurement','producers','consumers','echo'}


def main():
    output = ROOT / 'production-evidence'
    output.mkdir(exist_ok=True)
    prefix = 'deployment/runs/' + os.environ['GITHUB_RUN_ID'] + '/' + os.environ.get('GITHUB_RUN_ATTEMPT','1')
    target = S3Target.from_r2_env()
    reports = {}
    names = [stage+'-'+role for stage in ('deploy','verify') for role in ('app','sfu','media','edge')] + ['rt-app','rtp','ai-acceptance']
    for name in names:
        body = target.get_bytes(prefix + '/' + name + '.json')
        if body is None:
            continue
        data = json.loads(body)
        reports[name] = {key: value for key, value in data.items() if key in FIELDS}
    expected = os.environ['GITHUB_SHA']
    cpu = all(reports.get('verify-'+role, {}).get('stage') == 'passed'
              and reports.get('deploy-'+role, {}).get('commit') == expected
              for role in ('app','sfu','media','edge'))
    ai = reports.get('ai-acceptance', {})
    rt = reports.get('rt-app', {})
    rt_checks = rt.get('measurement',{}).get('checks',[])
    rt_pass = (rt.get('stage') == 'passed' and rt.get('ciToleranceEnabled') is False
               and rt.get('commit') == expected and bool(rt_checks)
               and all(check.get('ok') is True for check in rt_checks))
    ai_pass = ai.get('stage') == 'passed' and ai.get('passed') is True and ai.get('commit') == expected
    cleanup_pass = ai.get('cleanupPassed') is True and ai.get('independentCleanupPassed') is True
    rtp = reports.get('rtp',{})
    rtp_pass = rtp.get('stage') == 'passed' and rtp.get('commit') == expected
    dns_path = output / 'dns.json'
    dns = json.loads(dns_path.read_text()) if dns_path.exists() else {}
    dns_pass = dns.get('verificationPassed') is True
    summary = {'runId': os.environ['GITHUB_RUN_ID'], 'sourceCommit': expected,
               'allFourCpuRolesPassed': cpu, 'eightRoleInferencePassed': ai_pass,
               'strictProductionRealtimePassed':rt_pass,
               'publicSfuRtpPassed':rtp_pass,
               'gpuCleanupPassed': cleanup_pass, 'productionDnsPassed':dns_pass,
               'allProductionGatesPassed':cpu and rt_pass and rtp_pass and ai_pass and cleanup_pass and dns_pass,
               'missingReports': [name for name in names if name not in reports],
               'identityHashes': {name: hashlib.sha256((ROOT / 'services/audiomonastry-ai-runtime' / name).read_bytes()).hexdigest()
                                  for name in ('model_manifest.json','weight_assets.lock.json')},
               'reports': reports, 'dns':dns}
    (output / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
    print(json.dumps({key: value for key, value in summary.items() if key != 'reports'}))


if __name__ == '__main__':
    main()
