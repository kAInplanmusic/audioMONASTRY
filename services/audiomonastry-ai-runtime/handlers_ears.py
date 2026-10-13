"""
AudioMONASTRY AI Runtime – RP2 ears: neue Analyse-Handler (FLEET-P1-002 bis -005)
================================================================================
Duenne Adapter fuer die Modelle des ears-Pods (docs/AI_FLEET_STARTPLAN.md, RP2):

- ``qwen3-asr-1.7b``          transcribe     Qwen3-ASR (Paket ``qwen-asr``), Streaming per vLLM
- ``moss-audio-8b-instruct``  understand     MOSS-Audio (Code-Checkout gepinnt, ``trust_remote_code``)
- ``pyannote-community-1``    diarize        pyannote.audio 4.x, gated (HF_TOKEN)
- ``songformer``              analyze        Song-Struktur (Repo-Code, ``trust_remote_code``)
- ``beat-this``               analyze        Beat/Downbeat (GitHub CPJKU/beat_this, kein HF-Repo)
- ``clip-vit-l14``            image.embed    CLIP-Bild-/Text-Embeddings (768-dim) zum Wiederfinden

Grundsaetze (wie ``handlers_stems.py``):

- Repository UND Revision kommen aus dem Manifest-Eintrag. Eine Revision muss ein
  40-stelliger Commit-Hash sein (HF-Inhalte sind darueber adressiert); fuer
  Dateien ohne HF-Repo (beat_this-Checkpoint) wird zusaetzlich SHA-256 geprueft.
- Repo-Code (``trust_remote_code``) nur, wenn der Manifest-Eintrag das
  ausdruecklich setzt UND die Revision gepinnt ist.
- Fehlt ein Paket, ein Pin, ein Token oder eine Datei: ``ModelUnavailableError``
  mit klarer Meldung. Es gibt KEINEN stillen Rueckfall auf ein anderes Modell;
  die Altmodelle (whisper-large-v3, qwen2-audio-7b, pyannote 3.1, essentia)
  laufen nur, wenn sie ausdruecklich als ``model`` gewaehlt sind (Dispatch unten).
- Praezision aus ``definition.quantization``: ``bf16`` -> bfloat16 auf CUDA,
  ``fp16`` -> float16 auf CUDA, sonst float32. Auf CPU immer float32.

NICHT auf GPU verifiziert (Stand 2026-10-13): Keiner dieser Handler ist mit
echten Gewichten gelaufen. Belegt sind nur Mock-Tests ohne GPU
(tests/test_ears_handlers.py: huggingface_hub/torch/vllm/qwen_asr/transformers/
pyannote/beat_this/PIL gefaelscht). Versionsabhaengige APIs sind je Handler
vermerkt.
"""
from __future__ import annotations

import base64
import hashlib
import importlib
import io
import os
import re
import sys
import threading
import time
import wave
from collections import OrderedDict
from typing import Any, Callable, Dict, List, Optional, Tuple

import numpy as np

from model_manager import ModelDefinition, ModelUnavailableError

# ---------------------------------------------------------------------------
# Grenzen (wie die bestehenden Handler: 100 MB Datei, Dauer aus dem Manifest)
# ---------------------------------------------------------------------------
MAX_AUDIO_BYTES = 100 * 1024 * 1024
MIN_AUDIO_BYTES = 44
#: Ein Streaming-Happen (Live-STT) darf hoechstens so lang sein.
MAX_STREAM_CHUNK_SECONDS = 30.0
#: Gleichzeitige Streaming-Sitzungen (4 Nutzer x 2) und Leerlauf bis zum Verwerfen.
MAX_STREAMS = 8
STREAM_IDLE_SECONDS = 120.0
MAX_QUESTION_CHARS = 2000
MAX_NEW_TOKENS = 2048
MAX_IMAGES = 32
MAX_IMAGE_BYTES = 10 * 1024 * 1024
MAX_IMAGE_PIXELS = 40_000_000
MAX_TEXTS = 16
MAX_TEXT_CHARS = 300
CLIP_DIM = 768

_HEX40 = re.compile(r"^[0-9a-f]{40}$")
_STREAM_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
#: Platzhalter fuer Gewichte ohne gepinnte Revision (registry._PIN_REQUIRED).
_PIN_REQUIRED = "PIN-ERFORDERLICH"

# ---------------------------------------------------------------------------
# Code-Pins (gelesen per `git ls-remote`, nichts erfunden)
# ---------------------------------------------------------------------------
#: MOSS-Audio-Inferenzcode. Das HF-Repo enthaelt NUR Config/Processor-Code
#: (auto_map: AutoConfig, AutoProcessor); die Modellklasse ``MossAudioModel``
#: liegt im GitHub-Repo (src/modeling_moss_audio.py). HEAD per `git ls-remote`
#: am 2026-10-13. Lizenz laut README: Apache-2.0.
MOSS_AUDIO_PIN = {
    "repository": "https://github.com/OpenMOSS/MOSS-Audio",
    "commit": "66326e6e0db34f036c86a76ba005efa4830c69dd",
}
MOSS_AUDIO_ROOT_ENV = "MOSS_AUDIO_ROOT"
MOSS_AUDIO_ROOT_DEFAULT = "/opt/moss-audio"
#: Alternative laut README des Herstellers (nicht gewaehlt, siehe FLEET-P1-003):
#: SGLang-Fork ``github.com/OpenMOSS/sglang`` Branch ``moss-audio`` als eigener
#: Server-Prozess (``sglang serve --trust-remote-code``, torch 2.9.1+cu128).
MOSS_AUDIO_SGLANG_HINT = "github.com/OpenMOSS/sglang (Branch moss-audio), sglang serve --trust-remote-code"

#: beat_this: Code und Checkpoint. Tag v1.1.0 -> Commit per `git ls-remote`
#: (2026-10-13). Checkpoint ``final0`` von CHECKPOINT_URL (beat_this/inference.py
#: dieses Commits) am 2026-10-13 geladen und gemessen: 81.058.141 Byte, SHA-256
#: unten. KANDIDAT, NOCH NICHT UEBERNOMMEN: Das Manifest steht weiter auf
#: PIN-ERFORDERLICH, bis der Checkpoint in R2 gespiegelt ist (Pod ist offline).
#: Der Handler laedt nur, wenn die Manifest-Revision genau diesem Commit entspricht.
BEAT_THIS_PIN = {
    "repository": "https://github.com/CPJKU/beat_this",
    "tag": "v1.1.0",
    "commit": "ad7974846029835307ba19a3d5cefbf40b243041",
    "checkpoint": "final0",
    "checkpointUrl": "https://cloud.cp.jku.at/public.php/dav/files/7ik4RrBKTS273gp/final0.ckpt",
    "checkpointSize": 81058141,
    "checkpointSha256": "8c328b45f59d8dd3dff219253ff6a8d6482be57d0133a29140e2febbf8eb8331",
}
BEAT_THIS_CHECKPOINT_ENV = "BEAT_THIS_CHECKPOINT"
BEAT_THIS_CHECKPOINT_DEFAULT = "/data/weights/beat-this/final0.ckpt"

