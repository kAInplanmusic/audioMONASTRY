"""Read pinned R2/HF byte metadata only; never downloads model payloads."""
import os,sys,json,importlib.util,urllib.request,urllib.parse,fnmatch
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
root=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('vp',root/'scripts/vast-pods.py');v=importlib.util.module_from_spec(spec);spec.loader.exec_module(v)
f,m=v.shared.load_fleet(),v.shared.load_models();target=v.shared.s3lite.S3Target.from_r2_env()
manifest=json.load(open(root/'services/audiomonastry-ai-runtime/model_manifest.json'));lock=json.load(open(root/'services/audiomonastry-ai-runtime/weight_assets.lock.json'))['models']
def hf(repo,rev,patterns=None):
 req=urllib.request.Request('https://huggingface.co/api/models/'+repo+'/revision/'+rev+'?blobs=true',headers={'Authorization':'Bearer '+os.environ['HF_TOKEN']})
 with urllib.request.urlopen(req,timeout=60) as r:d=json.load(r)
 assert d['sha']==rev
 files=[x for x in d['siblings'] if patterns is None or any(fnmatch.fnmatch(x['rfilename'],p) for p in patterns)]
 assert files and all(isinstance(x.get('size'),int) for x in files)
 return sum(x['size'] for x in files)
def one(p):
 entries,missing=v.shared.weight_entries(p,m,target,f['weights']['prefix'],3600)
 assert not missing,missing
 n=sum(x['size'] for x in entries);parts={'r2Bytes':n}
 for mid in p['models']:
  a=m[mid]
  if a.get('directRepo') and mid not in lock and a.get('revision') not in ['cpu-only']:
   parts[mid]=hf(a['repository'],a['revision'])
  for c in a.get('weightComponents',[]):
   if c not in lock:
    a=manifest['weightComponents'][c];parts[c]=hf(a['repository'],a['revision'],a.get('allowPatterns'))
 # Include all auxiliary lock assets conservatively even if counted via R2.
 for mid in p['models']:
  for c in [mid,*m[mid].get('weightComponents',[])]:
   a=lock.get(c,{})
   if not a.get('package'):parts['locked:'+c]=sum(z['size'] for z in a.get('files',[]))
 if p['role']=='studio':
  for c in ['sonicmaster-text','sonicmaster-vae']:
   a=manifest['weightComponents'][c];parts[c]=hf(a['repository'],a['revision'],a.get('allowPatterns'))
 return p['role'],{'parts':parts,'weightBytesUpperBound':sum(parts.values())}
with ThreadPoolExecutor(max_workers=4) as ex:result=dict(ex.map(one,f['pods']+[f['visPod']]))
import argparse,hashlib
from datetime import datetime,timezone
p=argparse.ArgumentParser();p.add_argument('--output',type=Path,required=True);args=p.parse_args()
result={'observedAt':datetime.now(timezone.utc).isoformat(),'manifestSha256':hashlib.sha256((root/'services/audiomonastry-ai-runtime/model_manifest.json').read_bytes()).hexdigest(),'lockSha256':hashlib.sha256((root/'services/audiomonastry-ai-runtime/weight_assets.lock.json').read_bytes()).hexdigest(),'roles':result}
args.output.write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({r:round(x['weightBytesUpperBound']/1e9,3) for r,x in result['roles'].items()}))
