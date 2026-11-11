"""Bounded eight-Pod HTTP test. Uses a dedicated prefix; always removes its Pods."""
import argparse
import base64
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
from types import SimpleNamespace
import sys
import time

ROOT=Path(__file__).resolve().parent.parent
sys.path.insert(0,str(ROOT/'services/audiomonastry-ai-runtime'))
import runtime_probe
spec=importlib.util.spec_from_file_location('pods',ROOT/'scripts/runpod-pods.py')
pods=importlib.util.module_from_spec(spec);spec.loader.exec_module(pods)
OUT=ROOT/'http-fleet-qa-output'
PREFIX='audiomonastry-http-qa-'

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--cleanup-only',action='store_true');args=parser.parse_args()
    fleet=pods.load_fleet();fleet['namePrefix']=PREFIX
    if args.cleanup_only:
        return pods.cmd_down(SimpleNamespace(yes=True),fleet)
    OUT.mkdir(exist_ok=True)
    report={'passed':False,'roles':[],'cleanupPassed':False}
    log=io.StringIO()
    def save(): (OUT/'validation.json').write_text(json.dumps(report,indent=2)+'\n')
    def request(pid,path,body=None,token=None):
        headers={'Authorization':'Bearer '+(os.environ['AI_POD_TOKEN'] if token is None else token)}
        if body is not None:headers['Content-Type']='application/json'
        status,raw=pods.transport('POST' if body is not None else 'GET',pods.proxy_url(pid,fleet['port'])+path,
                                  headers,None if body is None else json.dumps(body).encode(),180)
        return status,json.loads(raw) if raw else {}
    try:
        with contextlib.redirect_stdout(log),contextlib.redirect_stderr(log):
            if pods.fleet_pods(fleet):raise RuntimeError('Existing HTTP QA resources require cleanup first')
            code=pods.cmd_up(SimpleNamespace(only='',yes=True,wait=1200),fleet,pods.load_models())
            if code:raise RuntimeError('Eight-role startup did not pass: exit '+str(code))
            running={p['name'][len(PREFIX):]:p['id'] for p in pods.fleet_pods(fleet)}
            specs=fleet['pods']+[fleet['visPod']]
            if len(running)!=8:raise RuntimeError('Expected eight simultaneous Pods')
            for role in specs:
                pid=running[role['role']];row={'role':role['role'],'passed':False};report['roles'].append(row);save()
                status,info=request(pid,'/ready');row['ready']=status==200
                unauth,_=request(pid,'/models',token='invalid-qa-token');row['rejectsInvalidToken']=unauth==401
                status,info=request(pid,'/models');loaded={m['id']:m for m in info.get('models',[])}
                expected=role['models'];row['residentModels']=len(expected)
                row['allResident']=status==200 and all(loaded.get(m,{}).get('loaded') for m in expected)
                model=expected[0];definition=SimpleNamespace(task=pods.load_models()[model]['task'])
                task,payload=runtime_probe.request(model,definition)
                started=time.monotonic();status,data=request(pid,'/infer',{'task':task,'model':model,'input':payload})
                result=data.get('result') or {};row['model']=model;row['httpStatus']=status;row['wallSeconds']=round(time.monotonic()-started,3)
                valid=status==200 and data.get('status')=='success' and bool(result)
                sources=result.get('stems') or ({'audio':result['audioBase64']} if result.get('audioBase64') else {})
                if sources:
                    import numpy as np
                    import soundfile as sf
                    for value in sources.values():
                        audio,rate=sf.read(io.BytesIO(base64.b64decode(value,validate=True)))
                        valid=valid and audio.size>0 and bool(np.isfinite(audio).all()) and rate>0
                row['passed']=valid and row['ready'] and row['allResident'] and row['rejectsInvalidToken'];save()
            report['passed']=len(report['roles'])==8 and all(r['passed'] for r in report['roles'])
    except Exception as exc:
        report['error']=type(exc).__name__+': '+str(exc)[:1000]
    finally:
        with contextlib.redirect_stdout(log),contextlib.redirect_stderr(log):
            try:report['cleanupPassed']=pods.cmd_down(SimpleNamespace(yes=True),fleet)==0
            except Exception:report['cleanupPassed']=False
        diagnostic=log.getvalue()
        for name,value in os.environ.items():
            if any(k in name.upper() for k in ('KEY','TOKEN','SECRET','PASSWORD')) and len(value)>8:diagnostic=diagnostic.replace(value,'[REDACTED]')
        diagnostic=re.sub(r'https?://\S+','[URL]',diagnostic)
        (OUT/'startup.log').write_text(diagnostic)
        save()
    print(json.dumps(report))
    return 0 if report['passed'] and report['cleanupPassed'] else 1

if __name__=='__main__':raise SystemExit(main())
