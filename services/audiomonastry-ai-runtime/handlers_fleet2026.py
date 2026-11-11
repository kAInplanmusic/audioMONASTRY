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
        # Upstream config maps AutoProcessor/AutoConfig, but not AutoModel.
        # Resolve the actual pinned class instead of guessing an auto mapping.
        from transformers.dynamic_module_utils import get_class_from_dynamic_module
        model_cls = get_class_from_dynamic_module(
            "modeling_moss_music.MossMusicModel", definition.repository, revision=definition.revision)
        config = model_cls.config_class.from_pretrained(
            definition.repository, revision=definition.revision, trust_remote_code=True)
        # Released remote config leaves audio_config as a dict, while its
        # encoder consumes attributes. Preserve all pinned values explicitly.
        if isinstance(config.audio_config, dict):
            config.audio_config = transformers.PretrainedConfig(**config.audio_config)
        model = model_cls.from_pretrained(
            definition.repository, revision=definition.revision, trust_remote_code=True, config=config,
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
    from registry import read_manifest
    from weight_assets import ensure_assets, asset_root, read_lock
    component = read_manifest()["weightComponents"]["yue2-vae"]
    locked = read_lock()["yue2-vae"]
    if any(component[key] != locked[key] for key in ("repository", "revision")):
        raise ModelUnavailableError("YuE2 VAE manifest and asset lock identity differ")
    ensure_assets("yue2-vae")
    pipeline = _cached("yue2:"+definition.revision+":"+component["revision"],
                       lambda:yue2.YuE2Pipeline.from_pretrained(
                           definition.repository, revision=definition.revision,
                           vae=str(asset_root() / "yue2-vae"), vae_revision=component["revision"],
                           device="cuda"))
    with tempfile.TemporaryDirectory(prefix="yue2-") as folder:
        options = {}
        if "maxSemanticTokens" in payload:
            raw = payload["maxSemanticTokens"]
            if isinstance(raw, bool) or not isinstance(raw, int) or not 32 <= raw <= 9000:
                raise ModelUnavailableError("YuE2 maxSemanticTokens must be an integer in 32..9000")
            options["semantic_sampling"] = {"max_tokens": raw, "min_tokens": min(200, raw)}
        song = pipeline(style=style,lyrics=lyrics,cot=str(payload.get("planning") or "full"),**options)
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


def brain_infer(model_id: str, definition: ModelDefinition, payload: Dict[str, Any]):
    """Qwen3.8 FP8 through vLLM, never by casting FP8 weights into HF FP16."""
    vllm = _require("vllm")
    prompt = str(payload.get("prompt") or payload.get("text") or "").strip()
    if not 1 <= len(prompt) <= 80000:
        raise ModelUnavailableError("brain text must be 1..80000 chars")
    engine = _cached("brain-vllm:" + definition.revision, lambda: vllm.LLM(
        model=definition.repository, revision=definition.revision,
        trust_remote_code=False, dtype="auto", tensor_parallel_size=1,
        gpu_memory_utilization=0.80, max_model_len=8192))
    tok = engine.get_tokenizer()
    chat = tok.apply_chat_template([{"role":"user","content":prompt}], tokenize=False,
                                   add_generation_prompt=True, enable_thinking=bool(payload.get("enableThinking",True)))
    options = vllm.SamplingParams(temperature=max(0.0,min(1.0,float(payload.get("temperature",0.5)))),
                                  max_tokens=max(16,min(2048,int(payload.get("maxTokens",512)))))
    result = engine.generate([chat],options)
    if not result or not result[0].outputs:
        raise ModelUnavailableError("Qwen3.8 produced no text")
    return {"text":result[0].outputs[0].text,"model":model_id,"engine":"vllm","precision":"fp8"}


def voice_design(model_id: str, definition: ModelDefinition, payload: Dict[str, Any]):
    """Qwen3 TTS VoiceDesign from a text description; never clones an identity."""
    torch = _require("torch")
    qwen = _require("qwen_tts")
    np = _require("numpy")
    sf = _require("soundfile")
    text = str(payload.get("text") or "").strip()[:2000]
    instruct = str(payload.get("instruct") or payload.get("voiceDescription") or "").strip()[:600]
    if not text or not instruct:
        raise ModelUnavailableError("VoiceDesign requires text and a voice description")
    model = _cached("qwen3tts-design:" + definition.revision,
        lambda:qwen.Qwen3TTSModel.from_pretrained(definition.repository,
            revision=definition.revision,device_map="cuda:0",dtype=torch.bfloat16))
    wavs,sr = model.generate_voice_design(text=text,language=str(payload.get("language") or "German"),
                                         instruct=instruct)
    if not wavs:
        raise ModelUnavailableError("VoiceDesign generated no audio")
    out=io.BytesIO()
    sf.write(out,np.asarray(wavs[0],dtype=np.float32),int(sr),format="WAV")
    return {"audioBase64":base64.b64encode(out.getvalue()).decode(),"sampleRate":int(sr)}


def dsp_analyze(model_id: str, definition: ModelDefinition, payload: Dict[str, Any]):
    """Deterministic CPU audio descriptors, no guessed genres or key claims."""
    np=_require("numpy")
    librosa=_require("librosa")
    samples,sr=_audio(payload)
    x=np.asarray(samples,dtype=np.float32)
    if x.ndim==2:
        x=x.mean(axis=0) if x.shape[0]<=2 else x.mean(axis=1)
    if x.size==0 or x.size>sr*3600:
        raise ModelUnavailableError("audio length not supported for DSP analysis")
    rms=float(np.sqrt(np.mean(x.astype(np.float64)**2)))
    chroma=librosa.feature.chroma_stft(y=x,sr=sr,hop_length=512)
    centroid=librosa.feature.spectral_centroid(y=x,sr=sr,hop_length=512)
    onsets=librosa.onset.onset_detect(y=x,sr=sr,hop_length=512,units="time")
    return {"sampleRate":int(sr),"durationSeconds":round(x.size/sr,3),
            "rms":rms,"peak":float(np.max(np.abs(x))),
            "spectralCentroidHz":float(np.mean(centroid)),
            "chromaMean":np.mean(chroma,axis=1).astype(float).tolist(),
            "onsetTimesSeconds":onsets[:20000].astype(float).tolist(),
            "measurementOnly":True}


def basic_pitch_midi(model_id: str, definition: ModelDefinition, payload: Dict[str, Any]):
    """Spotify Basic Pitch on CPU, returning actual MIDI file bytes."""
    sf=_require("soundfile")
    np=_require("numpy")
    from basic_pitch.inference import predict, Model
    from weight_assets import ensure_assets
    weights = ensure_assets("basic-pitch", download=False)
    model_path = next(iter(weights.values()))
    model = _cached("basic-pitch-onnx:" + model_path, lambda: Model(model_path))
    samples,sr=_audio(payload)
    x=np.asarray(samples,dtype=np.float32)
    if x.ndim==2 and x.shape[0]<=2:
        x=x.T
    with tempfile.TemporaryDirectory(prefix="basic-pitch-") as tmp:
        input_path=str(Path(tmp)/"input.wav")
        sf.write(input_path,x,sr,format="WAV",subtype="PCM_16")
        try:
            _,midi,notes=predict(input_path, model_or_model_path=model)
        except Exception as exc:
            raise ModelUnavailableError(f"Basic Pitch inference failed: {type(exc).__name__}: {exc}") from exc
        out=io.BytesIO()
        midi.write(out)
        data=out.getvalue()
        if not data:
            raise ModelUnavailableError("Basic Pitch returned empty MIDI")
        return {"midiBase64":base64.b64encode(data).decode(),"noteCount":len(notes),
                "source":"basic-pitch","sampleRate":int(sr)}


def universr_enhance(model_id: str, definition: ModelDefinition, payload: Dict[str, Any]):
    """Upstream UniverSR.from_pretrained + enhance API, real 48kHz output."""
    sf=_require("soundfile")
    np=_require("numpy")
    universr=_require("universr")
    samples,sr=_audio(payload)
    if int(sr) not in (8000,12000,16000,24000):
        raise ModelUnavailableError("UniverSR input sampleRate must be 8/12/16/24 kHz")
    model=_cached("universr:"+definition.revision,
                  lambda:universr.UniverSR.from_pretrained(
                      definition.repository, revision=definition.revision, device="cuda"))
    audio=np.asarray(samples,dtype=np.float32)
    if audio.ndim==2 and audio.shape[0]<=2:
        audio=audio.T
    with tempfile.TemporaryDirectory(prefix="universr-") as tmp:
        src=str(Path(tmp)/"input.wav")
        sf.write(src,audio,int(sr),format="WAV",subtype="PCM_16")
        out=model.enhance(src,input_sr=int(sr))
        if hasattr(out,"detach"):
            out=out.detach().float().cpu().numpy()
        arr=np.asarray(out,dtype=np.float32)
        if arr.ndim==2 and arr.shape[0]<=2:
            arr=arr.T
        result=io.BytesIO()
        sf.write(result,arr,48000,format="WAV")
        return {"audioBase64":base64.b64encode(result.getvalue()).decode(),
                "sampleRate":48000,"model":model_id}


def sonic_master(model_id: str, definition: ModelDefinition, payload: Dict[str, Any]):
    """Pinned SonicMaster in its own persistent dependency environment."""
    if model_id != 'sonicmaster':
        raise ModelUnavailableError('Mastering model mismatch')
    import os
    import select
    import subprocess
    import threading
    from huggingface_hub import snapshot_download, hf_hub_download
    from registry import read_manifest
    sf = _require('soundfile')
    prompt = str(payload.get('prompt') or 'Enhance the input audio').strip()
    steps = payload.get('inferenceSteps', 10)
    if not 1 <= len(prompt) <= 2000 or isinstance(steps, bool) or not isinstance(steps, int) or not 1 <= steps <= 100:
        raise ModelUnavailableError('SonicMaster prompt or steps outside bounds')
    from handlers_ears import audio_bytes
    np = _require('numpy')
    audio, sr = sf.read(io.BytesIO(audio_bytes(payload)), dtype='float32', always_2d=True)
    if not audio.size or audio.shape[1] > 2 or not np.isfinite(audio).all() or not 0 < len(audio)/sr <= 240:
        raise ModelUnavailableError('SonicMaster requires finite mono/stereo audio of at most 240 seconds')
    def factory():
        components = read_manifest()['weightComponents']
        paths = {}
        for key, name in [('text', 'sonicmaster-text'), ('vae', 'sonicmaster-vae')]:
            component = components[name]
            paths[key] = snapshot_download(component['repository'], revision=component['revision'],
                allow_patterns=component['allowPatterns'])
        paths['checkpoint'] = hf_hub_download(definition.repository, 'model.safetensors', revision=definition.revision)
        process = subprocess.Popen(['/opt/sonic-venv/bin/python', '-u', str(Path(__file__).with_name('sonic_engine.py'))],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        return process, threading.Lock(), paths
    process, lock, paths = _cached('sonicmaster:'+definition.revision, factory)
    with lock, tempfile.TemporaryDirectory(prefix='sonicmaster-') as folder:
        source, target = Path(folder)/'input.wav', Path(folder)/'output.wav'
        sf.write(source, audio, sr, subtype='FLOAT')
        request = dict(paths, input=str(source), output=str(target), prompt=prompt, steps=steps)
        if process.poll() is not None:
            raise ModelUnavailableError('SonicMaster engine terminated; restart the role')
        process.stdin.write(json.dumps(request)+'\n'); process.stdin.flush()
        if not select.select([process.stdout], [], [], 900)[0]:
            process.kill()
            raise ModelUnavailableError('SonicMaster inference deadline reached')
        response = json.loads(process.stdout.readline())
        if not response.get('ok'):
            raise ModelUnavailableError(response.get('error', 'SonicMaster engine failed'))
        return {'audioBase64':base64.b64encode(target.read_bytes()).decode(),
                'sampleRate':44100, 'format':'wav', 'model':model_id}
