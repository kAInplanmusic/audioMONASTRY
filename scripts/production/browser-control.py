"""Read app auth over SSH, then test the real UI; never provisions compute."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import urllib.request
import ipaddress
import shlex
import signal


def run_child(command,env,timeout):
    process=subprocess.Popen(command,cwd=ROOT,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
    previous={sig:signal.getsignal(sig) for sig in (signal.SIGTERM,signal.SIGINT)}
    def stop(signum,frame):raise SystemExit(128+signum)
    for sig in previous:signal.signal(sig,stop)
    try:
        process.communicate(timeout=timeout)
        return process.returncode
    finally:
        if process.poll() is None:
            os.killpg(process.pid,signal.SIGTERM)
            try:process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid,signal.SIGKILL);process.wait(timeout=5)
        for sig,handler in previous.items():signal.signal(sig,handler)
import deploy

ROOT=Path(__file__).resolve().parents[2]


def main():
    run_id=os.environ['FLEET_LABEL_TIMESTAMP']
    if not run_id.isdigit() or not 10 <= len(run_id) <= 20:raise RuntimeError('INVALID_TARGET_RUN')
    servers=deploy.api('GET','servers?per_page=50')['servers']
    app=next(s for s in servers if s['name']=='audiomonastry-app-1' and s['labels'].get('app')=='audiomonastry')
    fw=next(f for f in deploy.api('GET','firewalls?per_page=50')['firewalls']
            if f['name']=='audiomonastry-prod-app-20261112' and f['labels'].get('managed-by')=='production-deploy')
    if fw['id'] not in {item['id'] for item in app['public_net']['firewalls']}:
        raise RuntimeError('CONTROL_FIREWALL_OWNERSHIP_MISMATCH')
    with urllib.request.urlopen('https://api.ipify.org',timeout=20) as response:address=response.read().decode().strip()
    if not ipaddress.ip_address(address).is_global:raise RuntimeError('RUNNER_ADDRESS_INVALID')
    binding=address+'/32'
    added=any(rule.get('port')=='22' and binding not in rule['source_ips'] for rule in fw['rules'])
    rules=[dict(rule,source_ips=rule['source_ips']+[binding]) if rule.get('port')=='22'
           and binding not in rule['source_ips'] else rule for rule in fw['rules']]
    with tempfile.TemporaryDirectory(prefix='studio-control-') as directory:
        private=Path(directory);key=private/'key';key.write_text(os.environ['AUDIO_PROD_SSH_KEY']+'\n');key.chmod(0o600)
        try:
            if added:deploy.api('POST','firewalls/'+str(fw['id'])+'/actions/set_rules',{'rules':rules})
            source="""import pathlib,json,os,subprocess,urllib.request,urllib.error
e=dict(l.split('=',1) for l in pathlib.Path('/opt/audiomonastry/.env').read_text().splitlines() if '=' in l and not l.startswith('#'))
token=e['STUDIO_ACCESS_TOKEN'].strip(chr(34)+chr(39))
result={'token':token}
"""
            if os.environ.get('INSPECT_IDLE')=='1':
                source+="""inspection={}
try:
 request=urllib.request.Request('http://127.0.0.1:8080/api/idle-signal',headers={'x-studio-token':token})
 with urllib.request.urlopen(request,timeout=10) as response:data=json.load(response)
 inspection['idle']={key:data[key] for key in ('verdict','idle','shutdown','reason','reasons','online','lastActivityAt','activityAgeSec','idleForSec','idleThresholdSec') if key in data}
except urllib.error.HTTPError as exc:inspection['idleHttpStatus']=exc.code
except Exception as exc:inspection['idleErrorType']=type(exc).__name__
p=pathlib.Path('/tmp/audiomonastry-deploy.lock')
try:os.kill(int(p.read_text()),0);inspection['liveMaintenanceLock']=True
except Exception:inspection['liveMaintenanceLock']=False
inspection['watchdog']=subprocess.run(['systemctl','show','audiomonastry-production-idle.service','--property=ActiveState,SubState,Result,ExecMainStatus,ExecMainStartTimestamp'],capture_output=True,text=True).stdout.splitlines()
inspection['timer']=subprocess.run(['systemctl','show','audiomonastry-production-idle.timer','--property=ActiveState,LastTriggerUSec,NextElapseUSecMonotonic'],capture_output=True,text=True).stdout.splitlines()
result['inspection']=inspection
"""
            source+="print(json.dumps(result))\n"
            command='python3 -c '+shlex.quote(source)
            result=subprocess.run(['ssh','-F','/dev/null','-T','-i',str(key),'-o','BatchMode=yes',
                '-o','StrictHostKeyChecking=accept-new','-o','UserKnownHostsFile='+str(private/'known_hosts'),
                '-o','ConnectTimeout=20','root@'+app['public_net']['ipv4']['ip'],command],capture_output=True,timeout=45)
            if result.returncode:raise RuntimeError('CONTROL_AUTH_BINDING_UNAVAILABLE')
            auth=json.loads(result.stdout)
            token=auth['token']
        finally:
            if added:
                current=deploy.api('GET','firewalls/'+str(fw['id']))['firewall']
                restored=[dict(rule,source_ips=[ip for ip in rule['source_ips'] if ip!=binding])
                          if rule.get('port')=='22' and binding in rule['source_ips'] else rule for rule in current['rules']]
                if any(rule.get('port')=='22' and not rule['source_ips'] for rule in restored):
                    raise RuntimeError('SSH_RULE_RECONCILIATION_FAILED')
                deploy.api('POST','firewalls/'+str(fw['id'])+'/actions/set_rules',{'rules':restored})
    if os.environ.get('INSPECT_IDLE')=='1':
        output=ROOT/'production-evidence';output.mkdir(exist_ok=True)
        report={'inspection':auth['inspection'],'computeInstancesCreated':0}
        (output/'control.json').write_text(json.dumps(report,indent=2)+'\n')
        print(json.dumps(report))
        return
    spec=importlib.util.spec_from_file_location('control_vast',ROOT/'scripts/vast-pods.py')
    vast=importlib.util.module_from_spec(spec);spec.loader.exec_module(vast)
    labels={vast.PREFIX+role+'-'+run_id for role in ('brain','ears','voice','music','studio','audio-brain','song','vis')}
    deadline=time.monotonic()+28*60
    while time.monotonic()<deadline:
        owned=[item for item in vast.instances() if item.get('label') in labels]
        if len(owned)==8:
            ids=[str(item['id']) for item in owned]
            break
        time.sleep(10)
    else:raise RuntimeError('CONTROL_TARGET_FLEET_NOT_PRESENT')
    keep=('PATH','HOME','RUNNER_TRACKING_ID','HTTPS_PROXY','HTTP_PROXY','NO_PROXY','https_proxy','http_proxy','no_proxy','NODE_EXTRA_CA_CERTS','SSL_CERT_FILE')
    env={key:os.environ[key] for key in keep if key in os.environ}
    for command in (['npm','ci','--ignore-scripts'],['npx','playwright','install','--with-deps','chromium']):
        if run_child(command,env,600):
            raise RuntimeError('CONTROL_BROWSER_DEPENDENCIES_FAILED')
    env.update(STUDIO_ACCESS_TOKEN=token,EXPECTED_POD_IDS=json.dumps(ids),TARGET_RUN_ID=run_id)
    code=run_child(['node','scripts/production/studio-control-acceptance.mjs'],env,1500)
    output=ROOT/'production-evidence/control.json'
    if output.exists():print(output.read_text())
    raise SystemExit(code)


if __name__=='__main__':main()
