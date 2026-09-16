"""
AudioMONASTRY AI Runtime – Inference Handlers
==========================================
Echte Modell-Handler mit Lazy-Imports und Modell-Cache.

Ohne installierte Modell-Abhängigkeiten (z. B. lokale Sandbox ohne
torch/transformers) liefern sie ModelUnavailableError mit klarer Meldung –
kontrollierte Degradation, keine Fake-Ergebnisse.

FA-P0-2 (2026-09-01): Handler laden echte Modell-Instanzen EINMAL in einen
kleinen LRU-Cache und führen Inferenz auf CUDA aus (sofern verfügbar) –
kein `from_pretrained` je Request, keine CPU-Inferenz auf der GPU-Instanz.
"""
from __future__ import annotations

import base64
import io
import json
import os
from collections import OrderedDict
from typing import Any, Callable, Dict, Optional, Tuple

from model_manager import ModelDefinition, ModelUnavailableError

# ---------------------------------------------------------------------------
# Modell-Cache (echte Instanzen, LRU, CUDA-Bewusst)
# ---------------------------------------------------------------------------
_CACHE_MAX_ENTRIES = 4
_MODEL_CACHE: "OrderedDict[str, Any]" = OrderedDict()


def _require_lib(import_name: str, pip_name: str):
    try:
        return __import__(import_name, fromlist=["*"])
    except Exception as exc:  # noqa: BLE001 – Abhängigkeit optional
        raise ModelUnavailableError(f"dependency missing for {import_name} (pip install {pip_name}): {exc}") from exc


def _device():
    """CUDA, wenn verfügbar – sonst CPU (kontrollierte Degradation)."""
    torch = _require_lib("torch", "torch")
    return torch.device("cuda" if torch.cuda.is_available() else "cpu")


def _cache_get(model_id: str, factory: Callable[[], Any]) -> Any:
    """LRU-Cache für echte Modell-/Processor-Instanzen."""
    if model_id in _MODEL_CACHE:
        value = _MODEL_CACHE.pop(model_id)
        _MODEL_CACHE[model_id] = value
        return value
    value = factory()
    _MODEL_CACHE[model_id] = value
    while len(_MODEL_CACHE) > _CACHE_MAX_ENTRIES:
        evicted_id, _ = _MODEL_CACHE.popitem(last=False)
        # AD-K3: CUDA-Cache nur bei explizitem Opt-in leeren (empty_cache kann
        # Latenzspitzen verursachen).
        if os.environ.get("AI_CUDA_EMPTY_CACHE_ON_EVICT", "0") == "1":
            try:
                import torch  # type: ignore

                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
            except Exception:  # noqa: BLE001 – Best-Effort-Freigabe
                pass
        # Eviction als strukturierter Log sichtbar machen (Dashboard zeigt msg).
        print(
            '{"level":"INFO","service":"audiomonastry-ai-runtime","msg":"model cache evicted","model":"' + str(evicted_id) + '"}',
            flush=True,
        )
    return value


def _audio_bytes(payload: Dict[str, Any]) -> bytes:
    """Akzeptiert base64-Audio oder URL; validiert Größe/Format-Grundlagen."""
    data = payload.get("audio") or payload.get("audioBase64")
    if isinstance(data, str):
        if data.startswith("data:"):
            data = data.split(",", 1)[1]
        try:
            raw = base64.b64decode(data, validate=True)
        except Exception as exc:  # noqa: BLE001
            raise ModelUnavailableError(f"invalid audio base64: {exc}") from exc
    elif isinstance(data, bytes):
        raw = data
    else:
        raise ModelUnavailableError("audio payload required (base64 or bytes)")
    if len(raw) > 25 * 1024 * 1024:  # 25 MB Deckel gegen Resource-Exhaustion
        raise ModelUnavailableError("audio too large (max 25 MB)")
    if len(raw) < 44:
        raise ModelUnavailableError("audio too small (min 44 bytes)")
    return raw


