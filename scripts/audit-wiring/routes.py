import re, pathlib, json, collections
root = pathlib.Path(__file__).resolve().parents[2]
def files(globs):
    for g in globs:
        for p in root.glob(g):
            if 'node_modules' in p.parts or p.name.endswith('.test.ts') or p.name.endswith('.test.tsx'): continue
            yield p
# Server-Routen
routes = collections.defaultdict(set)
for p in files(['server/**/*.ts', 'server/**/*.js', 'server/*.ts']):
    t = p.read_text(errors='replace')
    for m in re.finditer(r"\b(?:app|router|r)\.(get|post|put|delete|patch|all|use)\(\s*['\"`](/[^'\"`]+)['\"`]", t):
        routes[m.group(2)].add(m.group(1))
def norm(path):
    path = path.split('?')[0]
    path = re.sub(r'\$\{[^}]+\}', ':x', path)
    return path.rstrip('/') or '/'
route_patterns = [(re.compile('^' + re.sub(r':[A-Za-z_]+', '[^/]+', re.sub(r'\*', '.*', norm(r))) + '$'), r) for r in routes]
# Client-Aufrufe
calls = collections.defaultdict(set)
for p in files(['src/**/*.ts', 'src/**/*.tsx']):
    t = p.read_text(errors='replace')
    for m in re.finditer(r"['\"`](/api/[^'\"`\s]+)['\"`]", t):
        calls[norm(m.group(1))].add(str(p.relative_to(root)))
missing = {}
for c, where in calls.items():
    c2 = re.sub(r':x', 'X', c)
    if not any(rx.match(c2) or rx.match(c) for rx, _ in route_patterns):
        # Prefix-Router (app.use('/api/x', router)) beruecksichtigen
        if not any(c.startswith(norm(r)) and 'use' in routes[r] for r in routes):
            missing[c] = sorted(where)[:3]
used_routes = {r for r in routes if r.startswith('/api') and any(rx.match(re.sub(':x', 'X', c)) or rx.match(c) for c in calls for rx, rr in route_patterns if rr == r)}
unused = sorted(r for r in routes if r.startswith('/api') and r not in used_routes)
print(json.dumps({'serverRoutes': len(routes), 'clientCalls': len(calls), 'clientCallsWithoutRoute': missing,
                  'apiRoutesNeverCalledFromSrc': unused[:80], 'unusedCount': len(unused)}, indent=1, ensure_ascii=False))
