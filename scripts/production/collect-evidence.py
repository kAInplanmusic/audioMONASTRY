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
          'containerImages','containers','caddyImageId','failureFrames','errorType','cooldown'}


def main():
    output = ROOT / 'production-evidence'
    output.mkdir(exist_ok=True)
    prefix = 'deployment/runs/' + os.environ['GITHUB_RUN_ID'] + '/' + os.environ.get('GITHUB_RUN_ATTEMPT','1')
    target = S3Target.from_r2_env()
    reports = {}
    names = [stage+'-'+role for stage in ('deploy','verify') for role in ('app','sfu','media','edge')] + ['ai-acceptance']
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
    summary = {'runId': os.environ['GITHUB_RUN_ID'], 'sourceCommit': expected,
               'allFourCpuRolesPassed': cpu, 'eightRoleInferencePassed': ai.get('passed') is True,
               'gpuCleanupPassed': ai.get('cleanupPassed') is True and ai.get('independentCleanupPassed') is True,
               'missingReports': [name for name in names if name not in reports],
               'identityHashes': {name: hashlib.sha256((ROOT / 'services/audiomonastry-ai-runtime' / name).read_bytes()).hexdigest()
                                  for name in ('model_manifest.json','weight_assets.lock.json')},
               'reports': reports}
    (output / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
    print(json.dumps({key: value for key, value in summary.items() if key != 'reports'}))


if __name__ == '__main__':
    main()