#: Optional, nicht eingeplant: Wort-Timestamps fuer Qwen3-ASR.
QWEN3_FORCED_ALIGNER_HINT = "Qwen/Qwen3-ForcedAligner-0.6B @ c7cbfc2048c462b0d63a45797104fc9db3ad62b7"

#: Sprachen von Qwen3-ASR (README des HF-Repos, gelesen 2026-10-13): ISO -> Modellname.
QWEN3_ASR_LANGUAGES = {
    "zh": "Chinese", "en": "English", "yue": "Cantonese", "ar": "Arabic", "de": "German",
    "fr": "French", "es": "Spanish", "pt": "Portuguese", "id": "Indonesian", "it": "Italian",
    "ko": "Korean", "ru": "Russian", "th": "Thai", "vi": "Vietnamese", "ja": "Japanese",
    "tr": "Turkish", "hi": "Hindi", "ms": "Malay", "nl": "Dutch", "sv": "Swedish",
    "da": "Danish", "fi": "Finnish", "pl": "Polish", "cs": "Czech", "fil": "Filipino",
    "fa": "Persian", "el": "Greek", "hu": "Hungarian", "mk": "Macedonian", "ro": "Romanian",
}
_ASR_ALIASES = {"deutsch": "German", "ger": "German", "deu": "German", "englisch": "English", "eng": "English"}


# ---------------------------------------------------------------------------
# Hilfen: Importe, Pins, Geraet/Praezision, Cache
# ---------------------------------------------------------------------------
def _require(import_name: str, pip_name: str) -> Any:
    try:
        return importlib.import_module(import_name)
    except Exception as exc:  # noqa: BLE001
        raise ModelUnavailableError(f"dependency missing for {import_name} (pip install {pip_name}): {exc}") from exc


def pinned_source(model_id: str, definition: ModelDefinition) -> Tuple[str, str]:
    """(HF-Repo, Revision) aus dem Manifest – nur mit 40-stelligem Commit-Hash."""
    repo = (definition.repository or "").strip()
    revision = (definition.revision or "").strip()
    if not revision or revision.upper() == _PIN_REQUIRED:
        raise ModelUnavailableError(f"{model_id}: Revision nicht gepinnt ({revision or '-'}) – es wird nichts geladen")
    if not _HEX40.fullmatch(revision):
        raise ModelUnavailableError(f"{model_id}: Revision {revision!r} ist kein Commit-Hash (40 hex) – kein Laden ungepinnter Staende")
    if repo.count("/") != 1 or repo.startswith(("http:", "https:")):
        raise ModelUnavailableError(f"{model_id}: kein Hugging-Face-Repo ({repo or '-'})")
    return repo, revision


def snapshot(model_id: str, definition: ModelDefinition, **kwargs: Any) -> str:
    """Lokaler Snapshot genau der Manifest-Revision (offline aus dem Cache bzw. Spiegel)."""
    repo, revision = pinned_source(model_id, definition)
    hub = _require("huggingface_hub", "huggingface_hub")
    try:
        return str(hub.snapshot_download(repo_id=repo, revision=revision, **kwargs))
    except Exception as exc:  # noqa: BLE001
        raise ModelUnavailableError(
            f"Gewichte nicht verfuegbar: {repo}@{revision} ({type(exc).__name__}: {exc}). "
            "Pod-Start laedt sie aus dem Spiegel (scripts/weights-mirror.py) – kein Rueckfall auf ein anderes Modell."
        ) from exc


def require_remote_code(model_id: str, definition: ModelDefinition) -> None:
    """Repo-Code nur mit ausdruecklichem Manifest-Opt-in und gepinnter Revision."""
    if definition.trustRemoteCode is not True:
        raise ModelUnavailableError(
            f"{model_id}: braucht Repo-Code (trust_remote_code); Manifest-Eintrag setzt trustRemoteCode nicht"
        )
    pinned_source(model_id, definition)


def torch_setup(definition: ModelDefinition) -> Tuple[Any, Any, Any]:
    """(torch, device, dtype) – bf16/fp16 nur auf CUDA, sonst float32."""
    torch = _require("torch", "torch")
    cuda = bool(torch.cuda.is_available())
    device = torch.device("cuda" if cuda else "cpu")
    quant = (definition.quantization or "").lower()
    if cuda and quant == "bf16":
        dtype = torch.bfloat16
    elif cuda and quant == "fp16":
        dtype = torch.float16
    else:
        dtype = torch.float32
    return torch, device, dtype


def _device_map(device: Any) -> str:
    return "cuda:0" if getattr(device, "type", str(device)) == "cuda" else "cpu"


_CACHE_MAX_ENTRIES = 6
_CACHE: "OrderedDict[str, Any]" = OrderedDict()
_CACHE_LOCK = threading.Lock()


def cache_get(key: str, factory: Callable[[], Any]) -> Any:
    with _CACHE_LOCK:
        if key in _CACHE:
            _CACHE.move_to_end(key)
            return _CACHE[key]
    value = factory()
    with _CACHE_LOCK:
        _CACHE[key] = value
        _CACHE.move_to_end(key)
        while len(_CACHE) > _CACHE_MAX_ENTRIES:
            _CACHE.popitem(last=False)
    return value


def _cache_key(prefix: str, model_id: str, definition: ModelDefinition, extra: str = "") -> str:
    return f"{prefix}:{model_id}@{definition.repository}@{definition.revision}{extra}"


# ---------------------------------------------------------------------------
# Audio: Base64 -> Mono float32, Grenzen, Resampling
# ---------------------------------------------------------------------------
def audio_bytes(payload: Dict[str, Any], key_names: Tuple[str, ...] = ("audio", "audioBase64")) -> bytes:
    data = None
    for key in key_names:
        if payload.get(key):
            data = payload.get(key)
            break
    if isinstance(data, str):
        if data.startswith("data:"):
            data = data.split(",", 1)[1]
        try:
            raw = base64.b64decode(data, validate=True)
        except Exception as exc:  # noqa: BLE001
            raise ModelUnavailableError(f"invalid audio base64: {exc}") from exc
    elif isinstance(data, (bytes, bytearray)):
        raw = bytes(data)
    else:
        raise ModelUnavailableError("audio payload required (base64 or bytes)")
    if len(raw) > MAX_AUDIO_BYTES:
        raise ModelUnavailableError("audio too large (max 100 MB)")
    if len(raw) < MIN_AUDIO_BYTES:
        raise ModelUnavailableError("audio too small (min 44 bytes)")
    return raw


