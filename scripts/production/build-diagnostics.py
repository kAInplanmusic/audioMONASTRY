"""Allowlisted, credential-redacted excerpts from the private build log only."""
import json
from pathlib import Path
import re
import subprocess

path=Path('/var/log/audiomonastry-production-deploy.log')
text=path.read_text(errors='replace') if path.exists() else ''
env=Path('/opt/audiomonastry/.env')
if env.exists():
    values=[line.split('=',1)[1].strip().strip('\"\'') for line in env.read_text().splitlines() if '=' in line and not line.startswith('#')]
    for value in sorted(values,key=len,reverse=True):
        if len(value)>=8:text=text.replace(value,'[redacted]')
text=re.sub(r'https?://[^\s\"\'<>]+','[url]',text)
text=re.sub(r'[A-Za-z0-9_./+=-]{28,}','[redacted]',text)
selected=[line for line in text.splitlines() if re.search(r'error|failed|fatal|killed|space|not found|exit code',line,re.I)]
timers = subprocess.run(['systemctl','list-timers','--all','--no-pager','--no-legend'],capture_output=True,text=True)
timer_units = [line.split()[-2:] for line in timers.stdout.splitlines()
               if 'audiomonastry' in line and len(line.split()) >= 2]
idle_config = {}
for config_path in (env, Path('/etc/audiomonastry/idle-check.env')):
    if not config_path.exists():
        continue
    for line in config_path.read_text().splitlines():
        key, _, value = line.partition('=')
        if key in ('IDLE_MINUTES','IDLE_SHUTDOWN_MINUTES') and re.fullmatch(r'[0-9.]+',value):
            idle_config[config_path.name + ':' + key] = value
units=subprocess.run(['systemctl','list-unit-files','--no-pager','--no-legend'],capture_output=True,text=True).stdout
watchdogs=[line.split()[0] for line in units.splitlines() if line and
    re.fullmatch(r'[a-zA-Z0-9@_.-]+',line.split()[0]) and
    any(word in line.split()[0] for word in ('idle','fleet','teardown')) and line.split()[0].endswith('.service')]
details={unit:subprocess.run(['systemctl','show',unit,
    '--property=User,PrivateTmp,ActiveState,MainPID,ExecMainStartTimestamp,Result'],capture_output=True,text=True).stdout.splitlines() for unit in watchdogs}
lock=Path('/tmp/audiomonastry-deploy.lock')
try:
    import os
    pid=int(lock.read_text());os.kill(pid,0);lock_live=True
except Exception:lock_live=False
events=[]
for unit in watchdogs:
    result=subprocess.run(['journalctl','-u',unit,'-n','120','-o','json','--no-pager'],capture_output=True,text=True)
    for line in result.stdout.splitlines():
        try:row=json.loads(line)
        except ValueError:continue
        message=row.get('MESSAGE','')
        if re.fullmatch(r'\[idle-watch\] (?:Deploy laeuft .*|IDLE bestaetigt .*|TEARDOWN .*|App seit .*|App nicht erreichbar/Signal unlesbar .*|Keine app-1 gefunden .*)',message):
            events.append({'unit':unit,'timestampUs':row.get('__REALTIME_TIMESTAMP'),'event':message})
print(json.dumps({'buildDiagnostics':[line[:500] for line in selected[-18:]],
                  'timerUnits':timer_units,'idleThresholds':idle_config,
                  'watchdogUnits':details,'liveMaintenanceLock':lock_live,'watchdogEvents':events[-60:]}))
