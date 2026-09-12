"""
SampleMONK AI Runtime – RunPod/Neue Modell-Handler
===================================================
Ergänzende Handler für Modelle, die im RunPod-Stack laufen:

- qwen3_llm                 (Qwen3-14B, Chat/LLM)
- qwen2_audio_understand    (Qwen2-Audio-7B, Audio-Understanding)
- xtts_tts                  (XTTS-v2, Voice/TTS)
- acestep_generate          (ACE-Step 1.5, Song/Music)
- demucs_stem / stem_dispatch (Demucs + BS-RoFormer)
- pyannote_diarize          (PyAnnote 3.1)

WICHTIG: Diese Handler sind bewusst mit Lazy-Imports und defensiven Fehlern
gebaut. Sie müssen auf einer echten GPU (RunPod H200) verifiziert werden –
insbesondere ACE-Step, Qwen2-Audio und XTTS haben versionsabhängige APIs.
"""
from __future__ import annotations

import base64
import io
import os
import tempfile
import time
from collections import OrderedDict
from typing import Any, Callable, Dict, Optional, Tuple

from model_manager import ModelDefinition, ModelUnavailableError

_CACHE_MAX_ENTRIES = 4
_MODEL_CACHE: "OrderedDict[str, Any]" = OrderedDict()


def _require_lib(import_name: str, pip_name: str):
    try:
        return __import__(import_name, fromlist=["*"])
    except Exception as exc:  # noqa: BLE001
        raise ModelUnavailableError(f"dependency missing for {import_name} (pip install {pip_name}): {exc}") from exc


def _device():
    torch = _require_lib("torch", "torch")
    return torch.device("cuda" if torch.cuda.is_available() else "cpu")


def _cache_get(model_id: str, factory: Callable[[], Any]) -> Any:
    if model_id in _MODEL_CACHE:
        value = _MODEL_CACHE.pop(model_id)
        _MODEL_CACHE[model_id] = value
        return value
    value = factory()
    _MODEL_CACHE[model_id] = value
    while len(_MODEL_CACHE) > _CACHE_MAX_ENTRIES:
        _MODEL_CACHE.popitem(last=False)
    return value


def _audio_bytes(payload: Dict[str, Any]) -> bytes:
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
    if len(raw) > 100 * 1024 * 1024:
        raise ModelUnavailableError("audio too large (max 100 MB)")
    return raw


def _audio_to_wav_temp(payload: Dict[str, Any]) -> Tuple[str, Any, int]:
    """Schreibt Audio-Base64 als temporäre WAV-Datei. Liefert (path, samples, sr)."""
    import numpy as np
    import soundfile as sf

    audio = _audio_bytes(payload)
    samples, sr = sf.read(io.BytesIO(audio), dtype="float32", always_2d=False)
    samples = np.asarray(samples, dtype=np.float32)
    if samples.ndim > 1:
        samples = samples.mean(axis=1)
    tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    try:
        sf.write(tmp.name, samples, sr)
        return tmp.name, samples, int(sr)
    except Exception:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass
        raise


def _text_from(payload: Dict[str, Any]) -> str:
    text = payload.get("prompt") or payload.get("text") or payload.get("question") or ""
    return str(text).strip()


def _resolve_speaker_wav(payload: Dict[str, Any]) -> Optional[str]:
    """Unterstützt speakerWav als base64/data-url oder speakerWavUrl als URL/Datei."""
    raw = payload.get("speakerWav")
    if isinstance(raw, str) and raw.startswith("data:"):
        raw = raw.split(",", 1)[1]
    if isinstance(raw, str) and raw and not raw.startswith("http") and not os.path.exists(raw):
        try:
            decoded = base64.b64decode(raw, validate=True)
        except Exception:  # noqa: BLE001
            return None
        tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
        tmp.write(decoded)
        tmp.close()
        return tmp.name
    if isinstance(raw, str) and raw:
        return raw
    url = payload.get("speakerWavUrl") or payload.get("speakerAudioUrl")
    if isinstance(url, str) and url:
        return url
    return None


