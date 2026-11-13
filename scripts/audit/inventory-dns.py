#!/usr/bin/env python3
"""Read-only DNS evidence for every dotted candidate in tracked docs/Compose.

No TLD allowlist: the deliberately broad superset also includes filenames and
code identifiers. Only dig performs DNS resolution. No .env file is read.
"""
import concurrent.futures
import datetime
import json
from pathlib import Path
import re
import shlex
import subprocess
import sys

binary = str(Path(sys.argv[1]).resolve())
library_dir = str(Path(sys.argv[2]).resolve())
registry = Path('EVIDENCE_REGISTRY.json')
entries = json.loads(registry.read_text())
if any(entry['id'].startswith('R2-A1-DNS-') for entry in entries):
    sys.exit('This immutable DNS snapshot already exists; use a new run ID for a new snapshot.')
selected_files = [name for name in subprocess.check_output(['git', 'ls-files'], text=True).splitlines()
         if (name.startswith('docs/') or name.endswith(('.md', '.rst', '.txt')) or 'compose' in Path(name).name)
         and '.env' not in Path(name).name]
pattern = re.compile(r'(?<![\w@.-])(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}(?![\w.-])')
candidates = {}
files = []
for name in selected_files:
    try:
        lines = Path(name).read_text().splitlines()
    except (UnicodeError, IsADirectoryError):
        continue
    files.append(name)
    for number, line in enumerate(lines, 1):
        for match in pattern.finditer(line):
            candidates.setdefault(match.group().lower(), []).append(f'{name}:{number}')
now = lambda: datetime.datetime.now(datetime.timezone.utc).isoformat()
entries.append(dict(id='R2-A1-DNS-SCOPE', task='A1',
    claim='Complete tracked documentation/Compose corpus and dotted-candidate superset; filenames/code identifiers retained, no TLD allowlist. No .env read.',
    command=shlex.join(['python3', 'scripts/audit/inventory-dns.py', binary, library_dir]),
    output=json.dumps({'files': files, 'file_count': len(files), 'candidate_count': len(candidates), 'sources': candidates}, ensure_ascii=False, indent=2),
    date=now(), source='Git tracked documentation and Compose, file:line references'))
env = {'LD_LIBRARY_PATH': library_dir}

def lookup(item):
    index, (name, sources) = item
    outputs = []
    commands = []
    date = now()
    for kind, flags in ((kind, flags) for kind in ('A', 'AAAA', 'CNAME') for flags in (['+short'], ['+noall', '+comments'])):
        argv = [binary, '+time=2', '+tries=1', *flags, kind, name]
        commands.append('LD_LIBRARY_PATH=' + shlex.quote(library_dir) + ' ' + shlex.join(argv))
        result = subprocess.run(argv, env=env, text=True, capture_output=True, timeout=10)
        outputs.append(f'{kind} {flags}: exit_code={result.returncode}\nstdout:\n{result.stdout or "[empty]"}\nstderr:\n{result.stderr or "[empty]"}')
    return dict(id=f'R2-A1-DNS-{index:04d}', task='A1',
                claim=f'Live dig A/AAAA/CNAME for dotted candidate {name}; not an account inventory or proof of an owned host',
                command='\n'.join(commands), output='\n'.join(outputs), date=date,
                source='; '.join(sources))

with concurrent.futures.ThreadPoolExecutor(max_workers=24) as pool:
    results = list(pool.map(lookup, enumerate(sorted(candidates.items()), 1)))
entries.extend(results)
registry.write_text(json.dumps(entries, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({'date': now(), 'files': len(files), 'candidates': len(candidates), 'record_queries': len(candidates)*6,
                  'entries_added': len(results)+1, 'redaction': 'No secret values read; only DNS names and dig outputs saved.'}))