def _read_audio(audio: bytes, target_sr: Optional[int] = None) -> Tuple[np.ndarray, int]:
    """Audio als float32-Mono-Array lesen und optional auf target_sr resamplen."""
    import numpy as np

    soundfile = _require_lib("soundfile", "soundfile")
    try:
        samples, sr = soundfile.read(io.BytesIO(audio), dtype="float32", always_2d=False)
    except Exception as exc:  # noqa: BLE001 – Decode-Fehler klar melden
        raise ModelUnavailableError(f"audio decode failed: {exc}") from exc
    samples = np.asarray(samples, dtype=np.float32)
    if samples.ndim > 1:
        samples = samples.mean(axis=1)  # Stereo -> Mono (energie-erhaltend genug für Embedding/Classify)
    if samples.ndim == 0 or samples.size == 0:
        raise ModelUnavailableError("audio is empty")
    if target_sr is not None and sr != target_sr:
        try:
            torch = _require_lib("torch", "torch")
            torchaudio = _require_lib("torchaudio", "torchaudio")
            samples = torchaudio.functional.resample(
                torch.from_numpy(samples), sr, target_sr
            ).numpy().astype(np.float32)
        except ModelUnavailableError:
            # Torchaudio fehlt: lineare Interpolation als letzter Fallback.
            duration = samples.size / sr
            new_len = int(round(duration * target_sr))
            x_old = np.linspace(0.0, duration, num=samples.size, endpoint=False)
            x_new = np.linspace(0.0, duration, num=new_len, endpoint=False)
            samples = np.interp(x_new, x_old, samples).astype(np.float32)
        sr = target_sr
    return samples, sr


# ---------------------------------------------------------------------------
# Aufgaben-Normalisierung
# ---------------------------------------------------------------------------
def _normalize_task(task: str) -> str:
    """Orchestrator-Tasks (`audio.classify`) auf Runtime-Handler (`classify`) mappen."""
    norm = task.strip().replace(" ", ".")
    if norm.startswith("audio."):
        norm = norm.split(".", 1)[1]
    return norm


def run_inference(task: str, model_id: str, definition: ModelDefinition, payload: Dict[str, Any]) -> Any:
    if not isinstance(task, str) or len(task) > 64 or not task.strip():
        raise ModelUnavailableError("invalid task")
    if not isinstance(model_id, str) or len(model_id) > 256 or not model_id.strip():
        raise ModelUnavailableError("invalid model id")
    if not isinstance(payload, dict):
        raise ModelUnavailableError("payload must be an object")
    handler = HANDLERS.get(_normalize_task(task))
    if handler is None:
        raise ModelUnavailableError(f"no handler for task: {task}")
    return handler(model_id, definition, payload)


# ---------------------------------------------------------------------------
# Handler
# ---------------------------------------------------------------------------
def hf_classify(model_id: str, definition: ModelDefinition, payload: Dict[str, Any]) -> Any:
    transformers = _require_lib("transformers", "transformers")
    torch = _require_lib("torch", "torch")

    audio = _audio_bytes(payload)

    def factory() -> Tuple[Any, Any, int]:
        model = transformers.AutoModelForAudioClassification.from_pretrained(
            definition.repository, revision=definition.revision
        ).to(_device())
        processor = transformers.AutoFeatureExtractor.from_pretrained(
            definition.repository, revision=definition.revision
        )
        return model, processor, int(getattr(processor, "sampling_rate", 16000))

    model, processor, target_sr = _cache_get(f"cls:{model_id}", factory)
    samples, _sr = _read_audio(audio, target_sr)
    inputs = processor(samples, sampling_rate=target_sr, return_tensors="pt")
    inputs = {k: v.to(_device()) for k, v in inputs.items()}
    with torch.no_grad():
        logits = model(**inputs).logits
    probs = torch.softmax(logits, dim=-1)[0]
    top = torch.topk(probs, k=min(5, probs.shape[0]))
    return {
        "labels": [model.config.id2label[int(i)] for i in top.indices],
        "scores": [round(float(p), 4) for p in top.values],
    }


def hf_transcribe(model_id: str, definition: ModelDefinition, payload: Dict[str, Any]) -> Any:
    transformers = _require_lib("transformers", "transformers")

    audio = _audio_bytes(payload)

    def factory() -> Any:
        return transformers.pipeline(
            "automatic-speech-recognition",
            model=definition.repository,
            revision=definition.revision,
            device=_device(),
        )

    pipeline = _cache_get(f"asr:{model_id}", factory)
    language = payload.get("language") or None
    # Bytes direkt übergeben – die Pipeline nutzt ffmpeg_read (16 kHz, mono).
    result = pipeline(audio, generate_kwargs={"language": language} if language else {})
    return {"text": result["text"]}


