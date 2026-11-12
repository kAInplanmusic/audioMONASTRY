"""Read allowlisted watchdog metadata from an isolated snapshot copy."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess

def run(command):
    return subprocess.run(command,capture_output=True,text=True,timeout=60).stdout

def paths(text):
    return sorted(set(re.findall(r'/(?:root|opt|home|usr/local|etc|var/lib/cloud)/[A-Za-z0-9_./+-]+\.(?:py|sh)',text)))

def facts(path):
    try:raw=Path(path).read_bytes()[:2*1024*1024]
    except OSError:return {'path':str(path),'readable':False}
    text=raw.decode(errors='replace')
    return {'path':str(path),'sha256':hashlib.sha256(raw).hexdigest(),
        'hasDeployLock':'audiomonastry-deploy.lock' in text,
        'hasBootIdentity':'boot_id' in text,'hasIdleSignal':'idle-signal' in text,
        'callsFleetTeardown':'fleet-teardown' in text or 'delete-fleet' in text,
        'callsHetzner':'api.hetzner.cloud' in text,'referencedScripts':paths(text)}

report={'readOnlyInspection':True}
units=run(['systemctl','list-unit-files','--no-pager','--no-legend']).splitlines()
selected=[line.split()[0] for line in units if line and re.search(r'audiomonastry|brain|watch|fleet|idle|teardown',line.split()[0],re.I)]
report['units']={}
references=set()
for unit in selected:
    detail=run(['systemctl','show',unit,'--property=User,PrivateTmp,ActiveState,MainPID,ExecMainStartTimestamp,Result,FragmentPath,DropInPaths,OnCalendar'])
    command=run(['systemctl','show',unit,'--property=ExecStart','--value'])
    refs=paths(command);references.update(refs)
    report['units'][unit]={'properties':detail.splitlines(),'scriptPaths':refs}

sources=[Path('/etc/crontab'),Path('/etc/anacrontab'),Path('/etc/rc.local')]
for root in ('/etc/cron.d','/etc/cron.hourly','/etc/cron.daily','/etc/cron.weekly','/var/spool/cron','/var/lib/cloud/scripts'):
    sources += [path for path in Path(root).rglob('*') if path.is_file()]
report['cronAndBootEntries']=[]
for path in sources:
    try:text=path.read_text(errors='replace')
    except OSError:continue
    for number,line in enumerate(text.splitlines(),1):
        if line.lstrip().startswith('#') or not re.search(r'audiomonastry|hetzner|hcloud|fleet|idle|teardown|shutdown',line,re.I):continue
        refs=paths(line);references.update(refs)
        parts=line.split();schedule=' '.join(parts[:5])
        report['cronAndBootEntries'].append({'source':str(path),'line':number,'scriptPaths':refs,
            'schedule':schedule if len(parts)>=5 and re.fullmatch(r'[0-9*/,. -]+',schedule) else None,
            'rebootEntry':line.lstrip().startswith('@reboot')})

for root in ('/root','/opt','/home'):
    for directory,folders,files in os.walk(root):
        folders[:]=[name for name in folders if name not in ('node_modules','.git','.cache','.venv','site-packages','.venv-vast-acceptance','media')]
        for name in files:
            if name in ('fleet-idle-teardown.py','fleet-teardown.py','idle-check.sh','audiomonastry-idle-check.sh'):
                references.add(str(Path(directory)/name))
report['watchdogScripts']=[facts(path) for path in sorted(references)]
raw=run(['journalctl','--since=-2h','-n','20000','-o','json','--no-pager'])
events=[]
for line in raw.splitlines():
    try:row=json.loads(line)
    except ValueError:continue
    message=row.get('MESSAGE','')
    if re.fullmatch(r'\[idle-watch\] (?:Deploy laeuft .*|IDLE bestaetigt .*|TEARDOWN .*|App seit .*|App nicht erreichbar/Signal unlesbar .*|Keine app-1 gefunden .*)',message):
        events.append({'unit':row.get('_SYSTEMD_UNIT'),'identifier':row.get('SYSLOG_IDENTIFIER'),
            'timestampUs':row.get('__REALTIME_TIMESTAMP'),'event':message})
report['decisions']=[row for row in events if 'Deploy laeuft' not in row['event']][-100:]
report['maintenanceEventCount']=sum('Deploy laeuft' in row['event'] for row in events)
print(json.dumps(report))
