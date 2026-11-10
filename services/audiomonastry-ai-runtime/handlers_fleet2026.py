"""RunPod 2026 inference adapters. All model calls are real or explicitly fail."""
from __future__ import annotations
import base64
import io
import json
import tempfile
from pathlib import Path
from typing import Any, Dict
from model_manager import ModelDefinition, ModelUnavailableError


def _require(name):
    import importlib
    try:
        return importlib.import_module(name)
    except Exception as exc:
        raise ModelUnavailableError(f"dependency missing: {name}: {type(exc).__name__}: {exc}") from exc


def _cached(key, factory):
    from handlers import _cache_get
    return _cache_get(key, factory)


def _audio(payload):
    from handlers_ears import audio_bytes, decode_audio
    return decode_audio(audio_bytes(payload))


def music_understand(model_id: str, definition: ModelDefinition, payload: Dict[str, Any]):
    """OpenMOSS official Transformers audio-encoder/adapter/generate API."""
    torch = _require("torch")
    transformers = _require("transformers")
    from handlers_ears import resample
    prompt = str(payload.get("question") or payload.get("prompt") or
                 "Describe genre, instrumentation, mood, rhythm, chords and sections. Label uncertainties.")[:2000]
    samples, sr = _audio(payload)

    def factory():
        proc = transformers.AutoProcessor.from_pretrained(
            definition.repository, revision=definition.revision, trust_remote_code=True,
            enable_time_marker=True)
        model = transformers.AutoModel.from_pretrained(
            definition.repository, revision=definition.revision, trust_remote_code=True,
            torch_dtype="auto", device_map="cuda:0").eval()
        return proc, model

    processor, model = _cached("mossmusic:" + definition.revision, factory)
    rate = int(processor.config.mel_sr)
    data = resample(samples, sr, rate)
    inputs = processor(text=prompt, audios=[data], return_tensors="pt").to(model.device)
    if inputs.get("audio_data") is not None:
        inputs["audio_data"] = inputs["audio_data"].to(model.dtype)
    inputs["audio_input_mask"] = inputs["input_ids"] == processor.audio_token_id
    with torch.inference_mode():
        ids = model.generate(**inputs, max_new_tokens=min(1024,max(64,int(payload.get("maxTokens",512)))),
                             do_sample=False, num_beams=1, use_cache=True)
    length = int(inputs["input_ids"].shape[1])
    text = processor.decode(ids[0, length:], skip_special_tokens=True)
    if not text.strip():
        raise ModelUnavailableError("MOSS-Music returned empty output")
    return {"model":model_id,"text":text,"sampleRate":rate,"seconds":round(data.shape[-1]/rate,3)}


GUI_COMMANDS = frozenset({
    "track.setVolume", "track.setPan", "track.setMute", "track.setSolo",
    "transport.setTempo", "transport.seek", "plugin.setParameter",
    "clip.move", "clip.setGain", "mixer.selectTrack"
})


def gui_execute(model_id: str, definition: ModelDefinition, payload: Dict[str, Any]):
    """Only a validated action proposal; app backend checks access and executes it."""
    from handlers_runpod import generate_chat
    instruction = str(payload.get("instruction") or payload.get("text") or "").strip()
    if not 1 <= len(instruction) <= 3000:
        raise ModelUnavailableError("GUI instruction must have 1..3000 characters")
    requested = payload.get("allowedCommands")
    if not isinstance(requested,list):
        raise ModelUnavailableError("allowedCommands missing: must be supplied by trusted app server")
    allowed = sorted(GUI_COMMANDS.intersection(x for x in requested if isinstance(x,str)))
    if not allowed:
        raise ModelUnavailableError("no commands allowed")
    prompt = ("Return exactly one JSON object with action and args fields, never code. "
              "When impossible: {\"action\":\"none\",\"args\":{}}. "
              "Permitted commands: " + ", ".join(allowed) + ". Request: " + instruction)
    raw = generate_chat(model_id,definition,[{"role":"user","content":prompt}],
                        max_new_tokens=192,temperature=0,do_sample=False,enable_thinking=False)["text"]
    try:
        data = json.loads(raw.strip())
    except ValueError as exc:
        raise ModelUnavailableError("GUI model returned invalid JSON") from exc
    if not isinstance(data,dict):
        raise ModelUnavailableError("GUI command must be an object")
    action,args = data.get("action"),data.get("args")
    if action == "none":
        return {"status":"no_action","command":None,"executed":False}
    if action not in allowed or not isinstance(args,dict) or len(args)>16:
        raise ModelUnavailableError("unauthorized action or invalid arguments")
    for key,val in args.items():
        if not isinstance(key,str) or len(key)>64 or not isinstance(val,(str,int,float,bool,type(None))):
            raise ModelUnavailableError("GUI arguments must be primitive")
        if isinstance(val,str) and len(val)>256:
            raise ModelUnavailableError("GUI argument string exceeds bound")
    return {"status":"proposed","command":{"action":action,"args":args},
            "requiresAppPermissionCheck":True,"requiresPluginLock":True,"executed":False}


def yue2_song(model_id: str, definition: ModelDefinition, payload: Dict[str, Any]):
    """YuE2Pipeline from first-party yue2_infer package; original BF16 plus VAE."""
    yue2 = _require("yue2")
    style = str(payload.get("style") or payload.get("prompt") or "").strip()
    lyrics = str(payload.get("lyrics") or "").strip()
    if not 1 <= len(style) <= 4000 or not 1 <= len(lyrics) <= 20000:
        raise ModelUnavailableError("YuE2 requires style (<=4000) and lyrics (<=20000)")
    pipeline = _cached("yue2:"+definition.revision,
                       lambda:yue2.YuE2Pipeline.from_pretrained(definition.repository,device="cuda"))
    with tempfile.TemporaryDirectory(prefix="yue2-") as folder:
        song = pipeline(style=style,lyrics=lyrics,planning=str(payload.get("planning") or "full"))
        song.save_artifacts(str(Path(folder)/"output"))
        paths = sorted((p for p in Path(folder).rglob("*") if p.suffix.lower() in (".wav",".flac")),
                       key=lambda p:p.stat().st_size,reverse=True)
        if not paths:
            raise ModelUnavailableError("YuE2 produced no WAV/FLAC audio")
        path = paths[0]
        if path.stat().st_size > 32*1024*1024:
            raise ModelUnavailableError("YuE2 output >32MB: provide R2 streaming before longer songs")
        return {"audioBase64":base64.b64encode(path.read_bytes()).decode(),
                "format":path.suffix.lstrip(".").lower(),"bytes":path.stat().st_size,
                "model":model_id,"truncated":bool(getattr(song,"truncated",False))}