def hf_embed(model_id: str, definition: ModelDefinition, payload: Dict[str, Any]) -> Any:
    torch = _require_lib("torch", "torch")

    audio = _audio_bytes(payload)

    if "clap" in model_id.lower():
        def factory() -> Tuple[Any, Any]:
            from transformers import ClapModel, ClapProcessor  # type: ignore

            processor = ClapProcessor.from_pretrained(definition.repository, revision=definition.revision)
            model = ClapModel.from_pretrained(definition.repository, revision=definition.revision).to(_device())
            return model, processor

        model, processor = _cache_get(f"clap:{model_id}", factory)
        samples, sr = _read_audio(audio, 48000)
        inputs = processor(audios=samples, sampling_rate=sr, return_tensors="pt")
        inputs = {k: v.to(_device()) for k, v in inputs.items()}
        with torch.no_grad():
            emb = model.get_audio_features(**inputs)[0]
        return {"embedding": [round(float(x), 6) for x in emb.tolist()], "dim": int(emb.shape[0])}

    def factory() -> Tuple[Any, Any, int]:
        from transformers import AutoModel, Wav2Vec2FeatureExtractor  # type: ignore

        extractor = Wav2Vec2FeatureExtractor.from_pretrained(definition.repository, revision=definition.revision)
        model = AutoModel.from_pretrained(definition.repository, revision=definition.revision).to(_device())
        return model, extractor, int(getattr(extractor, "sampling_rate", 16000))

    model, extractor, target_sr = _cache_get(f"emb:{model_id}", factory)
    samples, _sr = _read_audio(audio, target_sr)
    inputs = extractor(samples, sampling_rate=target_sr, return_tensors="pt")
    inputs = {k: v.to(_device()) for k, v in inputs.items()}
    with torch.no_grad():
        out = model(**inputs).last_hidden_state.mean(dim=1)[0]
    return {"embedding": [round(float(x), 6) for x in out.tolist()], "dim": int(out.shape[0])}


def hf_generate(model_id: str, definition: ModelDefinition, payload: Dict[str, Any]) -> Any:
    torch = _require_lib("torch", "torch")

    def factory() -> Tuple[Any, Any]:
        from transformers import AutoProcessor, MusicgenForConditionalGeneration  # type: ignore

        processor = AutoProcessor.from_pretrained(definition.repository, revision=definition.revision)
        model = MusicgenForConditionalGeneration.from_pretrained(
            definition.repository, revision=definition.revision
        ).to(_device())
        return model, processor

    model, processor = _cache_get(f"gen:{model_id}", factory)
    prompt = str(payload.get("prompt", "electronic techno loop"))[:500]
    max_seconds = min(float(payload.get("maxDuration", 10)), float(definition.maxDuration))
    inputs = processor(text=[prompt], return_tensors="pt")
    inputs = {k: v.to(_device()) for k, v in inputs.items()}
    with torch.no_grad():
        out = model.generate(**inputs, max_new_tokens=int(max_seconds * 50))
    scipy = _require_lib("scipy", "scipy")
    audio = out[0, 0].cpu().numpy()
    buf = io.BytesIO()
    scipy.io.wavfile.write(buf, 32000, audio)
    return {"audioBase64": base64.b64encode(buf.getvalue()).decode(), "sampleRate": 32000}


def hf_stable_audio(model_id: str, definition: ModelDefinition, payload: Dict[str, Any]) -> Any:
    """Stable Audio Open (Stability AI, Community License) – Beats/One-Shots/SFX.

    Optional package: `pip install diffusers`. Der Handler erwartet einen
    Text-Prompt und erzeugt WAV über die Diffusers StableAudioPipeline.
    """
    torch = _require_lib("torch", "torch")
    numpy = _require_lib("numpy", "numpy")

    prompt = str(payload.get("prompt", ""))[:500].strip()
    if not prompt:
        raise ModelUnavailableError("prompt required for stable-audio")
    negative_prompt = str(payload.get("negativePrompt", ""))[:300] or None
    max_seconds = float(payload.get("maxDuration", 10) or 10)
    device = _device()
    dtype = torch.float16 if device.type == "cuda" else torch.float32

    def factory() -> Any:
        from diffusers import StableAudioPipeline  # type: ignore

        pipe = StableAudioPipeline.from_pretrained(
            definition.repository,
            revision=definition.revision,
            torch_dtype=dtype,
        )
        pipe = pipe.to(device)
        return pipe

    pipe = _cache_get(f"stableaudio:{model_id}", factory)
    with torch.no_grad():
        result = pipe(
            prompt,
            negative_prompt=negative_prompt,
            audio_end_in_s=float(min(max_seconds, 47.0)),
            num_inference_steps=100,
        )
    scipy = _require_lib("scipy", "scipy")
    audio = numpy.asarray(result.audios[0], dtype=numpy.float32)
    buf = io.BytesIO()
    scipy.io.wavfile.write(buf, 44100, audio)
    return {"audioBase64": base64.b64encode(buf.getvalue()).decode(), "sampleRate": 44100}