# ---------------------------------------------------------------------------
# Qwen3 LLM (zwei Stufen derselben Familie: qwen3-4b = Ausführer, qwen3-14b = Brain)
# ---------------------------------------------------------------------------
def qwen3_llm(model_id: str, definition: ModelDefinition, payload: Dict[str, Any]) -> Any:
    transformers = _require_lib("transformers", "transformers")
    torch = _require_lib("torch", "torch")

    text = _text_from(payload)
    if not text:
        raise ModelUnavailableError("prompt/text required for qwen3")

    def factory() -> Tuple[Any, Any]:
        tokenizer = transformers.AutoTokenizer.from_pretrained(
            definition.repository, revision=definition.revision, trust_remote_code=True
        )
        dtype = torch.bfloat16 if definition.quantization == "bf16" else torch.float16
        model = transformers.AutoModelForCausalLM.from_pretrained(
            definition.repository,
            revision=definition.revision,
            torch_dtype=dtype,
            trust_remote_code=True,
        ).to(_device())
        return tokenizer, model

    tokenizer, model = _cache_get(f"llm:{model_id}", factory)
    messages = [{"role": "user", "content": text}]
    # Qwen3 gibt sonst zuerst einen <think>-Block aus und verbraucht damit das
    # Token-Budget (im Live-Test sichtbar). Für Tool-Calling/Interaktion ist
    # Thinking deshalb standardmäßig AUS; nur ein expliziter Opt-in schaltet es an.
    enable_thinking = bool(payload.get("enableThinking", False))
    try:
        prompt = tokenizer.apply_chat_template(
            messages,
            tokenize=False,
            add_generation_prompt=True,
            enable_thinking=enable_thinking,
        )
    except TypeError:
        # Ältere Chat-Templates kennen das Argument nicht – dann der /no_think-Weg.
        prompt = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
        if not enable_thinking:
            prompt += "/no_think"
    inputs = tokenizer(prompt, return_tensors="pt").to(_device())
    max_new = int(payload.get("maxTokens", 512))
    do_sample = bool(payload.get("doSample", False))
    temperature = float(payload.get("temperature", 0.7))
    started_generate = time.time()
    with torch.no_grad():
        outputs = model.generate(
            **inputs,
            max_new_tokens=max_new,
            do_sample=do_sample,
            temperature=temperature if do_sample else None,
        )
    generate_seconds = max(1e-6, time.time() - started_generate)
    generated = int(outputs[0].shape[0] - inputs.input_ids.shape[1])
    answer = tokenizer.decode(outputs[0][inputs.input_ids.shape[1]:], skip_special_tokens=True)
    # Tokens/s wird OHNE Modell-Load gemessen (Load zahlt der Warmup-Job).
    return {
        "text": answer,
        "modelId": model_id,
        "generatedTokens": generated,
        "generateSeconds": round(generate_seconds, 3),
        "tokensPerSecond": round(generated / generate_seconds, 2),
        "enableThinking": enable_thinking,
    }


# ---------------------------------------------------------------------------
# Qwen2-Audio-7B
# ---------------------------------------------------------------------------
def qwen2_audio_understand(model_id: str, definition: ModelDefinition, payload: Dict[str, Any]) -> Any:
    transformers = _require_lib("transformers", "transformers")
    torch = _require_lib("torch", "torch")

    question = _text_from(payload)
    if not question:
        raise ModelUnavailableError("question/prompt required for qwen2-audio")

    wav_path = ""
    try:
        wav_path, _samples, _sr = _audio_to_wav_temp(payload)
        processor = transformers.AutoProcessor.from_pretrained(
            definition.repository, revision=definition.revision, trust_remote_code=True
        )
        model = transformers.Qwen2AudioForConditionalGeneration.from_pretrained(
            definition.repository,
            revision=definition.revision,
            torch_dtype=torch.bfloat16,
            trust_remote_code=True,
        ).to(_device())

        conversation = [
            {
                "role": "user",
                "content": [
                    {"type": "audio", "audio": wav_path},
                    {"type": "text", "text": question},
                ],
            }
        ]
        text = processor.apply_chat_template(conversation, tokenize=False, add_generation_prompt=True)
        inputs = processor(text=text, audios=[wav_path], return_tensors="pt", padding=True).to(_device())
        with torch.no_grad():
            outputs = model.generate(**inputs, max_new_tokens=int(payload.get("maxTokens", 512)))
        answer = processor.batch_decode(outputs[:, inputs.input_ids.shape[1]:], skip_special_tokens=True)[0]
        return {"text": answer}
    finally:
        if wav_path:
            try:
                os.unlink(wav_path)
            except OSError:
                pass


# ---------------------------------------------------------------------------
# XTTS-v2
# ---------------------------------------------------------------------------
def xtts_tts(model_id: str, definition: ModelDefinition, payload: Dict[str, Any]) -> Any:
    _require_lib("TTS", "TTS")
    text = _text_from(payload)
    if not text:
        raise ModelUnavailableError("text required for xtts")
    speaker_wav = _resolve_speaker_wav(payload)
    if not speaker_wav:
        raise ModelUnavailableError("speakerWav/speakerWavUrl required for xtts voice cloning")

    language = str(payload.get("language", "de"))[:10]

    def factory() -> Any:
        from TTS.api import TTS  # type: ignore

        return TTS("tts_models/multilingual/multi-dataset/xtts_v2").to(_device())

    tts = _cache_get(f"xtts:{model_id}", factory)
    tmp_out = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    tmp_out.close()
    try:
        tts.tts_to_file(
            text=text,
            speaker_wav=speaker_wav,
            language=language,
            file_path=tmp_out.name,
        )
        with open(tmp_out.name, "rb") as fh:
            audio_b64 = base64.b64encode(fh.read()).decode()
        return {"audioBase64": audio_b64}
    finally:
        try:
            os.unlink(tmp_out.name)
        except OSError:
            pass


