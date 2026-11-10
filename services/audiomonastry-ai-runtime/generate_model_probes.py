"""Deterministic, secret-free inference fixtures for the 8-Pod SSOT.

Fixtures are deliberately generated *on the pod* at startup, avoiding secrets
and impossible local-file mounts in the RunPod API. An actual CUDA inference is
required by startup_model_proof.py; this module never fakes a model result.
"""
from __future__ import annotations
import base64
import io
import json
import math
import pathlib
import struct
import wave
import os
import tempfile

RUNTIME=pathlib.Path(__file__).resolve().parent
DEPENDENCIES={"acestep-v15-shared","acestep-5hz-lm-4b"}


def synthetic_audio(sr: int=16000, seconds: float=4.0) -> str:
    """Royalty-free generated test signal: 220Hz tone + 100-BPM pulses."""
    frames=int(sr*seconds)
    data=bytearray()
    for i in range(frames):
        t=i/sr
        pulse=max(0.0,1.0-((t*100/60)%1.0)*12.0)
        signal=.20*math.sin(2*math.pi*220*t)+.18*pulse*math.sin(2*math.pi*60*t)
        data.extend(struct.pack("<h",max(-32768,min(32767,int(signal*32767)))))
    buf=io.BytesIO()
    with wave.open(buf,"wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sr)
        wav.writeframes(data)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def fixture(mid: str, audio: dict) -> dict:
    text="A short original warm and rhythmic instrumental with plucked strings."
    if mid in ("qwen38-27b-fp8",):
        return {"kind":"text","requiredResultKeys":["text"],
                "input":{"prompt":"Reply with one short sentence about musical timing.","maxTokens":64}}
    if mid=="qwen3-4b":
        return {"kind":"structured","requiredResultKeys":["command"],
                "input":{"instruction":"Propose changing track volume to 0.5.",
                         "allowedCommands":["track.setVolume"]}}
    if mid=="moss-music-8b-instruct":
        return {"kind":"text","requiredResultKeys":["text"],
                "input":{**audio,"question":"What can you hear? Describe the beat."}}
    if mid=="clap-music":
        return {"kind":"structured","requiredResultKeys":["embedding"],"input":audio}
    if mid=="beat-this":
        return {"kind":"structured","requiredResultKeys":["beats"],"input":audio}
    if mid=="songformer":
        return {"kind":"structured","requiredResultKeys":["sections"],"input":audio}
    if mid=="dsp-analysis":
        return {"kind":"structured","requiredResultKeys":["rms","spectralCentroidHz"],"input":audio}
    if mid=="basic-pitch":
        return {"kind":"midi","requiredResultKeys":["midiBase64"],"input":audio}
    if mid=="qwen3-tts-17b":
        return {"kind":"audio","requiredResultKeys":["audioBase64"],
                "input":{"text":"Hallo, dies ist ein technischer Audiotest.","language":"German"}}
    if mid=="qwen3-tts-voicedesign":
        return {"kind":"audio","requiredResultKeys":["audioBase64"],
                "input":{"text":"Guten Tag.","language":"German",
                         "voiceDescription":"Calm warm adult narration, natural pace."}}
    if mid=="moss-soundeffect-v2.0":
        return {"kind":"audio","requiredResultKeys":["audioBase64"],
                "input":{"prompt":"A single short, dry wooden hand clap.","durationSeconds":5}}
    if mid=="acestep-v15-xl-base":
        return {"kind":"audio","requiredResultKeys":["audioBase64"],
                "input":{"aceTask":"lego","prompt":text,
                         "contextAudio":[{"id":"original-test","audioBase64":audio["audioBase64"]}],
                         "durationSeconds":8,"inferenceSteps":32}}
    if mid=="acestep-v15-xl-turbo":
        return {"kind":"audio","requiredResultKeys":["audioBase64"],
                "input":{"prompt":text,"durationSeconds":8,"inferenceSteps":8}}
    if mid=="sonicmaster":
        return {"kind":"audio","requiredResultKeys":["audioBase64"],
                "input":{**audio,"prompt":"Apply subtle transparent mastering."}}
    if mid=="bs-roformer-sw-6stem":
        return {"kind":"structured","requiredResultKeys":["stems"],
                "expectedStemCount":5,"input":audio}
    if mid=="mvsep-mega-53":
        return {"kind":"structured","requiredResultKeys":["stems","expectedStems"],
                "expectedStemCount":53,"input":{**audio,"inlineMaxSeconds":1}}
    if mid in ("mel-roformer-bve","mel-roformer-dereverb"):
        return {"kind":"structured","requiredResultKeys":["stems"],
                "expectedStemCount":2,"input":audio}
    if mid=="yue2-3b":
        return {"kind":"audio","requiredResultKeys":["audioBase64"],
                "input":{"style":"short original acoustic folk melody, gentle percussion",
                         "lyrics":"[Verse]\nThe road goes on and on."}}
    if mid=="universr":
        return {"kind":"audio","requiredResultKeys":["audioBase64"],"input":audio}
    raise ValueError(f"no synthetic inference fixture for model {mid}")


def generate(role: str, path: pathlib.Path):
    manifest=json.loads((RUNTIME/"model_manifest.json").read_text(encoding="utf-8"))
    byid={m["id"]:m for m in manifest["models"]}
    cfg=manifest["roles"].get(role)
    if cfg is None:
        raise ValueError("unknown canonical AI_ROLE")
    if not path.is_absolute():
        raise ValueError("fixture destination must be absolute")
    short={"audioBase64":synthetic_audio(16000,3)}
    long={"audioBase64":synthetic_audio(16000,10)}
    tiny={"audioBase64":synthetic_audio(16000,.8)}
    payload={}
    for mid in cfg["models"]:
        if mid in DEPENDENCIES:
            continue
        sample=long if mid in ("beat-this","songformer") else (
            tiny if mid in ("mvsep-mega-53","sonicmaster","mel-roformer-bve",
                             "mel-roformer-dereverb") else short)
        entry=fixture(mid,sample)
        entry["task"]=byid[mid]["task"]
        payload[mid]=entry
    path.parent.mkdir(parents=True,exist_ok=True)
    fd,temporary=tempfile.mkstemp(prefix=".model-proof-",dir=path.parent)
    try:
        with os.fdopen(fd,"w",encoding="utf-8") as file:
            json.dump({"models":payload},file,ensure_ascii=False,separators=(",",":"))
            file.flush()
            os.fsync(file.fileno())
        os.chmod(temporary,0o600)
        os.replace(temporary,path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return sorted(payload)


if __name__=="__main__":
    import os
    dest=pathlib.Path(os.environ.get("AI_MODEL_PROOF_FIXTURE","/tmp/audiomonastry-model-proof.json"))
    generate(os.environ["AI_ROLE"],dest)