def qwen3_tts(model_id: str, definition: ModelDefinition, payload: Dict[str, Any]) -> Any:
    """Qwen3-TTS (CustomVoice): Apache-2.0, multilingual inkl. Deutsch.

    Optional package: `pip install qwen-tts` (bringt transformers 4.57.x mit).
    Wenn das Paket nicht installiert ist, liefert der Handler einen klaren
    ModelUnavailableError statt einer Fake-Antwort.
    """
    qwen_tts = _require_lib("qwen_tts", "qwen-tts")  # noqa: F841 – Importprüfung
    torch = _require_lib("torch", "torch")
    numpy = _require_lib("numpy", "numpy")

    text = str(payload.get("text", ""))[:2000].strip()
    if not text:
        raise ModelUnavailableError("text required for qwen3-tts")
    language = str(payload.get("language") or "German")[:50]
    speaker = str(payload.get("speaker") or "Ryan")[:64]
    instruct_raw = payload.get("instruct")
    instruct = str(instruct_raw)[:500].strip() if instruct_raw else ""
    device = _device()
    device_str = f"cuda:{torch.cuda.current_device()}" if device.type == "cuda" else "cpu"
    dtype = torch.bfloat16 if device.type == "cuda" else torch.float32

    def factory() -> Any:
        from qwen_tts import Qwen3TTSModel  # type: ignore

        return Qwen3TTSModel.from_pretrained(
            definition.repository,
            revision=definition.revision,
            device_map=device_str,
            dtype=dtype,
        )

    model = _cache_get(f"qwen3tts:{model_id}", factory)
    try:
        # 0.6B CustomVoice ignoriert/unterstützt kein instruct; 1.7B schon.
        if "1.7B" in definition.repository:
            wavs, sr = model.generate_custom_voice(
                text=text,
                language=language,
                speaker=speaker,
                instruct=instruct or "",
                non_streaming_mode=True,
            )
        else:
            wavs, sr = model.generate_custom_voice(
                text=text,
                language=language,
                speaker=speaker,
                non_streaming_mode=True,
            )
    except Exception as exc:  # noqa: BLE001 – API-Fehler kontrolliert weiterreichen
        raise ModelUnavailableError(f"qwen3-tts inference failed: {exc}") from exc

    if not wavs:
        raise ModelUnavailableError("qwen3-tts returned no audio")
    scipy = _require_lib("scipy", "scipy")
    audio = numpy.asarray(wavs[0], dtype=numpy.float32)
    buf = io.BytesIO()
    scipy.io.wavfile.write(buf, int(sr), audio)
    return {"audioBase64": base64.b64encode(buf.getvalue()).decode(), "sampleRate": int(sr)}


def hf_tts(model_id: str, definition: ModelDefinition, payload: Dict[str, Any]) -> Any:
    torch = _require_lib("torch", "torch")

    def factory() -> Tuple[Any, Any]:
        from transformers import VitsModel, VitsTokenizer  # type: ignore

        tokenizer = VitsTokenizer.from_pretrained(definition.repository, revision=definition.revision)
        model = VitsModel.from_pretrained(definition.repository, revision=definition.revision).to(_device())
        return model, tokenizer

    model, tokenizer = _cache_get(f"tts:{model_id}", factory)
    text = str(payload.get("text", ""))[:500]
    inputs = tokenizer(text, return_tensors="pt")
    inputs = {k: v.to(_device()) for k, v in inputs.items()}
    with torch.no_grad():
        out = model(**inputs).waveform
    scipy = _require_lib("scipy", "scipy")
    audio = out[0].cpu().numpy()
    buf = io.BytesIO()
    scipy.io.wavfile.write(buf, 16000, audio)
    return {"audioBase64": base64.b64encode(buf.getvalue()).decode(), "sampleRate": 16000}


