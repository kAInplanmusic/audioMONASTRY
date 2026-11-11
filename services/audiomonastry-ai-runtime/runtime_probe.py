"""Small real model probes used to make resident readiness truthful."""
import base64
import io
import json
import wave


def fixture():
    import numpy as np
    sr=44100
    t=np.arange(sr*4)/sr
    x=.15*np.sin(2*np.pi*220*t)+.08*np.sin(2*np.pi*440*t)
    out=io.BytesIO()
    with wave.open(out,'wb') as f:
        f.setnchannels(2);f.setsampwidth(2);f.setframerate(sr)
        f.writeframes((np.stack([x,x],axis=1)*32767).astype('<i2').tobytes())
    return base64.b64encode(out.getvalue()).decode()


def request(model_id, definition):
    payload={'audioBase64':fixture()}
    if model_id=='qwen3-4b':
        payload={'instruction':'Set the tempo to 120 BPM.','allowedCommands':['transport.setTempo']}
    elif model_id=='qwen38-27b-fp8':
        payload={'prompt':'Name one acoustic instrument.','enableThinking':False,'maxTokens':16}
    elif model_id.startswith('qwen3-tts'):
        payload={'text':'Guten Morgen.','language':'German','speaker':'Ryan','instruct':'A clear warm adult voice.'}
    elif model_id.startswith('acestep'):
        payload={'prompt':'A short acoustic instrumental.','durationSeconds':10,'inferenceSteps':4,'maxTokens':16}
    elif model_id=='moss-soundeffect-v2.0':
        payload={'prompt':'A bell rings once.','durationSeconds':1,'steps':2}
    elif model_id=='yue2-3b':
        payload={'style':'A short acoustic song.','lyrics':'[Verse]\nMorning light.','planning':'off','maxSemanticTokens':64}
    elif model_id=='moss-music-8b-instruct':
        payload.update(question='Describe this audio briefly.',maxTokens=64)
    elif model_id=='sonicmaster':
        payload.update(prompt='Enhance the clarity.',inferenceSteps=2)
    return definition.task, payload


def load_verified(model_id, definition):
    from handlers import run_inference
    task, payload=request(model_id,definition)
    result=run_inference(task,model_id,definition,payload)
    if not isinstance(result,dict) or not result:
        raise RuntimeError(model_id+': empty startup inference result')
    # Decode actual outputs; corrupt audio cannot make a role ready.
    sources=result.get('stems') or ({'audio':result['audioBase64']} if result.get('audioBase64') else {})
    if sources:
        import numpy as np
        import soundfile as sf
        for value in sources.values():
            data,rate=sf.read(io.BytesIO(base64.b64decode(value,validate=True)))
            if not data.size or not np.isfinite(data).all() or rate<=0:
                raise RuntimeError(model_id+': invalid startup audio')
    return {'verifiedInference':True,'model':model_id}
