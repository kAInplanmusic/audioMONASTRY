"""Build a private, real executor probe before any paid allocation."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess

root=Path(__file__).resolve().parents[2]
allowed=('PATH','HOME','RUNNER_TRACKING_ID','HTTPS_PROXY','HTTP_PROXY','NO_PROXY',
         'https_proxy','http_proxy','no_proxy','NODE_EXTRA_CA_CERTS','SSL_CERT_FILE','NODE_OPTIONS')
env={key:os.environ[key] for key in allowed if key in os.environ}
subprocess.run(['npm','ci','--ignore-scripts'],cwd=root,env=env,check=True)
bundle=subprocess.check_output([str(root/'node_modules/.bin/esbuild'),
    'scripts/production/executor-live-probe.ts','--bundle','--platform=node','--format=esm','--log-level=error'],cwd=root,env=env)
directory=Path(os.environ.get('RUNNER_TEMP','/tmp'))/'audiomonastry-priority-executor'
directory.mkdir(mode=0o700,exist_ok=True);directory.chmod(0o700)
source=directory/'probe.mjs';source.write_bytes(bundle);source.chmod(0o600)
node=shutil.which('node');assert node
with Path(os.environ['GITHUB_ENV']).open('a') as output:
    for key,value in {'VAST_EXECUTOR_PROBE_FILE':str(source),'VAST_EXECUTOR_PROBE_NODE':node}.items():
        assert '\n' not in value
        output.write(key+'='+value+'\n')
print(json.dumps({'executorProbePrepared':True,'bundleSha256':hashlib.sha256(bundle).hexdigest()}))