def hf_bark_sing(model_id: str, definition: ModelDefinition, payload: Dict[str, Any]) -> Any:
    """Suno Bark (Gesang/Stimme) – task `sing`.

    Der Server schickt den Text bereits als ♪-Prompt, damit Bark eine
    gesangsartige Ausgabe erzeugt. Liefert WAV (24 kHz) als audioBase64.
    """
    torch = _require_lib("torch", "torch")

    text = str(payload.get("text", ""))[:600].strip()
    if not text:
        raise ModelUnavailableError("text required for bark sing")

    def factory() -> Tuple[Any, Any, int]:
        from transformers import AutoProcessor, BarkModel  # type: ignore

        processor = AutoProcessor.from_pretrained(definition.repository, revision=definition.revision)
        model = BarkModel.from_pretrained(definition.repository, revision=definition.revision).to(_device())
        sr = int(getattr(model.generation_config, "sample_rate", 24000))
        return model, processor, sr

    model, processor, sr = _cache_get(f"bark:{model_id}", factory)
    inputs = processor(text, return_tensors="pt")
    inputs = {k: v.to(_device()) for k, v in inputs.items()}
    with torch.no_grad():
        out = model.generate(**inputs, do_sample=True)
    scipy = _require_lib("scipy", "scipy")
    audio = out[0].cpu().numpy()
    buf = io.BytesIO()
    scipy.io.wavfile.write(buf, sr, audio)
    return {"audioBase64": base64.b64encode(buf.getvalue()).decode(), "sampleRate": sr}


def tts_dispatch(model_id: str, definition: ModelDefinition, payload: Dict[str, Any]) -> Any:
    """tts-Dispatch: Qwen3-TTS nutzt Custom-Handler, alles andere VITS/hf_tts."""
    if model_id.startswith("qwen3-tts") or "Qwen3-TTS" in definition.repository:
        return qwen3_tts(model_id, definition, payload)
    return hf_tts(model_id, definition, payload)


def generate_dispatch(model_id: str, definition: ModelDefinition, payload: Dict[str, Any]) -> Any:
    """generate/song-Dispatch: Stable Audio nutzt Diffusers, alles andere MusicGen."""
    if model_id.startswith("stable-audio") or "stable-audio" in definition.repository:
        return hf_stable_audio(model_id, definition, payload)
    return hf_generate(model_id, definition, payload)


def essentia_analyze(model_id: str, definition: ModelDefinition, payload: Dict[str, Any]) -> Any:
    """Deterministische Audio-Analyse über Essentia (CPU).

    Liefert BPM/Beat-Confidence, Key/Scale, RMS, Loudness-Näherung sowie
    Spectral Centroid/Rolloff. Läuft primär auf CPU – kein VRAM-Budget nötig.
    """
    import tempfile

    numpy = _require_lib("numpy", "numpy")
    soundfile = _require_lib("soundfile", "soundfile")
    es = _require_lib("essentia.standard", "essentia")

    audio = _audio_bytes(payload)
    samples, sr = soundfile.read(io.BytesIO(audio), dtype="float32", always_2d=False)
    samples = numpy.asarray(samples, dtype=numpy.float32)
    if samples.ndim > 1:
        samples = samples.mean(axis=1)

    tmp_path = ""
    try:
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            soundfile.write(tmp.name, samples, sr)
            tmp_path = tmp.name

        loader = es.MonoLoader(filename=tmp_path)
        x = loader()

        result: Dict[str, Any] = {"sampleRate": int(sr), "model": model_id}

        try:
            rhythm = es.RhythmExtractor2013()
            bpm, _beats, beats_confidence, _beats_interval, _beats_stddev = rhythm(x)
            result["bpm"] = round(float(bpm), 2)
            result["beatsConfidence"] = round(float(beats_confidence), 4)
        except Exception:  # noqa: BLE001 – Feature optional
            pass

        try:
            key, scale, strength = es.KeyExtractor()(x)
            result["key"] = str(key)
            result["scale"] = str(scale)
            result["keyStrength"] = round(float(strength), 4)
        except Exception:  # noqa: BLE001
            pass

        try:
            result["rms"] = round(float(es.RMS()(x)), 6)
            result["zeroCrossingRate"] = round(float(es.ZeroCrossingRate()(x)), 6)
        except Exception:  # noqa: BLE001
            pass

        try:
            spectrum = es.Spectrum()(x)
            result["spectralCentroid"] = round(float(es.Centroid()(spectrum)), 2)
            result["spectralRolloff"] = round(float(es.RollOff()(spectrum)), 2)
        except Exception:  # noqa: BLE001
            pass

        return result
    finally:
        if tmp_path:
            import os as _os
            try:
                _os.unlink(tmp_path)
            except OSError:
                pass


