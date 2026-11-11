#!/usr/bin/env python3
"""Run bounded real GPU QA on one temporary scale-to-zero endpoint, then delete it."""
from __future__ import annotations
import argparse
import base64
import io
import json
import math
import os
from pathlib import Path
import sys
import time
import urllib.error
import urllib.request
import wave

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'scripts'))
import importlib.util
spec = importlib.util.spec_from_file_location('fleet_probe', ROOT / 'scripts/runpod-fleet-probe.py')
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


def api(method, path, body=None, *, inference=False):
    key = (os.environ.get('RUNPOD_API_KEY') or os.environ.get('RP_API_KEY') or '').strip()
    if not key:
        raise RuntimeError('Runpod API key missing')
    base = 'https://api.runpod.ai/v2' if inference else 'https://api.runpod.io/v2'
    req = urllib.request.Request(base + path,
        data=None if body is None else json.dumps(body).encode(),
        headers={'Authorization': 'Bearer '+key, 'Content-Type': 'application/json'}, method=method)
    try:
        with urllib.request.urlopen(req, timeout=45) as response:
            raw = response.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f'Runpod {method} request HTTP {exc.code}') from None
    except Exception:
        # Never expose a request URL or a credential-bearing response body.
        raise RuntimeError('Runpod request failed; no automatic mutation retry') from None


def fixture():
    import numpy as np
    sr = 44100
    t = np.arange(sr*4) / sr
    x = (.15*np.sin(2*np.pi*220*t) + .12*np.sin(2*np.pi*440*t) + .06*np.sin(2*np.pi*880*t))
    for frame in range(0, len(x)-1000, sr//2):
        x[frame:frame+1000] += .3*np.exp(-np.arange(1000)/150) * np.sin(2*np.pi*3000*np.arange(1000)/sr)
    pcm = (np.stack([x, x*.97], axis=1)*32767).astype('<i2').tobytes()
    out=io.BytesIO()
    with wave.open(out,'wb') as wav:
        wav.setnchannels(2);wav.setsampwidth(2);wav.setframerate(sr);wav.writeframes(pcm)
    return out.getvalue()


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', required=True)
    parser.add_argument('--outdir', type=Path, required=True)
    parser.add_argument('--execute', action='store_true')
    args=parser.parse_args()
    args.outdir.mkdir(parents=True, exist_ok=True)
    baseline=probe.probe()
    if not baseline['budgetVerified']:
        raise RuntimeError('Existing fleet cost not verified')
    catalog=api('GET','/catalog/gpus?include=AVAILABILITY&product=SERVERLESS')['gpus']
    gpu=next(g for g in catalog if g['id']=='NVIDIA L40S')
    if not gpu.get('pool') or gpu.get('availability')=='NONE':
        raise RuntimeError('L40S serverless pool unavailable')
    rate=float(gpu['price']['serverless'])
    if not math.isfinite(rate) or rate<=0:
        raise RuntimeError('Invalid GPU quote')
    budget=json.loads((ROOT/'deploy/runpod/pod-fleet.json').read_text())['budget']
    gross=baseline['existingEstimatedGrossEurPerHour']+rate*budget['usdToEur']*budget['taxMultiplier']
    if gross>budget['maxEurPerHour']:
        raise RuntimeError('Fleet budget exceeded')
    # Source is committed QA code. No provider or registry keys enter the worker.
    body={'name':'audiomonastry-ephemeral-weight-qa', 'image':args.image, 'type':'QUEUE',
          'disk':60, 'timeout':300000, 'flashboot':'OFF',
          'gpu':{'pools':[gpu['pool']], 'count':1, 'minCudaVersion':'12.6',
                 'excludedTypes':[g['id'] for g in catalog if g.get('pool')==gpu['pool'] and g['id']!=gpu['id']]},
          'scaling':{'type':'QUEUE_DELAY','queueDelay':.5},
          'workers':{'min':0,'max':1,'idleTimeout':5},
          'entrypoint':['python','-u','-c',(ROOT/'scripts/runpod-gpu-qa-worker.py').read_text()], 'cmd':[],
          'env':{'AI_DEBUG_DETAIL':'1','NUMBA_CACHE_DIR':'/data/numba-cache','HF_HOME':'/data/hf-cache'}}
    plan={'createdResources':0,'gpu':gpu['id'],'workerMax':1,'idleTimeout':5,
          'workerQuoteUsdPerHour':rate,'estimatedFleetGrossEurPerHour':round(gross,4),
          'jobExecutionLimitSeconds':300,'jobTtlSeconds':1200,'image':args.image}
    (args.outdir/'plan.json').write_text(json.dumps(plan,indent=2)+'\n')
    print(json.dumps(plan),flush=True)
    if not args.execute:
        return
    endpoint=None
    registry=os.environ.get('QA_REGISTRY_ID')
    if not registry:
        raise RuntimeError('Existing QA_REGISTRY_ID required; this test never creates registry credentials')
    known=api('GET','/registries')['registries']
    if registry not in {r['id'] for r in known}:
        raise RuntimeError('Configured registry credential is not available')
    body['registry']=registry
    try:
        created=api('POST','/serverless',body)
        endpoint=created['id']
        (args.outdir/'resources.json').write_text(json.dumps({'endpointId':endpoint,'deleted':False}))
        wav=fixture();(args.outdir/'synthetic-input.wav').write_bytes(wav)
        encoded=base64.b64encode(wav).decode()
        jobs={}
        for model in ['mvsep-mega-53','mel-roformer-bve','mel-roformer-dereverb']:
            data={'input':{'task':'stem.separate','model':model,'input':{'audioBase64':encoded}},
                  'policy':{'executionTimeout':300000,'ttl':1200000}}
            response=api('POST','/'+endpoint+'/run',data,inference=True)
            jobs[response['id']]=model
            (args.outdir/'jobs.json').write_text(json.dumps(jobs,indent=2))
        deadline=time.monotonic()+1200
        pending=dict(jobs)
        while pending and time.monotonic()<deadline:
            for job,model in list(pending.items()):
                result=api('GET','/'+endpoint+'/status/'+job,inference=True)
                if result.get('status') in ('COMPLETED','FAILED','CANCELLED','TIMED_OUT'):
                    (args.outdir/(model+'.json')).write_text(json.dumps(result))
                    print(model,result['status'],flush=True)
                    del pending[job]
            if pending:
                time.sleep(20)
        if pending:
            for job in pending:
                api('POST','/'+endpoint+'/cancel/'+job,{},inference=True)
            raise RuntimeError('QA deadline reached; pending jobs cancelled')
    finally:
        if endpoint:
            api('DELETE','/serverless/'+endpoint)
            (args.outdir/'resources.json').write_text(json.dumps({'endpointId':endpoint,'deleted':True}))
            print('Temporary endpoint deleted; existing registry credential unchanged',flush=True)


if __name__=='__main__':
    main()
