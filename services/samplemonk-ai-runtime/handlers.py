"""
SampleMONK AI Runtime – Inference Handlers
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
        try:
            import torch  # type: ignore

            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:  # noqa: BLE001 – Best-Effort-Freigabe
            pass
        # Eviction als strukturierter Log sichtbar machen (Dashboard zeigt msg).
        print(
            '{"level":"INFO","service":"samplemonk-ai-runtime","msg":"model cache evicted","model":"' + str(evicted_id) + '"}',
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


HANDLERS = {
    "classify": hf_classify,
    "transcribe": hf_transcribe,
    "embed": hf_embed,
    "generate": hf_generate,
    "song": hf_generate,
    "sing": hf_bark_sing,
    "tts": tts_dispatch,
}
