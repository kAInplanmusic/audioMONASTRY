#!/usr/bin/env python3
"""Validate real GPU job envelopes and audio outputs; measure, never invent listening scores."""
from __future__ import annotations
import argparse
import base64
import hashlib
import io
import json
from pathlib import Path
import re
import shutil
import numpy as np
import soundfile as sf


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory',type=Path,required=True)
    parser.add_argument('--out',type=Path,required=True)
    parser.add_argument('--audio-dir',type=Path,required=True)
    args=parser.parse_args()
    args.audio_dir.mkdir(parents=True,exist_ok=True)
    reference_path=args.directory/'synthetic-input.wav'
    reference,reference_sr=sf.read(reference_path,dtype='float32',always_2d=True)
    shutil.copyfile(reference_path,args.audio_dir/'synthetic-input.wav')
    rows=[]
    for file in sorted(args.directory.glob('*.json')):
        data=json.loads(file.read_text())
        if 'output' not in data:
            continue
        output=data['output']; qa=output.get('qa',{}); inference=output.get('inference',{})
        model=file.stem
        row={'model':model,'jobStatus':data.get('status'),'inferenceStatus':inference.get('status'),
             'gpu':qa.get('gpu'),'cuda':qa.get('cudaRuntime'),'torch':qa.get('torch'),
             'handlerWallSeconds':qa.get('wallSeconds'),'queueDelayMs':data.get('delayTime'),
             'jobExecutionMs':data.get('executionTime'),
             'processPeakAllocatedBytes':qa.get('peakAllocatedBytes'),
             'processPeakReservedBytes':qa.get('peakReservedBytes'),
             'passed':False,'audio':{}}
        if data.get('status')!='COMPLETED' or inference.get('status')!='success' or qa.get('cudaAvailable') is not True:
            row['error']=inference.get('detail') or inference.get('message') or data.get('error') or output.get('qaError')
            rows.append(row);continue
        result=inference.get('result',{})
        sources=result.get('stems') or ({'audio':result['audioBase64']} if result.get('audioBase64') else {})
        if not isinstance(sources,dict) or not sources:
            row['error']='No audio outputs';rows.append(row);continue
        audio_arrays=[]
        for stem,value in sources.items():
            raw=base64.b64decode(value,validate=True)
            info=sf.info(io.BytesIO(raw))
            audio,sr=sf.read(io.BytesIO(raw),dtype='float32',always_2d=True)
            if not audio.size or not np.isfinite(audio).all() or (result.get('sampleRate') is not None and sr!=result['sampleRate']):
                raise RuntimeError(f'{model}/{stem}: empty, nonfinite or inconsistent WAV')
            if model in ('universr','yue2-3b') and sr!=48000:
                raise RuntimeError(f'{model}: output must be 48 kHz')
            safe=re.sub(r'[^a-zA-Z0-9_.-]','_',stem)
            extension={'WAV':'wav','FLAC':'flac'}.get(info.format)
            if extension is None:
                raise RuntimeError(f'{model}: unexpected audio container {info.format}')
            (args.audio_dir/(model+'-'+safe+'.'+extension)).write_bytes(raw)
            row['audio'][stem]={'sampleRate':sr,'channels':audio.shape[1],'samples':audio.shape[0],
                'format':info.format,'subtype':info.subtype,
                'seconds':round(audio.shape[0]/sr,6),'rms':float(np.sqrt(np.mean(audio.astype(np.float64)**2))),
                'peak':float(np.max(np.abs(audio))),'aboveFullScaleRatio':float(np.mean(np.abs(audio)>1)),
                'atFullScaleRatio':float(np.mean(np.abs(audio)>=0.9999)),
                'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest()}
            audio_arrays.append(audio)
        if model in ('mvsep-mega-53','mel-roformer-bve','mel-roformer-dereverb'):
            expected=5 if model=='mvsep-mega-53' else 2
            if len(audio_arrays)!=expected or any(x.shape!=reference.shape for x in audio_arrays):
                raise RuntimeError(f'{model}: stem count or sample alignment differs')
            reconstructed=sum(x.astype(np.float64) for x in audio_arrays)
            difference=reconstructed-reference
            error=float(np.sqrt(np.mean(difference**2)))
            row['reconstructionRmsError']=error
            row['reconstructionMaxError']=float(np.max(np.abs(difference)))
            if error>1e-5:
                raise RuntimeError(f'{model}: mixture reconstruction mismatch')
        row['nativeModelStemCount']=len(result.get('modelStems',[]))
        if model=='mvsep-mega-53' and row['nativeModelStemCount']!=53:
            raise RuntimeError('Mega checkpoint/config does not expose 53 native stems')
        row['passed']=True
        rows.append(row)
    report={'scope':'Real inference and numerical audio validation; synthetic input, no subjective listening score',
            'processMemoryNote':'Process peaks may include models cached from previous jobs in that worker.',
            'models':rows,'passed':bool(rows) and all(r['passed'] for r in rows)}
    args.out.parent.mkdir(parents=True,exist_ok=True)
    args.out.write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps({'passed':report['passed'],'models':[(r['model'],r['passed']) for r in rows]}))
    return 0 if report['passed'] else 1

if __name__=='__main__':
    raise SystemExit(main())
