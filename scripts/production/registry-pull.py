"""Fresh CPU-only pull of the failed role digest using the production binding."""
import json
import os
from pathlib import Path
import subprocess
import tempfile


def main():
    image=json.loads(Path('deploy/vast/images.json').read_text())['audio-brain']
    report={'role':'audio-brain','image':image,'gpuInstancesCreated':0,'loginPassed':False,'fullImagePullPassed':False}
    with tempfile.TemporaryDirectory(prefix='registry-pull-') as private:
        env=dict(os.environ,DOCKER_CONFIG=private)
        login=subprocess.run(['docker','login','ghcr.io','--username',os.environ['GHCR_USERNAME'],'--password-stdin'],
            input=os.environ['GHCR_PASSWORD'].encode(),capture_output=True,env=env,timeout=60)
        report['loginPassed']=login.returncode==0
        if report['loginPassed']:
            pull=subprocess.run(['docker','pull',image],capture_output=True,env=env,timeout=900)
            report['fullImagePullPassed']=pull.returncode==0
        output=Path('production-evidence');output.mkdir(exist_ok=True)
        (output/'registry-pull.json').write_text(json.dumps(report,indent=2)+'\n')
        print(json.dumps(report))
    if not report['fullImagePullPassed']:raise SystemExit(2)


if __name__=='__main__':main()
