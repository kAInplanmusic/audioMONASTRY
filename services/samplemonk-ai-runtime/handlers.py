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


HANDLERS = {
    "classify": hf_classify,
    "transcribe": hf_transcribe,
    "embed": hf_embed,
    "generate": hf_generate,
    "tts": hf_tts,
}