from handlers_runpod import (
    acestep_generate,
    pyannote_diarize,
    qwen2_audio_understand,
    qwen3_llm,
    stem_separate_dispatch,
    xtts_tts,
)
from moa_orchestrator import moa_orchestrate


def tts_dispatch_runpod(model_id: str, definition: ModelDefinition, payload: Dict[str, Any]) -> Any:
    """tts-Dispatch inkl. XTTS-v2 und fish-speech (Stimmklon)."""
    if model_id.startswith("xtts") or "XTTS" in definition.repository:
        return xtts_tts(model_id, definition, payload)
    if model_id.startswith("fish-speech") or "fish-speech" in definition.repository.lower():
        return fish_speech_tts(model_id, definition, payload)
    return tts_dispatch(model_id, definition, payload)


# ---------------------------------------------------------------------------
# Voice-Clone/-Convert ueber die isolierte venv (fish-speech + OpenVoice V2)
# ---------------------------------------------------------------------------
#: Interpreter der Voice-venv (siehe Dockerfile.voicedeps). Uebersteuerbar, damit
#: Tests und lokale Laeufe nicht auf den Image-Pfad angewiesen sind.
VOICECLONE_PYTHON = "/opt/voiceclone-venv/bin/python"
#: Verzeichnis der Bridge-Skripte im Image (Dockerfile.voicedeps kopiert dorthin).
VOICE_BRIDGE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "voice_bridge")
#: Referenzlaenge: fish-speech empfiehlt 10-30 s; laenger kostet nur Rechenzeit.
MAX_REFERENCE_SECONDS = 30.0
#: Zielrate der Referenzaufnahmen (fish-speech arbeitet mit 44.1 kHz).
REFERENCE_SAMPLE_RATE = 44100


def _voice_bridge_python() -> str:
    return os.environ.get("VOICECLONE_PYTHON", VOICECLONE_PYTHON)


def _run_voice_bridge(script: str, request: Dict[str, Any], *, timeout_s: float = 1800.0) -> Dict[str, Any]:
    """Ruft eine Bridge im venv auf und liest ihre eine JSON-Zeile von stdout.

    Ehrliche Fehler statt stiller Degradation: fehlt venv oder Skript, oder
    scheitert die Inferenz, wird `ModelUnavailableError` mit der Originalmeldung
    geworfen - der Aufrufer sieht, woran es lag.
    """
    import subprocess
    import tempfile

    python = _voice_bridge_python()
    if not os.path.isfile(python):
        raise ModelUnavailableError(
            f"voice-bridge-Interpreter fehlt: {python} (Image ohne Dockerfile.voicedeps?)"
        )
    script_path = os.path.join(VOICE_BRIDGE_DIR, script)
    if not os.path.isfile(script_path):
        raise ModelUnavailableError(f"voice-bridge-Skript fehlt: {script_path}")

    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as handle:
        json.dump(request, handle, ensure_ascii=False)
        request_path = handle.name
    try:
        proc = subprocess.run(  # noqa: S603 - fester Pfad, feste Argumentliste
            [python, script_path, "--request-json", request_path],
            capture_output=True,
            text=True,
            timeout=timeout_s,
        )
    except subprocess.TimeoutExpired as exc:
        raise ModelUnavailableError(f"voice-bridge {script}: Timeout nach {timeout_s:.0f}s") from exc
    finally:
        try:
            os.unlink(request_path)
        except OSError:
            pass

    result: Dict[str, Any] = {}
    for line in reversed([item for item in (proc.stdout or "").splitlines() if item.strip().startswith("{")]):
        try:
            result = json.loads(line)
            break
        except json.JSONDecodeError:
            continue
    if proc.returncode != 0 or not result.get("ok"):
        reason = result.get("error") or (proc.stderr or "").strip()[-400:] or f"exit {proc.returncode}"
        raise ModelUnavailableError(f"voice-bridge {script}: {reason}")
    return result


