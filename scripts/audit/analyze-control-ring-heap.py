"""Summarize protected local snapshots without exporting arbitrary heap strings."""
from collections import Counter, deque
import hashlib
import json
from pathlib import Path
import sys
root = Path(sys.argv[1])
WATCH = {'ControlRing', 'Float64Array', 'Float32Array', 'Int32Array', 'SharedArrayBuffer', 'ArrayBuffer'}

def snapshot(path):
    data = json.loads(path.read_text()); meta=data['snapshot']['meta']; fields=meta['node_fields']; width=len(fields)
    rows=data['nodes']; strings=data['strings']; types=meta['node_types'][fields.index('type')]; stats=Counter(); sizes=Counter(); instances=[]
    for i in range(0,len(rows),width):
        typ=types[rows[i+fields.index('type')]]; name=strings[rows[i+fields.index('name')]]
        if typ=='object' and name in WATCH:
            stats[name]+=1;sizes[name]+=rows[i+fields.index('self_size')]
            if name=='ControlRing':instances.append(i//width)
    # Root-to-instance paths, never print object values or arbitrary strings.
    ef=meta['edge_fields']; ew=len(ef); et=meta['edge_types'][ef.index('type')]; edges=data['edges']; offsets=[]; at=0
    for i in range(0,len(rows),width):offsets.append(at);at+=rows[i+fields.index('edge_count')]*ew
    parents={0:None};q=deque([0]);targets=set(instances)
    while q and not targets <= parents.keys():
        n=q.popleft();start=offsets[n];end=start+rows[n*width+fields.index('edge_count')]*ew
        for j in range(start,end,ew):
            edge_type=et[edges[j+ef.index('type')]]
            if edge_type=='weak':continue
            to=edges[j+ef.index('to_node')]//width
            if to in parents:continue
            label=edges[j+ef.index('name_or_index')]
            label=str(label) if edge_type in ('element','hidden') else strings[label]
            parents[to]=(n,label,edge_type);q.append(to)
    paths=[]
    for n in instances:
        chain=[];node=n
        while parents.get(node) is not None:
            parent,label,typ=parents[node];chain.append({'edge':label,'type':typ});node=parent
        paths.append(list(reversed(chain)))
    return {'nodeCount':len(rows)//width,'watchedObjectCounts':dict(stats),'watchedSelfBytes':dict(sizes),'controlRingRootPaths':paths,'sha256':hashlib.sha256(path.read_bytes()).hexdigest()}

before=snapshot(root/'before.heapsnapshot');after=snapshot(root/'after.heapsnapshot')
profile=json.loads((root/'allocations.json').read_text())['profile'];stack=[profile['head']];frames=[]
while stack:
    row=stack.pop();frame=row['callFrame'];url=frame.get('url','');name=frame.get('functionName','')
    if 'controlRing' in url or name in ['consumeAll','getHeapStatistics']:
        frames.append({'function':name,'url':url,'line':frame.get('lineNumber',-1)+1,'sampledSelfBytes':row.get('selfSize',0)})
    stack.extend(row.get('children',[]))
result={'before':before,'after':after,'countDelta':{k:after['watchedObjectCounts'].get(k,0)-before['watchedObjectCounts'].get(k,0) for k in sorted(WATCH)},
        'allocationFrames':frames,'limits':'one isolated workload; sampling/snapshots influence GC/JIT; not a retained-leak proof for the original failing full test run'}
(root/'analysis.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2))
