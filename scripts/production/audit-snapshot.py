"""Inspect one isolated snapshot copy; prevent egress and always remove it."""
import argparse
import ipaddress
import json
import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import time
import urllib.request
import signal
import deploy
import provision

ROOT=Path(__file__).resolve().parents[2]

def owned(item,run_id):
    return all(item.get('labels',{}).get(key)==value for key,value in
        {'app':'audiomonastry-diagnostics','managed-by':'production-audit','audit-run':run_id}.items())

def cleanup(run_id):
    for server in deploy.api('GET','servers?per_page=50')['servers']:
        if not owned(server,run_id):continue
        if server['name']!='am-audit-app-'+run_id:raise RuntimeError('AUDIT_OWNERSHIP_MISMATCH')
        for attempt in range(30):
            try:
                deploy.api('POST','servers/'+str(server['id'])+'/actions/change_protection',{'delete':False,'rebuild':False})
                deploy.api('DELETE','servers/'+str(server['id']));break
            except RuntimeError as error:
                if str(error).startswith('HETZNER_HTTP_404:'):break
                if not str(error).startswith(('HETZNER_HTTP_409:','HETZNER_HTTP_423:')):raise
                time.sleep(2)
        else:raise RuntimeError('AUDIT_SERVER_CLEANUP_LOCKED')
    for _ in range(30):
        remaining=[s for s in deploy.api('GET','servers?per_page=50')['servers'] if owned(s,run_id)]
        if not remaining:break
        time.sleep(2)
    if remaining:raise RuntimeError('AUDIT_SERVER_CLEANUP_NOT_CONFIRMED')
    for image in provision.collection(deploy.api,'images','type=snapshot'):
        if (image.get('created_from') or {}).get('name')=='am-audit-app-'+run_id:
            if image.get('protection',{}).get('delete'):raise RuntimeError('AUDIT_SNAPSHOT_PROTECTED')
            deploy.api('DELETE','images/'+str(image['id']))
    for firewall in deploy.api('GET','firewalls?per_page=50')['firewalls']:
        if owned(firewall,run_id):deploy.api('DELETE','firewalls/'+str(firewall['id']))
    remaining=[f for f in deploy.api('GET','firewalls?per_page=50')['firewalls'] if owned(f,run_id)]
    if remaining:raise RuntimeError('AUDIT_FIREWALL_CLEANUP_NOT_CONFIRMED')
    return True

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--cleanup-only',action='store_true')
    args=parser.parse_args();run_id=os.environ['GITHUB_RUN_ID']
    if not run_id.isdigit():raise RuntimeError('INVALID_RUN')
    if args.cleanup_only:
        print(json.dumps({'auditCleanupPassed':cleanup(run_id)}));return
    def stop(signum,frame):raise SystemExit(128+signum)
    signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGINT,stop)
    report={'runId':run_id,'sourceCommit':os.environ['GITHUB_SHA'],'scope':'isolated app snapshot diagnostics',
            'computeInstancesCreated':0,'cleanupPassed':False}
    output=ROOT/'production-evidence';output.mkdir(exist_ok=True)
    try:
        if any(owned(s,run_id) for s in deploy.api('GET','servers?per_page=50')['servers']):raise RuntimeError('AUDIT_REQUIRES_NEW_STATE')
        images=provision.collection(deploy.api,'images','type=snapshot')
        image=max((s for s in images if s['status']=='available' and provision.snapshot_role(s)=='app'),key=lambda s:s['created'])
        types=provision.collection(deploy.api,'server_types')
        options=[]
        for t in types:
            if t.get('architecture')!='x86' or t['disk']<image['disk_size'] or not t['name'].startswith('cpx'):continue
            for location in t.get('locations',[]):
                if not location.get('available'):continue
                price=next((float(row['price_hourly']['gross']) for row in t['prices'] if row['location']==location['name']),1)
                if 0<price<=.30:options.append((price,t['name'],location['name']))
        if not options:raise RuntimeError('NO_BOUNDED_AUDIT_CAPACITY')
        price,kind,location=min(options)
        with urllib.request.urlopen('https://api.ipify.org',timeout=20) as response:address=response.read().decode().strip()
        if not ipaddress.ip_address(address).is_global:raise RuntimeError('INVALID_RUNNER_ADDRESS')
        with tempfile.TemporaryDirectory(prefix='snapshot-audit-') as directory:
            private=Path(directory);key=private/'key';key.write_text(os.environ['AUDIO_PROD_SSH_KEY']+'\n');key.chmod(0o600)
            public=subprocess.check_output(['ssh-keygen','-y','-f',str(key)],text=True).strip()
            ssh_key=next(s for s in deploy.api('GET','ssh_keys?per_page=50')['ssh_keys'] if s['public_key'].split()[:2]==public.split()[:2])
            labels={'app':'audiomonastry-diagnostics','managed-by':'production-audit','audit-run':run_id}
            firewall=deploy.api('POST','firewalls',{'name':'am-audit-'+run_id,'labels':labels,'rules':[
                {'direction':'in','protocol':'tcp','port':'22','source_ips':[address+'/32']},
                {'direction':'out','protocol':'tcp','port':'22','destination_ips':[address+'/32']} ]})['firewall']
            userdata='#cloud-config\npackage_update: false\npackage_upgrade: false\nruncmd:\n - [systemctl, stop, audiomonastry-production-idle.timer, audiomonastry-idle-shutdown.timer]\n - [systemctl, stop, docker]\n'
            server=deploy.api('POST','servers',{'name':'am-audit-app-'+run_id,'image':image['id'],'server_type':kind,'location':location,
                'ssh_keys':[ssh_key['id']],'firewalls':[{'firewall':firewall['id']}],'labels':labels,'user_data':userdata,
                'public_net':{'enable_ipv4':True,'enable_ipv6':False}})['server']
            report.update(computeInstancesCreated=1,snapshotId=image['id'],hourlyGrossEur=price,
                providerApiEgressBlocked=True,publicAppPortsBlocked=True)
            for _ in range(60):
                server=deploy.api('GET','servers/'+str(server['id']))['server']
                if server['status']=='running':break
                time.sleep(2)
            deploy.api('POST','servers/'+str(server['id'])+'/actions/change_protection',{'delete':True,'rebuild':True})
            command=['ssh','-F','/dev/null','-T','-i',str(key),'-o','BatchMode=yes','-o','StrictHostKeyChecking=accept-new',
                '-o','UserKnownHostsFile='+str(private/'known_hosts'),'-o','ConnectTimeout=10','root@'+server['public_net']['ipv4']['ip']]
            for attempt in range(30):
                ready=subprocess.run(command+['true'],capture_output=True,timeout=15)
                if ready.returncode==0:break
                time.sleep(2)
            if ready.returncode:raise RuntimeError('AUDIT_SSH_UNAVAILABLE')
            source=(ROOT/'scripts/production/snapshot-diagnostics.py').read_text()
            result=subprocess.run(command+['python3 -c '+shlex.quote(source)],capture_output=True,timeout=180)
            if result.returncode:raise RuntimeError('AUDIT_DIAGNOSTICS_FAILED')
            report['inspection']=json.loads(result.stdout)
    except Exception as error:
        report['errorType']=type(error).__name__
        allowed={'AUDIT_REQUIRES_NEW_STATE','NO_BOUNDED_AUDIT_CAPACITY','INVALID_RUNNER_ADDRESS','AUDIT_SSH_UNAVAILABLE','AUDIT_DIAGNOSTICS_FAILED'}
        if str(error) in allowed:report['failureCode']=str(error)
    finally:
        try:report['cleanupPassed']=cleanup(run_id)
        except Exception as error:report['cleanupErrorType']=type(error).__name__
        (output/'snapshot-audit.json').write_text(json.dumps(report,indent=2)+'\n')
        print(json.dumps(report))
    if not report.get('inspection') or not report['cleanupPassed']:raise SystemExit(4)

if __name__=='__main__':main()