def _snapshot_dir(definition: ModelDefinition) -> str:
    """HF-Snapshot (gepinnte Revision) im Standard-Cache - wie `predownload.py`.

    Liegt der Snapshot schon im Cache, ist der Aufruf ein No-Op (kein Netz).
    """
    try:
        from huggingface_hub import snapshot_download

        return snapshot_download(repo_id=definition.repository, revision=definition.revision)
    except Exception as exc:  # noqa: BLE001 - Netz-/Rechtefehler kontrolliert melden
        raise ModelUnavailableError(
            f"Modell-Snapshot {definition.repository}@{definition.revision} nicht verfuegbar: {exc}"
        ) from exc


def _write_reference_wav(payload: Dict[str, Any], field: str, target_path: str) -> float:
    """Schreibt eine Referenzaufnahme als 44.1-kHz-Mono-WAV und liefert die Dauer.

    Normiert wird, weil die Bridges WAV-Pfade erwarten und fish-speech mit
    44.1 kHz arbeitet; die Laenge wird begrenzt, damit eine lange Datei nicht
    unnoetig Rechenzeit kostet.
    """
    soundfile = _require_lib("soundfile", "soundfile")
    numpy = _require_lib("numpy", "numpy")

    raw = payload.get(field)
    if raw is None:
        raw = payload.get(f"{field}Base64")
    audio = _audio_bytes({"audio": raw})
    samples, sample_rate = soundfile.read(io.BytesIO(audio), dtype="float32", always_2d=True)
    if samples.size == 0:
        raise ModelUnavailableError(f"{field}: leere Aufnahme")
    mono = samples.mean(axis=1)
    if sample_rate != REFERENCE_SAMPLE_RATE:
        import scipy.signal

        target_len = int(round(len(mono) * REFERENCE_SAMPLE_RATE / float(sample_rate)))
        mono = scipy.signal.resample(mono, target_len).astype(numpy.float32)
        sample_rate = REFERENCE_SAMPLE_RATE
    max_samples = int(MAX_REFERENCE_SECONDS * REFERENCE_SAMPLE_RATE)
    truncated = len(mono) > max_samples
    if truncated:
        mono = mono[:max_samples]
    soundfile.write(target_path, mono, sample_rate)
    return float(len(mono)) / float(sample_rate)


def _wav_result(path: str, **extra: Any) -> Dict[str, Any]:
    """Liest die erzeugte WAV-Datei und baut die Standard-Audioantwort."""
    soundfile = _require_lib("soundfile", "soundfile")
    info = soundfile.info(path)
    with open(path, "rb") as handle:
        audio = handle.read()
    result: Dict[str, Any] = {
        "audioBase64": base64.b64encode(audio).decode(),
        "sampleRate": int(info.samplerate),
        "seconds": round(float(info.frames) / float(info.samplerate or 1), 3),
    }
    result.update(extra)
    return result


def fish_speech_tts(model_id: str, definition: ModelDefinition, payload: Dict[str, Any]) -> Any:
    """fish-speech 1.5: Zero-Shot-TTS; mit Referenzaufnahme wird die Stimme geklont.

    Laeuft im isolierten venv (torch<=2.4.1/numpy<=1.26.4, siehe
    Dockerfile.voicedeps). Lizenzhinweis: der CODE ist Apache-2.0, die GEWICHTE
    (`fishaudio/fish-speech-1.5`) stehen unter cc-by-nc-sa-4.0 - nicht
    kommerziell. Das Manifest kennzeichnet das entsprechend.
    """
    import tempfile

    text = str(payload.get("text", ""))[:2000].strip()
    if not text:
        raise ModelUnavailableError("text required for fish-speech")

    model_dir = _snapshot_dir(definition)
    with tempfile.TemporaryDirectory(prefix="fishspeech-") as workdir:
        output_path = os.path.join(workdir, "out.wav")
        request: Dict[str, Any] = {
            "modelDir": model_dir,
            "text": text,
            "outputPath": output_path,
            "decoderConfigName": str(payload.get("decoderConfigName") or "firefly-gan-vq-fsq-8x1024-21hz-generator"),
            "maxNewTokens": int(payload.get("maxNewTokens") or 1024),
            "chunkLength": int(payload.get("chunkLength") or 200),
            "temperature": float(payload.get("temperature") or 0.7),
            "topP": float(payload.get("topP") or 0.7),
            "repetitionPenalty": float(payload.get("repetitionPenalty") or 1.2),
            "seed": int(payload.get("seed") or 0),
        }
        cloned = False
        reference = payload.get("referenceAudio") or payload.get("referenceAudioBase64")
        if reference:
            reference_path = os.path.join(workdir, "reference.wav")
            _write_reference_wav(payload, "referenceAudio", reference_path)
            request["referenceAudioPath"] = reference_path
            request["referenceText"] = str(payload.get("referenceText") or "")[:500]
            cloned = True

        bridge = _run_voice_bridge("voice_clone_bridge.py", request)
        return _wav_result(
            str(bridge.get("outputPath") or output_path),
            model=model_id,
            cloned=cloned,
            bridgeSeconds=bridge.get("seconds"),
        )


