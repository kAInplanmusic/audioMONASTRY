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
print(json.dumps({'buildDiagnostics':[line[:500] for line in selected[-18:]],
                  'timerUnits':timer_units,'idleThresholds':idle_config}))
