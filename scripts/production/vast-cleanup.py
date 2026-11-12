"""Independent cleanup for the explicitly bounded production acceptance fleet."""
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT=Path('/opt/audiomonastry')
state=Path(sys.argv[1]).resolve()
assert state.parent==Path('/var/lib/audiomonastry-vast') and state.name.startswith('acceptance-')
for line in (ROOT/'.env').read_text().splitlines():
    if '=' in line and not line.startswith('#'):
        key,value=line.split('=',1)
        if key.strip()=='VAST_API_KEY':os.environ['VAST_API_KEY']=value.strip().strip('\"\'')
code=subprocess.run([sys.executable,ROOT/'scripts/vast-pods.py','down','--yes','--state-dir',state],cwd=ROOT).returncode
backup=state/'app.env.before'
files=state/'app-compose.json'
if backup.exists() and files.exists():
    (ROOT/'.env').write_bytes(backup.read_bytes())
    (ROOT/'.env').chmod(0o600)
    args=['docker','compose']
    for item in json.loads(files.read_text()):
        path=Path(item).resolve()
        assert path.is_relative_to(ROOT) or path.is_relative_to(state)
        args+=['-f',str(path)]
    result=subprocess.run(args+['up','-d','--no-build','audiomonastry'],cwd=ROOT)
    if result.returncode:code=2
raise SystemExit(code)
