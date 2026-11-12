"""Private on-node production checks. Export only fixed result fields to R2."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import urllib.request

ROOT=Path('/opt/audiomonastry')
spec=importlib.util.spec_from_file_location('bootstrap',ROOT/'scripts/production/bootstrap.py')
bootstrap=importlib.util.module_from_spec(spec)
spec.loader.exec_module(bootstrap)


def main():
    os.umask(0o077)
    config=json.loads(Path('/root/audiomonastry-production.json').read_text())
    role=config['role']
    report={'role':role,'stage':'verifying','checks':{}}
    env=bootstrap.env_read()
    def request(url,auth=True):
        headers={'User-Agent':'audioMONASTRY-DeploymentCheck/1.0'}
        if auth:headers['x-studio-token']=env['STUDIO_ACCESS_TOKEN']
        with urllib.request.urlopen(urllib.request.Request(url,headers=headers),timeout=60) as response:
            return json.load(response)
    try:
        timer=subprocess.run(['systemctl','is-active','audiomonastry-idle-shutdown.timer'],capture_output=True)
        if timer.returncode:
            bootstrap.run(['bash','scripts/hetzner/install-idle-shutdown.sh'])
        report['checks']['idlePolicyVerified']=subprocess.run(['bash','scripts/hetzner/check-idle-shutdown.sh'],cwd=ROOT).returncode==0
        if role!='edge':
            health=request('http://127.0.0.1:8080/api/health')
            report['checks']['apiHealth']=health.get('status')=='ok'
            report['commit']=health.get('commit')
            deployment=json.loads(bootstrap.s3_request(config,'GET','deployment/2026-11-12-production/'+role+'.json'))
            report['checks']['currentDeploymentCommit']=deployment.get('stage')=='services_started' and deployment.get('commit')==health.get('commit')
            report['checks']['cloudHealthHttp']=bool(request('http://127.0.0.1:8080/api/cloud/health'))
        if role=='app':
            report['checks']['masterAudioSelftest']=request('http://127.0.0.1:8000/selftest',False).get('selfTest')=='ok'
            rtc=request('http://127.0.0.1:8080/api/webrtc-config')
            report['checks']['turnConfigured']=bool(rtc.get('turn',{}).get('available'))
            report['checks']['sfuConfigured']=bool(rtc.get('sfu',{}).get('ready'))
            script=(ROOT/'scripts/production/collaboration-smoke.mjs').read_bytes()
            result=subprocess.run(['docker','exec','-i','audiomonastry','node','--input-type=module'],input=script,capture_output=True,timeout=120)
            data=json.loads(result.stdout.decode().strip().splitlines()[-1])
            report['collaboration']={k:data[k] for k in ('passed','healthRequests','httpP95Ms','collaboratingUsers','fifthUserRejected','clockExchanges','errorCode') if k in data}
            report['checks']['fourUserCollaboration']=result.returncode==0 and data.get('passed') is True
        if role=='edge':
            report['checks']['prometheusReady']=subprocess.run(['docker','exec','audiomonastry-prometheus','wget','-q','-O','/dev/null','http://localhost:9090/-/ready']).returncode==0
        images=subprocess.run(['docker','ps','--format','{{.Names}} {{.Image}}'],capture_output=True,text=True)
        report['containerImages']=images.stdout.splitlines()
        report['stage']='passed' if all(report['checks'].values()) else 'failed'
    except Exception as exc:
        report['stage']='failed'
        report['errorCode']=type(exc).__name__
        if hasattr(exc,'code') and type(exc.code) is int:report['httpStatus']=exc.code
    finally:
        bootstrap.s3_request(config,'PUT','deployment/2026-11-12-production/verify-'+role+'.json',json.dumps(report).encode())
        Path('/root/audiomonastry-production.json').unlink(missing_ok=True)
    if report['stage']!='passed':raise SystemExit(2)

if __name__=='__main__':main()