# ---------------------------------------------------------------------------
# ACE-Step 1.5
# ---------------------------------------------------------------------------
def acestep_generate(model_id: str, definition: ModelDefinition, payload: Dict[str, Any]) -> Any:
    transformers = _require_lib("transformers", "transformers")
    torch = _require_lib("torch", "torch")
    prompt = _text_from(payload)
    if not prompt:
        raise ModelUnavailableError("prompt required for acestep")

    duration = float(payload.get("durationSeconds", 30))
    steps = int(payload.get("inferenceSteps", 8))

    try:
        from diffusers import DiffusionPipeline  # type: ignore

        pipe = DiffusionPipeline.from_pretrained(
            definition.repository,
            revision=definition.revision,
            torch_dtype=torch.bfloat16,
            trust_remote_code=True,
        ).to(_device())

        result = pipe(
            prompt=prompt,
            audio_length_in_s=duration,
            num_inference_steps=steps,
        )
        audio = result.audios[0]
        sr = int(getattr(result, "sample_rate", 48000) or 48000)
    except Exception as exc:  # noqa: BLE001
        raise ModelUnavailableError(f"acestep pipeline failed: {exc}") from exc

    import numpy as np
    import soundfile as sf

    samples = np.asarray(audio, dtype=np.float32)
    buf = io.BytesIO()
    sf.write(buf, samples, sr, format="WAV")
    return {"audioBase64": base64.b64encode(buf.getvalue()).decode(), "sampleRate": sr}


# ---------------------------------------------------------------------------
# Demucs / Stem
# ---------------------------------------------------------------------------
def demucs_stem(model_id: str, definition: ModelDefinition, payload: Dict[str, Any]) -> Any:
    torch = _require_lib("torch", "torch")
    _require_lib("demucs", "demucs")
    audio_path = ""
    try:
        audio_path, _samples, _sr = _audio_to_wav_temp(payload)
        from demucs.api import Separator  # type: ignore

        device = "cuda" if torch.cuda.is_available() else "cpu"
        # `half` wurde aus dem Separator-Konstruktor neuerer demucs-Versionen
        # entfernt (TypeError "unexpected keyword argument 'half'", live belegt
        # 2026-09-12). Manifest-Quantisierung ist fp32 - ohne das Argument laeuft
        # der Separator in voller Praezision und bleibt versionsunabhaengig.
        separator = Separator(model="htdemucs", device=device)
        _, separated = separator.separate_audio_file(audio_path)

        import numpy as np
        import soundfile as sf

        stems: Dict[str, Any] = {}
        for stem_name, wav in separated.items():
            wav_np = wav[0].cpu().numpy() if hasattr(wav[0], "cpu") else np.asarray(wav[0])
            buf = io.BytesIO()
            sf.write(buf, wav_np, int(separator.samplerate or 44100), format="WAV")
            stems[stem_name] = base64.b64encode(buf.getvalue()).decode()
        return {"stems": stems}
    finally:
        if audio_path:
            try:
                os.unlink(audio_path)
            except OSError:
                pass


def bs_roformer_stem(model_id: str, definition: ModelDefinition, payload: Dict[str, Any]) -> Any:
    """BS-RoFormer ist über das `audiosep`-Ökosystem anzubinden.

    Die APIs der Checkpoints variieren stark. Bis ein konkreter Checkpoint
    festgelegt und auf dem Pod verifiziert ist, liefern wir einen klaren Fehler
    statt Fake-Ergebnisse.
    """
    raise ModelUnavailableError(
        "bs-roformer: konkreter Checkpoint/audiosep-API muss auf dem Pod verifiziert werden; "
        "vorerst demucs_stem für 4-Stem verwenden"
    )


def stem_separate_dispatch(model_id: str, definition: ModelDefinition, payload: Dict[str, Any]) -> Any:
    if "demucs" in model_id.lower() or "htdemucs" in definition.repository.lower():
        return demucs_stem(model_id, definition, payload)
    if "bs" in model_id.lower() or "roformer" in definition.repository.lower():
        return bs_roformer_stem(model_id, definition, payload)
    return demucs_stem(model_id, definition, payload)


# ---------------------------------------------------------------------------
# PyAnnote Diarization
# ---------------------------------------------------------------------------
def pyannote_diarize(model_id: str, definition: ModelDefinition, payload: Dict[str, Any]) -> Any:
    _require_lib("pyannote.audio", "pyannote.audio")
    token = os.environ.get("HF_TOKEN", "").strip()
    if not token:
        raise ModelUnavailableError("HF_TOKEN required for pyannote diarization")

    wav_path = ""
    try:
        wav_path, _samples, _sr = _audio_to_wav_temp(payload)
        from pyannote.audio import Pipeline  # type: ignore

        pipeline = Pipeline.from_pretrained(
            definition.repository,
            revision=definition.revision,
            use_auth_token=token,
        )
        diarization = pipeline(wav_path)
        segments = [
            {
                "start": round(float(turn.start), 3),
                "end": round(float(turn.end), 3),
                "speaker": str(speaker),
            }
            for turn, _track, speaker in diarization.itertracks(yield_label=True)
        ]
        return {"segments": segments}
    finally:
        if wav_path:
            try:
                os.unlink(wav_path)
            except OSError:
                pass