def voice_convert(model_id: str, definition: ModelDefinition, payload: Dict[str, Any]) -> Any:
    """OpenVoice V2: Timbre einer Aufnahme auf eine Zielstimme uebertragen (MIT).

    Ersetzt die RVC-Rolle: RVC ist auf diesem Stack nicht installierbar (siehe
    Dockerfile.voicedeps), OpenVoice liefert dieselbe Faehigkeit lizenzseitig
    sauber (MIT) und im isolierten venv.
    """
    import tempfile

    if not (payload.get("sourceAudio") or payload.get("sourceAudioBase64")):
        raise ModelUnavailableError("sourceAudio required for voice.convert (die Aufnahme)")
    if not (payload.get("targetReference") or payload.get("targetReferenceBase64")):
        raise ModelUnavailableError("targetReference required for voice.convert (die Zielstimme)")

    model_dir = _snapshot_dir(definition)
    with tempfile.TemporaryDirectory(prefix="openvoice-") as workdir:
        source_path = os.path.join(workdir, "source.wav")
        target_path = os.path.join(workdir, "target.wav")
        output_path = os.path.join(workdir, "converted.wav")
        _write_reference_wav(payload, "sourceAudio", source_path)
        _write_reference_wav(payload, "targetReference", target_path)

        request: Dict[str, Any] = {
            "modelDir": model_dir,
            "sourceAudioPath": source_path,
            "targetReferencePath": target_path,
            "outputPath": output_path,
            "tau": float(payload.get("tau") or 0.3),
        }
        source_se = str(payload.get("sourceSePath") or "")
        if source_se:
            request["sourceSePath"] = source_se

        bridge = _run_voice_bridge("voice_convert_bridge.py", request)
        return _wav_result(
            str(bridge.get("outputPath") or output_path),
            model=model_id,
            bridgeSeconds=bridge.get("seconds"),
        )


def voice_convert_dispatch(model_id: str, definition: ModelDefinition, payload: Dict[str, Any]) -> Any:
    """Dispatch fuer `voice.convert`: OpenVoice V2 ist derzeit der einzige Pfad."""
    if model_id.startswith("openvoice") or "openvoice" in definition.repository.lower():
        return voice_convert(model_id, definition, payload)
    raise ModelUnavailableError(
        f"voice.convert kennt das Modell {model_id!r} nicht (erwartet: openvoice-v2*)"
    )


def generate_dispatch_runpod(model_id: str, definition: ModelDefinition, payload: Dict[str, Any]) -> Any:
    """generate/song-Dispatch inkl. ACE-Step."""
    if model_id.startswith("acestep") or "acestep" in definition.repository.lower():
        return acestep_generate(model_id, definition, payload)
    return generate_dispatch(model_id, definition, payload)


HANDLERS = {
    "classify": hf_classify,
    "transcribe": hf_transcribe,
    "embed": hf_embed,
    "generate": generate_dispatch_runpod,
    "song": generate_dispatch_runpod,
    "sing": hf_bark_sing,
    "tts": tts_dispatch_runpod,
    "analyze": essentia_analyze,
    "llm": qwen3_llm,
    "understand": qwen2_audio_understand,
    "diarize": pyannote_diarize,
    "stem.separate": stem_separate_dispatch,
    # Instanz 8: Mixture-of-Agents-Planung + MCP-Ausfuehrung.
    "agent.orchestrate": moa_orchestrate,
    # Stimmonvertierung (Timbre-Transfer) - OpenVoice V2 im isolierten venv.
    "voice.convert": voice_convert_dispatch,
}
