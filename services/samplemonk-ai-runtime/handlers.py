"""
SampleMONK AI Runtime – Inference Handlers
==========================================
Echte Modell-Handler mit Lazy-Imports. Ohne installierte Modell-Abhängigkeiten
(z. B. lokale Sandbox ohne torch/transformers) liefern sie ModelUnavailableError
mit klarer Meldung – kontrollierte Degradation, keine Fake-Ergebnisse.
"""
from __future__ import annotations

from typing import Any, Dict

from model_manager import ModelDefinition, ModelUnavailableError


def _normalize_task(task: str) -> str:
    """Orchestrator-Tasks (`audio.classify`) auf Runtime-Handler (`classify`) mappen."""
    norm = task.strip().replace(' ', '.')
    if norm.startswith('audio.'):
        norm = norm.split('.', 1)[1]
    return norm


def run_inference(task: str, model_id: str, definition: ModelDefinition, payload: Dict[str, Any]) -> Any:
    handler = HANDLERS.get(_normalize_task(task))
    if handler is None:
        raise ModelUnavailableError(f"no handler for task: {task}")
    return handler(model_id, definition, payload)


def _require_lib(import_name: str, pip_name: str):
    try:
        return __import__(import_name, fromlist=["*"])
    except Exception as exc:  # noqa: BLE001 – Abhängigkeit optional
        raise ModelUnavailableError(f"dependency missing for {import_name} (pip install {pip_name}): {exc}") from exc


def _audio_bytes(payload: Dict[str, Any]) -> bytes:
    """Akzeptiert base64-Audio oder URL; validiert Größe/Format-Grundlagen."""
    import base64

    data = payload.get("audio") or payload.get("audioBase64")
    if isinstance(data, str):
        if data.startswith("data:"):
            data = data.split(",", 1)[1]
        raw = base64.b64decode(data, validate=True)
    elif isinstance(data, bytes):
        raw = data
    else:
        raise ModelUnavailableError("audio payload required (base64 or bytes)")
    if len(raw) > 25 * 1024 * 1024:  # 25 MB Deckel gegen Resource-Exhaustion
        raise ModelUnavailableError("audio too large (max 25 MB)")
    return raw


def hf_classify(_model_id: str, definition: ModelDefinition, payload: Dict[str, Any]) -> Any:
    transformers = _require_lib("transformers", "transformers")
    _require_lib("torch", "torch")
    from io import BytesIO

    audio = _audio_bytes(payload)
    model = transformers.AutoModelForAudioClassification.from_pretrained(definition.repository, revision=definition.revision)
    processor = transformers.AutoFeatureExtractor.from_pretrained(definition.repository, revision=definition.revision)
    import soundfile as sf  # type: ignore

    samples, sr = sf.read(BytesIO(audio))
    inputs = processor(samples, sampling_rate=sr, return_tensors="pt")
    import torch

    with torch.no_grad():
        logits = model(**inputs).logits
    probs = torch.softmax(logits, dim=-1)[0]
    top = torch.topk(probs, k=min(5, probs.shape[0]))
    return {
        "labels": [model.config.id2label[int(i)] for i in top.indices],
        "scores": [round(float(p), 4) for p in top.values],
    }


def hf_transcribe(_model_id: str, definition: ModelDefinition, payload: Dict[str, Any]) -> Any:
    transformers = _require_lib("transformers", "transformers")
    _require_lib("torch", "torch")
    from io import BytesIO

    audio = _audio_bytes(payload)
    pipeline = transformers.pipeline("automatic-speech-recognition", model=definition.repository, revision=definition.revision)
    language = payload.get("language") or None
    result = pipeline(BytesIO(audio), generate_kwargs={"language": language} if language else {})
    return {"text": result["text"]}


def hf_embed(_model_id: str, definition: ModelDefinition, payload: Dict[str, Any]) -> Any:
    _require_lib("torch", "torch")
    _require_lib("transformers", "transformers")
    from io import BytesIO

    audio = _audio_bytes(payload)
    import torch

    if "clap" in model_id.lower():
        from transformers import ClapModel, ClapProcessor  # type: ignore

        processor = ClapProcessor.from_pretrained(definition.repository, revision=definition.revision)
        model = ClapModel.from_pretrained(definition.repository, revision=definition.revision)
        import soundfile as sf

        samples, sr = sf.read(BytesIO(audio))
        inputs = processor(audios=samples, sampling_rate=sr, return_tensors="pt")
        with torch.no_grad():
            emb = model.get_audio_features(**inputs)[0]
        return {"embedding": [round(float(x), 6) for x in emb.tolist()], "dim": emb.shape[0]}
    from transformers import AutoModel, Wav2Vec2FeatureExtractor  # type: ignore

    extractor = Wav2Vec2FeatureExtractor.from_pretrained(definition.repository, revision=definition.revision)
    model = AutoModel.from_pretrained(definition.repository, revision=definition.revision)
    import soundfile as sf

    samples, sr = sf.read(BytesIO(audio))
    inputs = extractor(samples, sampling_rate=sr, return_tensors="pt")
    with torch.no_grad():
        out = model(**inputs).last_hidden_state.mean(dim=1)[0]
    return {"embedding": [round(float(x), 6) for x in out.tolist()], "dim": out.shape[0]}


def hf_generate(_model_id: str, definition: ModelDefinition, payload: Dict[str, Any]) -> Any:
    _require_lib("torch", "torch")
    _require_lib("transformers", "transformers")
    import io

    import torch
    from transformers import AutoProcessor, MusicgenForConditionalGeneration  # type: ignore

    processor = AutoProcessor.from_pretrained(definition.repository, revision=definition.revision)
    model = MusicgenForConditionalGeneration.from_pretrained(definition.repository, revision=definition.revision)
    prompt = str(payload.get("prompt", "electronic techno loop"))
    max_seconds = min(float(payload.get("maxDuration", 10)), float(definition.maxDuration))
    inputs = processor(text=[prompt], return_tensors="pt")
    with torch.no_grad():
        out = model.generate(**inputs, max_new_tokens=int(max_seconds * 50))
    import scipy.io.wavfile  # type: ignore

    audio = out[0, 0].cpu().numpy()
    buf = io.BytesIO()
    scipy.io.wavfile.write(buf, 32000, audio)
    import base64

    return {"audioBase64": base64.b64encode(buf.getvalue()).decode(), "sampleRate": 32000}


def hf_tts(_model_id: str, definition: ModelDefinition, payload: Dict[str, Any]) -> Any:
    _require_lib("torch", "torch")
    _require_lib("transformers", "transformers")
    import base64
    import io

    import torch
    from transformers import VitsModel, VitsTokenizer  # type: ignore

    tokenizer = VitsTokenizer.from_pretrained(definition.repository, revision=definition.revision)
    model = VitsModel.from_pretrained(definition.repository, revision=definition.revision)
    text = str(payload.get("text", ""))[:500]
    inputs = tokenizer(text, return_tensors="pt")
    with torch.no_grad():
        out = model(**inputs).waveform
    import scipy.io.wavfile  # type: ignore

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