def _decode_wav_stdlib(raw: bytes) -> Tuple[np.ndarray, int]:
    """PCM-WAV ohne soundfile (8/16/24/32 bit int)."""
    with wave.open(io.BytesIO(raw), "rb") as wf:
        channels, width, sr, frames = wf.getnchannels(), wf.getsampwidth(), wf.getframerate(), wf.getnframes()
        data = wf.readframes(frames)
    if width == 1:
        x = (np.frombuffer(data, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
    elif width == 2:
        x = np.frombuffer(data, dtype="<i2").astype(np.float32) / 32768.0
    elif width == 3:
        b = np.frombuffer(data, dtype=np.uint8).reshape(-1, 3)
        ints = (b[:, 0].astype(np.int32) | (b[:, 1].astype(np.int32) << 8) | (b[:, 2].astype(np.int32) << 16))
        ints = np.where(ints & 0x800000, ints - 0x1000000, ints)
        x = ints.astype(np.float32) / 8388608.0
    elif width == 4:
        x = np.frombuffer(data, dtype="<i4").astype(np.float32) / 2147483648.0
    else:
        raise ModelUnavailableError(f"audio decode failed: WAV mit {width * 8} bit nicht unterstuetzt")
    return x.reshape(-1, channels), int(sr)


def decode_audio(raw: bytes) -> Tuple[np.ndarray, int]:
    """Audio -> (Mono float32, Abtastrate). soundfile, sonst PCM-WAV per stdlib."""
    try:
        sf = importlib.import_module("soundfile")
    except Exception:  # noqa: BLE001
        sf = None
    try:
        if sf is not None:
            samples, sr = sf.read(io.BytesIO(raw), dtype="float32", always_2d=True)
        else:
            samples, sr = _decode_wav_stdlib(raw)
    except ModelUnavailableError:
        raise
    except Exception as exc:  # noqa: BLE001
        hint = "" if sf is not None else " (soundfile fehlt: nur PCM-WAV lesbar)"
        raise ModelUnavailableError(f"audio decode failed{hint}: {exc}") from exc
    mono = np.asarray(samples, dtype=np.float32).mean(axis=1)
    if mono.size == 0 or int(sr) <= 0:
        raise ModelUnavailableError("audio is empty")
    if not np.all(np.isfinite(mono)):
        raise ModelUnavailableError("audio contains NaN/Inf")
    return np.ascontiguousarray(mono), int(sr)


def load_audio(payload: Dict[str, Any], definition: ModelDefinition, max_seconds: Optional[float] = None) -> Tuple[np.ndarray, int, float]:
    """Dekodiert und prueft die Dauer gegen ``maxDuration`` des Manifests."""
    samples, sr = decode_audio(audio_bytes(payload))
    duration = samples.size / float(sr)
    limit = float(max_seconds if max_seconds is not None else definition.maxDuration)
    if limit > 0 and duration > limit + 1e-6:
        raise ModelUnavailableError(f"audio too long ({duration:.1f} s, max {limit:.0f} s)")
    return samples, sr, duration


def resample(samples: np.ndarray, sr: int, target: int) -> np.ndarray:
    """Polyphasen-Resampling (scipy); ohne scipy klarer Fehler statt stiller Naeherung."""
    if int(sr) == int(target):
        return samples
    try:
        signal = importlib.import_module("scipy.signal")
    except Exception as exc:  # noqa: BLE001
        raise ModelUnavailableError(f"Abtastrate {sr} Hz != {target} Hz und scipy fehlt fuer das Resampling: {exc}") from exc
    from math import gcd

    g = gcd(int(sr), int(target))
    return np.ascontiguousarray(signal.resample_poly(samples, int(target) // g, int(sr) // g).astype(np.float32))


def _int_param(payload: Dict[str, Any], key: str, default: int, low: int, high: int) -> int:
    raw = payload.get(key, default)
    try:
        value = int(raw)
    except (TypeError, ValueError) as exc:
        raise ModelUnavailableError(f"{key} muss eine ganze Zahl sein") from exc
    if not (low <= value <= high):
        raise ModelUnavailableError(f"{key}={value} ausserhalb [{low}, {high}]")
    return value


def _float_param(payload: Dict[str, Any], key: str, default: float, low: float, high: float) -> float:
    raw = payload.get(key, default)
    try:
        value = float(raw)
    except (TypeError, ValueError) as exc:
        raise ModelUnavailableError(f"{key} muss eine Zahl sein") from exc
    if not (low <= value <= high):
        raise ModelUnavailableError(f"{key}={value} ausserhalb [{low}, {high}]")
    return value


def _flag(payload: Dict[str, Any], key: str) -> bool:
    value = payload.get(key, False)
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in ("1", "true", "yes", "on")
    return bool(value) if isinstance(value, (int, float)) else False


# ---------------------------------------------------------------------------
# FLEET-P1-002: Qwen3-ASR-1.7B (Streaming-STT, ohne Wort-Timestamps)
# ---------------------------------------------------------------------------
# Vertrag (README Qwen/Qwen3-ASR-1.7B + examples/example_qwen3_asr_vllm_streaming.py,
# gelesen 2026-10-13; Paket qwen-asr 0.0.6):
#   Qwen3ASRModel.from_pretrained(path, dtype=..., device_map=..., max_inference_batch_size=..., max_new_tokens=...)
#   Qwen3ASRModel.LLM(model=path, gpu_memory_utilization=..., max_new_tokens=...)   # vLLM-Backend
#   model.transcribe(audio=(np.ndarray, sr), language=None|"German") -> [r.language, r.text]
#   Streaming NUR mit vLLM: state = init_streaming_state(unfixed_chunk_num, unfixed_token_num, chunk_size_sec);
#   streaming_transcribe(pcm16k, state); finish_streaming_transcribe(state); state.text / state.language
QWEN3_ASR_BACKEND_ENV = "AI_QWEN3_ASR_BACKEND"  # transformers (Standard) | vllm
QWEN3_ASR_GPU_UTIL_ENV = "AI_QWEN3_ASR_GPU_UTIL"
#: Schaetzung: ~5 GB von 48 GB inkl. KV-Cache (FLEET-P1-011 misst). vLLM nimmt sonst 90 %.
QWEN3_ASR_GPU_UTIL_DEFAULT = 0.15
QWEN3_ASR_STREAM_SR = 16000


def normalize_asr_language(value: Any, default: str = "de") -> Optional[str]:
    """ISO-Code/Name -> Sprachname von Qwen3-ASR. ``auto`` -> None (Erkennung)."""
    raw = str(value if value not in (None, "") else default).strip().lower().replace("_", "-")
    if raw in ("auto", "detect", "none"):
        return None
    base = raw.split("-", 1)[0]
    if base in QWEN3_ASR_LANGUAGES:
        return QWEN3_ASR_LANGUAGES[base]
    if base in _ASR_ALIASES:
        return _ASR_ALIASES[base]
    by_name = {name.lower(): name for name in QWEN3_ASR_LANGUAGES.values()}
    if raw in by_name:
        return by_name[raw]
    raise ModelUnavailableError(
        f"unsupported asr language {value!r}; supported: auto, {', '.join(sorted(QWEN3_ASR_LANGUAGES))}"
    )


def qwen3_asr_backend() -> str:
    backend = os.environ.get(QWEN3_ASR_BACKEND_ENV, "transformers").strip().lower() or "transformers"
    if backend not in ("transformers", "vllm"):
        raise ModelUnavailableError(f"{QWEN3_ASR_BACKEND_ENV}={backend!r} unbekannt (transformers|vllm)")
    return backend


def load_qwen3_asr(model_id: str, definition: ModelDefinition) -> Tuple[Any, str]:
    backend = qwen3_asr_backend()

    def factory() -> Tuple[Any, str]:
        qwen_asr = _require("qwen_asr", "qwen-asr")
        torch, device, dtype = torch_setup(definition)
        local_dir = snapshot(model_id, definition)
        try:
            if backend == "vllm":
                _require("vllm", "qwen-asr[vllm]")
                util = float(os.environ.get(QWEN3_ASR_GPU_UTIL_ENV, QWEN3_ASR_GPU_UTIL_DEFAULT))
                if not (0.05 <= util <= 0.9):
                    raise ModelUnavailableError(f"{QWEN3_ASR_GPU_UTIL_ENV}={util} ausserhalb [0.05, 0.9]")
                model = qwen_asr.Qwen3ASRModel.LLM(
                    model=local_dir, gpu_memory_utilization=util, max_inference_batch_size=8, max_new_tokens=1024
                )
            else:
                model = qwen_asr.Qwen3ASRModel.from_pretrained(
                    local_dir,
                    dtype=dtype,
                    device_map=_device_map(device),
                    max_inference_batch_size=8,
                    max_new_tokens=1024,
                )
        except ModelUnavailableError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise ModelUnavailableError(f"qwen3-asr load failed ({backend}): {type(exc).__name__}: {exc}") from exc
        return model, backend

    return cache_get(_cache_key("asr", model_id, definition, f":{backend}"), factory)


class _Stream:
    def __init__(self, state: Any) -> None:
        self.state = state
        self.lock = threading.Lock()
        self.seconds = 0.0
        self.touched = time.monotonic()


_STREAMS: Dict[str, _Stream] = {}
_STREAMS_LOCK = threading.Lock()


def _expire_streams(now: float) -> None:
    for sid in [s for s, st in _STREAMS.items() if now - st.touched > STREAM_IDLE_SECONDS]:
        _STREAMS.pop(sid, None)


def _qwen3_asr_stream(model_id: str, definition: ModelDefinition, payload: Dict[str, Any], model: Any, backend: str) -> Dict[str, Any]:
    if backend != "vllm":
        raise ModelUnavailableError(
            f"qwen3-asr Streaming laeuft nur mit dem vLLM-Backend ({QWEN3_ASR_BACKEND_ENV}=vllm); aktiv: {backend}"
        )
    stream_id = str(payload.get("streamId", "")).strip()
    if not _STREAM_ID.fullmatch(stream_id):
        raise ModelUnavailableError("streamId fehlt oder ungueltig ([A-Za-z0-9_-]{1,64})")
    final = _flag(payload, "final")
    has_audio = bool(payload.get("audio") or payload.get("audioBase64"))
    if has_audio:
        samples, sr, duration = load_audio(payload, definition, MAX_STREAM_CHUNK_SECONDS)
        pcm = resample(samples, sr, QWEN3_ASR_STREAM_SR)
    elif not final:
        raise ModelUnavailableError("audio payload required (Streaming-Happen ohne Audio nur mit final=true)")
    else:
        pcm, duration = None, 0.0
    now = time.monotonic()
    with _STREAMS_LOCK:
        _expire_streams(now)
        stream = _STREAMS.get(stream_id)
        if stream is None:
            if len(_STREAMS) >= MAX_STREAMS:
                raise ModelUnavailableError(f"zu viele Streaming-Sitzungen (max {MAX_STREAMS})")
            chunk_sec = _float_param(payload, "chunkSeconds", 2.0, 0.5, 10.0)
            stream = _Stream(model.init_streaming_state(unfixed_chunk_num=2, unfixed_token_num=5, chunk_size_sec=chunk_sec))
            _STREAMS[stream_id] = stream
        stream.touched = now
    with stream.lock:
        if stream.seconds + duration > float(definition.maxDuration) + 1e-6:
            with _STREAMS_LOCK:
                _STREAMS.pop(stream_id, None)
            raise ModelUnavailableError(f"stream too long (max {definition.maxDuration:.0f} s)")
        try:
            if pcm is not None:
                model.streaming_transcribe(pcm, stream.state)
                stream.seconds += duration
            if final:
                model.finish_streaming_transcribe(stream.state)
        except Exception as exc:  # noqa: BLE001
            with _STREAMS_LOCK:
                _STREAMS.pop(stream_id, None)
            raise ModelUnavailableError(f"qwen3-asr streaming failed: {type(exc).__name__}: {exc}") from exc
        text = str(getattr(stream.state, "text", "") or "")
        language = getattr(stream.state, "language", None)
        seconds = stream.seconds
    if final:
        with _STREAMS_LOCK:
            _STREAMS.pop(stream_id, None)
    return {
        "text": text,
        "language": language,
        "streamId": stream_id,
        "final": final,
        "streamSeconds": round(seconds, 3),
        "model": model_id,
        "backend": backend,
        "wordTimestamps": False,
    }


def qwen3_asr_transcribe(model_id: str, definition: ModelDefinition, payload: Dict[str, Any]) -> Any:
    """transcribe: ``{"text", "language"}`` wie bisher (+ model/backend/durationSeconds)."""
    if _flag(payload, "wordTimestamps") or _flag(payload, "returnTimestamps"):
        raise ModelUnavailableError(
            f"qwen3-asr liefert keine Wort-Timestamps; dafuer waere {QWEN3_FORCED_ALIGNER_HINT} noetig (nicht eingeplant)"
        )
    language = normalize_asr_language(payload.get("language"))
    if _flag(payload, "stream") or payload.get("streamId"):
        model, backend = load_qwen3_asr(model_id, definition)
        return _qwen3_asr_stream(model_id, definition, payload, model, backend)
    samples, sr, duration = load_audio(payload, definition)
    model, backend = load_qwen3_asr(model_id, definition)
    try:
        results = model.transcribe(audio=(samples, sr), language=language)
    except Exception as exc:  # noqa: BLE001
        raise ModelUnavailableError(f"qwen3-asr inference failed: {type(exc).__name__}: {exc}") from exc
    if not results:
        raise ModelUnavailableError("qwen3-asr returned no result")
    first = results[0]
    return {
        "text": str(getattr(first, "text", "") or ""),
        "language": getattr(first, "language", None) or language,
        "model": model_id,
        "backend": backend,
        "durationSeconds": round(duration, 3),
        "wordTimestamps": False,
    }


# ---------------------------------------------------------------------------
# FLEET-P1-003: MOSS-Audio-8B-Instruct (Audio-LLM, Task audio.understand)
# ---------------------------------------------------------------------------
# Entscheidung: transformers-Pfad mit dem gepinnten Hersteller-Code (MOSS_AUDIO_PIN)
# statt SGLang-Fork. Gruende: kein zweiter Server-Prozess/Port auf dem Pod, gleiche
# Job-Schnittstelle wie alle ears-Handler, kein eigener torch-2.9-Stack noetig fuer
# den Start. Preis: langsamer als SGLang (kein Continuous Batching).
# Vertrag (infer.py des gepinnten Commits, gelesen 2026-10-13):
#   from src.modeling_moss_audio import MossAudioModel; from src.processing_moss_audio import MossAudioProcessor
#   model = MossAudioModel.from_pretrained(path, trust_remote_code=True, dtype=..., device_map=...)
#   processor = MossAudioProcessor.from_pretrained(path, trust_remote_code=True, enable_time_marker=True)
#   inputs = processor(text=prompt, audios=[raw_audio @ processor.config.mel_sr], return_tensors="pt")
#   inputs["audio_data"] -> model.dtype; inputs["audio_input_mask"] = input_ids == processor.audio_token_id
#   ids = model.generate(**inputs, max_new_tokens=..., ...); processor.decode(ids[0, input_len:], skip_special_tokens=True)
# UNBELEGT: ob dieser Code unter torch 2.6 / transformers 4.57.3 laeuft (Hersteller nennt torch 2.9.1, transformers 4.57.1).
def _import_moss_classes() -> Tuple[Any, Any]:
    root = os.environ.get(MOSS_AUDIO_ROOT_ENV, "").strip() or MOSS_AUDIO_ROOT_DEFAULT
    if not os.path.isfile(os.path.join(root, "src", "modeling_moss_audio.py")):
        raise ModelUnavailableError(
            f"MOSS-Audio-Code fehlt: {MOSS_AUDIO_PIN['repository']} @ {MOSS_AUDIO_PIN['commit']} nach {root} auschecken "
            f"(Umgebung {MOSS_AUDIO_ROOT_ENV}, Build-Arg AI_INSTALL_EARS_AI=1); Alternative: {MOSS_AUDIO_SGLANG_HINT}. "
            "Kein Rueckfall auf qwen2-audio-7b"
        )
    if root not in sys.path:
        sys.path.insert(0, root)
    try:
        modeling = importlib.import_module("src.modeling_moss_audio")
        processing = importlib.import_module("src.processing_moss_audio")
        return modeling.MossAudioModel, processing.MossAudioProcessor
    except Exception as exc:  # noqa: BLE001
        raise ModelUnavailableError(f"MOSS-Audio-Import fehlgeschlagen ({type(exc).__name__}: {exc})") from exc


def moss_audio_understand(model_id: str, definition: ModelDefinition, payload: Dict[str, Any]) -> Any:
    if "thinking" in (definition.repository or "").lower() or "thinking" in model_id.lower():
        raise ModelUnavailableError(f"{model_id}: nur die Instruct-Variante ist vorgesehen (nicht Thinking)")
    require_remote_code(model_id, definition)
    question = str(payload.get("prompt") or payload.get("question") or payload.get("text") or "").strip()
    if not question:
        raise ModelUnavailableError("question/prompt required for moss-audio")
    if len(question) > MAX_QUESTION_CHARS:
        raise ModelUnavailableError(f"question too long (max {MAX_QUESTION_CHARS} chars)")
    max_tokens = _int_param(payload, "maxTokens", 512, 1, MAX_NEW_TOKENS)
    do_sample = _flag(payload, "doSample")
    samples, sr, duration = load_audio(payload, definition)

    def factory() -> Tuple[Any, Any]:
        model_cls, processor_cls = _import_moss_classes()
        torch, device, dtype = torch_setup(definition)
        local_dir = snapshot(model_id, definition)
        try:
            model = model_cls.from_pretrained(local_dir, trust_remote_code=True, dtype=dtype, device_map=_device_map(device))
            model.eval()
            processor = processor_cls.from_pretrained(local_dir, trust_remote_code=True, enable_time_marker=True)
        except Exception as exc:  # noqa: BLE001
            raise ModelUnavailableError(f"moss-audio load failed: {type(exc).__name__}: {exc}") from exc
        return model, processor

    model, processor = cache_get(_cache_key("moss", model_id, definition), factory)
    torch = _require("torch", "torch")
    mel_sr = int(getattr(getattr(processor, "config", None), "mel_sr", 16000) or 16000)
    audio = resample(samples, sr, mel_sr)
    try:
        inputs = processor(text=question, audios=[audio], return_tensors="pt")
        inputs = inputs.to(model.device)
        if inputs.get("audio_data") is not None:
            inputs["audio_data"] = inputs["audio_data"].to(model.dtype)
        inputs["audio_input_mask"] = inputs["input_ids"] == processor.audio_token_id
        gen_kwargs: Dict[str, Any] = {"max_new_tokens": max_tokens, "do_sample": do_sample, "num_beams": 1, "use_cache": True}
        if do_sample:
            gen_kwargs["temperature"] = _float_param(payload, "temperature", 0.7, 0.01, 2.0)
        with torch.no_grad():
            generated = model.generate(**inputs, **gen_kwargs)
        input_len = int(inputs["input_ids"].shape[1])
        answer = processor.decode(generated[0, input_len:], skip_special_tokens=True)
    except Exception as exc:  # noqa: BLE001
        raise ModelUnavailableError(f"moss-audio inference failed: {type(exc).__name__}: {exc}") from exc
    return {
        "text": str(answer).strip(),
        "model": model_id,
        "variant": "instruct",
        "durationSeconds": round(duration, 3),
    }


# ---------------------------------------------------------------------------
# FLEET-P1-004: pyannote speaker-diarization-community-1 (pyannote.audio 4.x)
# ---------------------------------------------------------------------------
# Vertrag pyannote.audio 4.x (gated Repo, README aus dieser Umgebung nicht lesbar):
#   Pipeline.from_pretrained(repo, revision=..., token=HF_TOKEN)   # 3.x: use_auth_token
#   output = pipeline({"waveform": (1, T) tensor, "sample_rate": sr}, num_speakers=..)
#   output.speaker_diarization / output.exclusive_speaker_diarization  (Annotation; 3.x: Annotation direkt)
# UNBELEGT: revision-Argument und Offline-Laden aller Teilmodelle aus dem Spiegel.
def pyannote_major_version() -> int:
    try:
        from importlib import metadata

        version = metadata.version("pyannote.audio")
    except Exception:  # noqa: BLE001
        module = _require("pyannote.audio", "pyannote.audio>=4")
        version = str(getattr(module, "__version__", "0"))
    try:
        return int(str(version).split(".", 1)[0])
    except ValueError:
        return 0


def _segments(annotation: Any) -> List[Dict[str, Any]]:
    out = []
    for turn, _track, speaker in annotation.itertracks(yield_label=True):
        out.append({"start": round(float(turn.start), 3), "end": round(float(turn.end), 3), "speaker": str(speaker)})
    return out


def pyannote4_diarize(model_id: str, definition: ModelDefinition, payload: Dict[str, Any]) -> Any:
    audio_mod = _require("pyannote.audio", "pyannote.audio>=4")
    major = pyannote_major_version()
    if major < 4:
        raise ModelUnavailableError(f"{model_id}: pyannote.audio 4.x noetig (installiert: {major}.x, Build-Arg AI_INSTALL_PYANNOTE4=1)")
    token = os.environ.get("HF_TOKEN", "").strip()
    if not token:
        raise ModelUnavailableError(f"HF_TOKEN required for {model_id} (gated, nur als Pod-Secret)")
    repo, revision = pinned_source(model_id, definition)
    kwargs: Dict[str, Any] = {}
    if payload.get("numSpeakers") is not None:
        kwargs["num_speakers"] = _int_param(payload, "numSpeakers", 2, 1, 20)
    else:
        if payload.get("minSpeakers") is not None:
            kwargs["min_speakers"] = _int_param(payload, "minSpeakers", 1, 1, 20)
        if payload.get("maxSpeakers") is not None:
            kwargs["max_speakers"] = _int_param(payload, "maxSpeakers", 20, 1, 20)
        if kwargs.get("min_speakers", 1) > kwargs.get("max_speakers", 20):
            raise ModelUnavailableError("minSpeakers > maxSpeakers")
    samples, sr, duration = load_audio(payload, definition)

    def factory() -> Any:
        torch, device, _dtype = torch_setup(definition)
        try:
            pipeline = audio_mod.Pipeline.from_pretrained(repo, revision=revision, token=token)
        except Exception as exc:  # noqa: BLE001
            raise ModelUnavailableError(f"{model_id}: Pipeline-Laden fehlgeschlagen ({type(exc).__name__}: {exc})") from exc
        if pipeline is None:
            raise ModelUnavailableError(f"{model_id}: Pipeline.from_pretrained lieferte None (Gating-Bedingungen akzeptiert?)")
        pipeline.to(device)
        return pipeline

    pipeline = cache_get(_cache_key("pyannote4", model_id, definition), factory)
    torch = _require("torch", "torch")
    try:
        output = pipeline({"waveform": torch.from_numpy(samples[None, :]), "sample_rate": sr}, **kwargs)
    except Exception as exc:  # noqa: BLE001
        raise ModelUnavailableError(f"{model_id} inference failed: {type(exc).__name__}: {exc}") from exc
    annotation = getattr(output, "speaker_diarization", output)
    segments = _segments(annotation)
    result: Dict[str, Any] = {
        "segments": segments,
        "speakers": sorted({s["speaker"] for s in segments}),
        "model": model_id,
        "pyannoteMajor": major,
        "durationSeconds": round(duration, 3),
    }
    exclusive = getattr(output, "exclusive_speaker_diarization", None)
    if exclusive is not None:
        result["exclusiveSegments"] = _segments(exclusive)
    return result


# ---------------------------------------------------------------------------
# FLEET-P1-005: SongFormer (Struktur) und beat_this (Beat/Downbeat)
# ---------------------------------------------------------------------------
# SongFormer-Vertrag (README ASLP-lab/SongFormer, gelesen 2026-10-13):
#   local_dir = snapshot_download(repo, ignore_patterns=["SongFormer.pt", "SongFormer.safetensors"])
#   sys.path.append(local_dir); os.environ["SONGFORMER_LOCAL_DIR"] = local_dir
#   model = AutoModel.from_pretrained(local_dir, trust_remote_code=True, low_cpu_mem_usage=False).to(dev).eval()
#   model(np.ndarray @ 24 kHz) -> [{"start", "end", "label"}, ...]
# Lizenz UNKLAR (kein HF-Tag, README-Badge CC BY 4.0, MuQ-Abhaengigkeit ungeprueft).
SONGFORMER_SR = 24000
SONGFORMER_IGNORE = ["SongFormer.pt", "SongFormer.safetensors"]


def songformer_structure(model_id: str, definition: ModelDefinition, payload: Dict[str, Any]) -> Any:
    require_remote_code(model_id, definition)
    samples, sr, duration = load_audio(payload, definition)
    audio = resample(samples, sr, SONGFORMER_SR)

    def factory() -> Any:
        transformers = _require("transformers", "transformers")
        torch, device, _dtype = torch_setup(definition)
        local_dir = snapshot(model_id, definition, ignore_patterns=list(SONGFORMER_IGNORE))
        if local_dir not in sys.path:
            sys.path.append(local_dir)
        os.environ["SONGFORMER_LOCAL_DIR"] = local_dir
        try:
            model = transformers.AutoModel.from_pretrained(local_dir, trust_remote_code=True, low_cpu_mem_usage=False)
            model = model.to(device)
            model.eval()
        except Exception as exc:  # noqa: BLE001
            raise ModelUnavailableError(f"songformer load failed: {type(exc).__name__}: {exc}") from exc
        return model

    model = cache_get(_cache_key("songformer", model_id, definition), factory)
    torch, device, dtype = torch_setup(definition)
    try:
        with torch.inference_mode():
            if getattr(device, "type", "") == "cuda" and dtype is torch.bfloat16:
                with torch.autocast(device_type="cuda", dtype=torch.bfloat16):
                    raw = model(audio)
            else:
                raw = model(audio)
    except Exception as exc:  # noqa: BLE001
        raise ModelUnavailableError(f"songformer inference failed: {type(exc).__name__}: {exc}") from exc
    if not isinstance(raw, (list, tuple)):
        raise ModelUnavailableError(f"songformer: unerwartetes Ergebnis {type(raw).__name__} (erwartet Liste von Segmenten)")
    sections = []
    for item in raw:
        if not isinstance(item, dict) or "start" not in item or "end" not in item or "label" not in item:
            raise ModelUnavailableError("songformer: Segment ohne start/end/label")
        start, end = float(item["start"]), float(item["end"])
        if not (np.isfinite(start) and np.isfinite(end)) or end < start:
            raise ModelUnavailableError("songformer: Segment mit ungueltiger Zeit")
        sections.append({"start": round(start, 3), "end": round(end, 3), "label": str(item["label"])})
    return {
        "analysis": "structure",
        "sections": sections,
        "model": model_id,
        "sampleRate": SONGFORMER_SR,
        "durationSeconds": round(duration, 3),
    }


def _sha256_file(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


_VERIFIED_FILES: Dict[Tuple[str, int, int], str] = {}


def beat_this_checkpoint(model_id: str, definition: ModelDefinition) -> str:
    """Pfad des gespiegelten Checkpoints – nur mit Pin und passendem SHA-256."""
    revision = (definition.revision or "").strip()
    if not revision or revision.upper() == _PIN_REQUIRED:
        raise ModelUnavailableError(
            f"{model_id}: Revision nicht gepinnt (PIN-ERFORDERLICH) – Code-Commit + Checkpoint-SHA-256 ins Manifest "
            f"uebernehmen und den Checkpoint in R2 spiegeln (FLEET-P1-005). Gemessener Kandidat 2026-10-13: "
            f"{BEAT_THIS_PIN['tag']} = {BEAT_THIS_PIN['commit']}, final0.ckpt SHA-256 {BEAT_THIS_PIN['checkpointSha256']}"
        )
    if revision != BEAT_THIS_PIN["commit"]:
        raise ModelUnavailableError(
            f"{model_id}: Manifest-Revision {revision!r} passt nicht zum geprueften Pin {BEAT_THIS_PIN['commit']} – "
            "Checkpoint-Hash fuer diese Revision unbekannt, es wird nichts geladen"
        )
    path = os.environ.get(BEAT_THIS_CHECKPOINT_ENV, "").strip() or BEAT_THIS_CHECKPOINT_DEFAULT
    if not os.path.isfile(path):
        raise ModelUnavailableError(
            f"{model_id}: Checkpoint fehlt unter {path} ({BEAT_THIS_CHECKPOINT_ENV}); Pod ist offline, Spiegel noetig"
        )
    stat = os.stat(path)
    key = (os.path.realpath(path), int(stat.st_size), int(stat.st_mtime_ns))
    actual = _VERIFIED_FILES.get(key) or _sha256_file(path)
    if actual != BEAT_THIS_PIN["checkpointSha256"]:
        raise ModelUnavailableError(
            f"{model_id}: SHA-256 des Checkpoints passt nicht (erwartet {BEAT_THIS_PIN['checkpointSha256'][:12]}…, "
            f"ist {actual[:12]}…) – Abbruch"
        )
    _VERIFIED_FILES[key] = actual
    return path


def estimate_bpm(beats: List[float]) -> Optional[float]:
    if len(beats) < 3:
        return None
    intervals = np.diff(np.asarray(beats, dtype=np.float64))
    intervals = intervals[intervals > 1e-3]
    if intervals.size == 0:
        return None
    return round(60.0 / float(np.median(intervals)), 2)


def beat_this_track(model_id: str, definition: ModelDefinition, payload: Dict[str, Any]) -> Any:
    """Beat/Downbeat in Sekunden (beat_this, Postprocessing 'minimal', kein DBN)."""
    checkpoint = beat_this_checkpoint(model_id, definition)
    samples, sr, duration = load_audio(payload, definition)

    def factory() -> Any:
        inference = _require("beat_this.inference", f"beat_this @ git+{BEAT_THIS_PIN['repository']}@{BEAT_THIS_PIN['commit']}")
        _torch, device, _dtype = torch_setup(definition)
        try:
            # float16=False: beat_this kennt nur fp16-Autocast; das Manifest nennt fp32 (1 GB).
            return inference.Audio2Beats(checkpoint_path=checkpoint, device=str(device), float16=False, dbn=False)
        except Exception as exc:  # noqa: BLE001
            raise ModelUnavailableError(f"beat_this load failed: {type(exc).__name__}: {exc}") from exc

    tracker = cache_get(_cache_key("beatthis", model_id, definition), factory)
    try:
        beats, downbeats = tracker(samples, sr)
    except Exception as exc:  # noqa: BLE001
        raise ModelUnavailableError(f"beat_this inference failed: {type(exc).__name__}: {exc}") from exc
    beat_list = [round(float(b), 4) for b in np.asarray(beats, dtype=np.float64).ravel()]
    downbeat_list = [round(float(b), 4) for b in np.asarray(downbeats, dtype=np.float64).ravel()]
    return {
        "analysis": "beats",
        "beats": beat_list,
        "downbeats": downbeat_list,
        "bpm": estimate_bpm(beat_list),
        "model": model_id,
        "durationSeconds": round(duration, 3),
    }


# ---------------------------------------------------------------------------
# FLEET-P1-005: CLIP ViT-L/14 (Bild-/Text-Embeddings, 768-dim, nur Wiederfinden)
# ---------------------------------------------------------------------------
def _decode_images(payload: Dict[str, Any]) -> Tuple[List[Any], bool]:
    frames = payload.get("frames")
    images = payload.get("images")
    single = payload.get("image")
    is_video = frames is not None
    items = frames if is_video else (images if images is not None else ([single] if single else []))
    if not isinstance(items, list):
        raise ModelUnavailableError("images/frames muss eine Liste sein")
    if len(items) > MAX_IMAGES:
        raise ModelUnavailableError(f"zu viele Bilder (max {MAX_IMAGES})")
    if not items:
        return [], is_video
    pil = _require("PIL.Image", "pillow")
    decoded = []
    for raw in items:
        if not isinstance(raw, str):
            raise ModelUnavailableError("Bild muss Base64 sein")
        data = raw.split(",", 1)[1] if raw.startswith("data:") else raw
        try:
            blob = base64.b64decode(data, validate=True)
        except Exception as exc:  # noqa: BLE001
            raise ModelUnavailableError(f"invalid image base64: {exc}") from exc
        if len(blob) > MAX_IMAGE_BYTES:
            raise ModelUnavailableError("image too large (max 10 MB)")
        try:
            img = pil.open(io.BytesIO(blob))
            width, height = img.size
            if int(width) * int(height) > MAX_IMAGE_PIXELS:
                raise ModelUnavailableError(f"image too large ({width}x{height}, max {MAX_IMAGE_PIXELS} px)")
            decoded.append(img.convert("RGB"))
        except ModelUnavailableError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise ModelUnavailableError(f"image decode failed: {exc}") from exc
    return decoded, is_video


def _texts(payload: Dict[str, Any]) -> List[str]:
    raw = payload.get("texts")
    if raw is None:
        raw = [payload["text"]] if payload.get("text") else []
    if not isinstance(raw, list) or len(raw) > MAX_TEXTS:
        raise ModelUnavailableError(f"texts muss eine Liste mit hoechstens {MAX_TEXTS} Eintraegen sein")
    out = []
    for text in raw:
        value = str(text).strip()
        if not value or len(value) > MAX_TEXT_CHARS:
            raise ModelUnavailableError(f"Suchtext leer oder zu lang (max {MAX_TEXT_CHARS} Zeichen)")
        out.append(value)
    return out


def _normalized_rows(tensor: Any) -> np.ndarray:
    arr = np.asarray(tensor.float().cpu().numpy(), dtype=np.float32)
    if arr.ndim != 2 or arr.shape[1] != CLIP_DIM:
        raise ModelUnavailableError(f"clip: Embedding-Form {arr.shape} statt (n, {CLIP_DIM})")
    norms = np.linalg.norm(arr, axis=1, keepdims=True)
    return arr / np.maximum(norms, 1e-12)


def _rows(arr: np.ndarray) -> List[List[float]]:
    return [[round(float(x), 6) for x in row] for row in arr]


def clip_embed(model_id: str, definition: ModelDefinition, payload: Dict[str, Any]) -> Any:
    """image.embed: L2-normierte 768-dim-Embeddings fuer Bilder, Videoframes und Suchtexte."""
    images, is_video = _decode_images(payload)
    texts = _texts(payload)
    if not images and not texts:
        raise ModelUnavailableError("image(s)/frames oder text(s) required for clip")
    repo, revision = pinned_source(model_id, definition)

    def factory() -> Tuple[Any, Any]:
        transformers = _require("transformers", "transformers")
        _torch, device, dtype = torch_setup(definition)
        try:
            model = transformers.CLIPModel.from_pretrained(repo, revision=revision, torch_dtype=dtype).to(device)
            model.eval()
            processor = transformers.CLIPProcessor.from_pretrained(repo, revision=revision)
        except Exception as exc:  # noqa: BLE001
            raise ModelUnavailableError(f"clip load failed: {type(exc).__name__}: {exc}") from exc
        return model, processor

    model, processor = cache_get(_cache_key("clip", model_id, definition), factory)
    torch, device, dtype = torch_setup(definition)
    result: Dict[str, Any] = {"dim": CLIP_DIM, "normalized": True, "model": model_id}
    try:
        with torch.inference_mode():
            if images:
                inputs = processor(images=images, return_tensors="pt")
                pixel = inputs["pixel_values"].to(device).to(dtype)
                image_emb = _normalized_rows(model.get_image_features(pixel_values=pixel))
                result["imageEmbeddings"] = _rows(image_emb)
                if is_video:
                    mean = image_emb.mean(axis=0)
                    result["videoEmbedding"] = [round(float(x), 6) for x in mean / max(float(np.linalg.norm(mean)), 1e-12)]
                    result["frameCount"] = len(images)
            if texts:
                tok = processor(text=texts, return_tensors="pt", padding=True, truncation=True, max_length=77)
                text_emb = _normalized_rows(
                    model.get_text_features(input_ids=tok["input_ids"].to(device), attention_mask=tok["attention_mask"].to(device))
                )
                result["textEmbeddings"] = _rows(text_emb)
    except ModelUnavailableError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise ModelUnavailableError(f"clip inference failed: {type(exc).__name__}: {exc}") from exc
    return result


# ---------------------------------------------------------------------------
# Dispatch: neues Modell nur, wenn es ausdruecklich gewaehlt ist; Altmodelle unveraendert
# ---------------------------------------------------------------------------
EARS_MODELS = {
    "qwen3-asr-1.7b": "transcribe",
    "moss-audio-8b-instruct": "understand",
    "pyannote-community-1": "diarize",
    "songformer": "analyze",
    "beat-this": "analyze",
    "clip-vit-l14": "image.embed",
}


def transcribe_dispatch(model_id: str, definition: ModelDefinition, payload: Dict[str, Any]) -> Any:
    if model_id == "qwen3-asr-1.7b" or "qwen3-asr" in (definition.repository or "").lower():
        return qwen3_asr_transcribe(model_id, definition, payload)
    from handlers import hf_transcribe

    return hf_transcribe(model_id, definition, payload)


def understand_dispatch(model_id: str, definition: ModelDefinition, payload: Dict[str, Any]) -> Any:
    if model_id.startswith("moss-audio") or "moss-audio" in (definition.repository or "").lower():
        return moss_audio_understand(model_id, definition, payload)
    from handlers_runpod import qwen2_audio_understand

    return qwen2_audio_understand(model_id, definition, payload)


def diarize_dispatch(model_id: str, definition: ModelDefinition, payload: Dict[str, Any]) -> Any:
    """community-1 immer ueber 4.x. pyannote 3.1 ueber den alten Handler – ausser
    das Image hat schon pyannote.audio 4.x (dort gibt es ``use_auth_token`` nicht mehr)."""
    if model_id == "pyannote-community-1" or "community-1" in (definition.repository or ""):
        return pyannote4_diarize(model_id, definition, payload)
    try:
        major = pyannote_major_version()
    except ModelUnavailableError:
        major = 0
    if major >= 4:
        return pyannote4_diarize(model_id, definition, payload)
    from handlers_runpod import pyannote_diarize

    return pyannote_diarize(model_id, definition, payload)


def analyze_dispatch(model_id: str, definition: ModelDefinition, payload: Dict[str, Any]) -> Any:
    if model_id == "songformer" or (definition.repository or "").lower() == "aslp-lab/songformer":
        return songformer_structure(model_id, definition, payload)
    if model_id == "beat-this" or "beat_this" in (definition.repository or "").lower():
        return beat_this_track(model_id, definition, payload)
    from handlers import essentia_analyze

    return essentia_analyze(model_id, definition, payload)


def embed_dispatch(model_id: str, definition: ModelDefinition, payload: Dict[str, Any]) -> Any:
    if model_id.startswith("clip-") or "openai/clip" in (definition.repository or "").lower():
        return clip_embed(model_id, definition, payload)
    from handlers import hf_embed

    return hf_embed(model_id, definition, payload)
