"""
AudioMONASTRY AI Runtime – RP4 voice (+ Gesang auf RP3): Handler FLEET-P1-007 bis -010
====================================================================================
Duenne Adapter fuer die Modelle des voice-Pods (docs/AI_FLEET_STARTPLAN.md, RP4)
und den Gesangspfad auf RP3:

- ``qwen3_tts_clone``      – Qwen3-TTS-12Hz-0.6B-Base, Stimm-Cloning aus einem
  Referenz-Audio (FLEET-P1-007). Task ``tts`` -> dieselbe TTS-Prioritaet wie jede
  Sprachausgabe (Server-Warteschlange podJobQueue.ts: tts vor LEGO).
- ``moss_soundeffect``     – MOSS-SoundEffect-v2.0, SFX 48 kHz, hoechstens 30 s
  (FLEET-P1-008). ``warmup_moss_soundeffect`` laeuft beim Pod-Start
  (``run_startup_warmups``, app.py), /ready meldet erst danach 200.
- ``acestep_context_task`` – ACE-Step 1.5 lego/extract/complete/repaint mit
  gehaertetem Audio-Eingang ``contextAudio`` (FLEET-P1-009); lego/extract/complete
  nur auf ``acestep-v15-xl-base``. Abbruchpunkt vor jedem Diffusionsschritt
  (Forward-Pre-Hook am DiT-Decoder) fuer ``POST /cancel/{id}``.
- ``acestep_sing``         – Gesang ueber ACE-Step-Lyrics (Task ``sing``,
  ``acestep-v15-xl-sft`` auf RP3, FLEET-P1-010).

Grundsaetze (Vorbild handlers_stems.py):

* Repository UND Revision kommen aus dem Manifest-Eintrag; VAE und Text-Encoder
  der XL-Modelle aus ``acestep-v15-shared`` (ebenfalls Manifest). Offline
  (``HF_HUB_OFFLINE=1``, Pod) wird nur aus dem lokalen Cache gelesen.
* Kein Rueckfall auf ein anderes Modell: fehlt ein Paket, eine Datei oder passt ein
  Hash nicht, bricht der Handler mit klarer Meldung ab. ACE-Step darf NICHT selbst
  nachladen (sein Auto-Download wird pro Instanz abgeschaltet).
* Eingaben werden gegen JSON-Schemata geprueft (``*_SCHEMA``), Audio gegen Groesse,
  Dauer, Abtastrate, Kanaele und NaN/Inf.
* bf16 auf CUDA (Qwen3-TTS: dtype; MOSS: torch_dtype; ACE-Step: dtype des
  AceStepHandler wird nach dem Start geprueft), fp32 auf CPU.

NICHT auf GPU verifiziert (Stand 2026-10-13): kein Handler ist auf einem Pod
gelaufen. Belegt sind nur Mock-Tests ohne GPU (tests/test_voice_handlers.py):
huggingface_hub, torch, qwen_tts, moss_soundeffect_v2 und acestep sind dort
gefaelscht. Die APIs sind aus den gepinnten Quellen gelesen (``*_PIN``).
"""
from __future__ import annotations

import base64
import hashlib
import importlib
import io
import math
import os
import re
import shutil
import sys
import tempfile
import threading
import time
from typing import Any, Callable, Dict, List, Optional, Tuple

from model_manager import ModelDefinition, ModelUnavailableError
from pod_jobs import CancelToken, JobCancelled, current_cancel_token

# ---------------------------------------------------------------------------
# Code-Pins (gelesen am 2026-10-13; die Images bauen genau diese Staende)
# ---------------------------------------------------------------------------
#: ACE-Step 1.5 (MIT). `git clone --depth 1` am 2026-10-13, HEAD gelesen.
#: Gelesene Vertraege: acestep/inference.py (GenerationParams, GenerationConfig,
#: generate_music: llm_handler=None ist erlaubt, use_lm wird dann False),
#: core/generation/handler/init_service_orchestrator.py (initialize_service,
#: dtype bf16 auf CUDA mit bf16-Unterstuetzung), model_downloader.py
#: (MAIN_MODEL_COMPONENTS -> Auto-Download, den wir abschalten),
#: models/xl_base/modeling_*.py (Diffusionsschleife ruft self.decoder je Schritt).
ACESTEP_PIN = {
    "repository": "https://github.com/ace-step/ACE-Step-1.5",
    "commit": "ca1e85fe9430179831e6bc6be790c332190a3866",
}
#: MOSS-SoundEffect v2 Inferenzcode (Apache-2.0), Unterordner moss_soundeffect_v2.
#: Gelesen: pipeline_moss_soundeffect.py (from_pretrained(dir, torch_dtype, device),
#: __call__(prompt, seconds, num_inference_steps, cfg_scale, sigma_shift, seed,
#: negative_prompt) -> (B, C, T); immer 30-s-Latent, Ausgabe auf `seconds` gekuerzt),
#: diffsynth/pipelines/wan_audio.py (torch.compile + triton.cudagraphs).
MOSS_SFX_PIN = {
    "repository": "https://github.com/OpenMOSS/MOSS-TTS",
    "subdir": "moss_soundeffect_v2",
    "commit": "934d6826b084c46a0d033402174d5f8ac4ed2519",
}
#: qwen-tts (Apache-2.0): Version aus requirements-voice-ai.lock; Quelle
#: github.com/QwenLM/Qwen3-TTS @ 022e286b98fbec7e1e916cb940cdf532cd9f488e (Version
#: 0.1.1): Qwen3TTSModel.generate_voice_clone(text, language, ref_audio=(np, sr),
#: ref_text, x_vector_only_mode, non_streaming_mode) -> (wavs, sr).
QWEN_TTS_PIN = {"package": "qwen-tts==0.1.1", "commit": "022e286b98fbec7e1e916cb940cdf532cd9f488e"}

_PIN_REQUIRED = "PIN-ERFORDERLICH"
_SHA_RE = re.compile(r"^[0-9a-f]{40}$")

# ---------------------------------------------------------------------------
# Grenzen
# ---------------------------------------------------------------------------
#: Stimm-Cloning: Qwen nennt "3-second rapid voice clone" (README des Repos).
CLONE_REF_MIN_SECONDS = 3.0
CLONE_REF_MAX_SECONDS = 30.0
CLONE_REF_MAX_BYTES = 10 * 1024 * 1024
CLONE_TEXT_MAX_CHARS = 1000
CLONE_REF_TEXT_MAX_CHARS = 500

#: MOSS-SoundEffect: model_index.json `sample_rate` 48000, `max_inference_seconds` 30.
SFX_SAMPLE_RATE = 48000
SFX_MAX_SECONDS = 30.0
SFX_MIN_SECONDS = 0.5
SFX_DEFAULT_SECONDS = 10.0
#: Empfohlene Werte aus dem HF-README (num_inference_steps 100, cfg 4.0, shift 5.0).
SFX_DEFAULT_STEPS = 100
SFX_DEFAULT_CFG = 4.0
SFX_DEFAULT_SHIFT = 5.0
#: SHA-256 (LFS-oid) je Datei, gelesen 2026-10-13 aus
#: https://huggingface.co/api/models/OpenMOSS-Team/MOSS-SoundEffect-v2.0/tree/<rev>/<dir>.
#: vae_128d_48k.pth ist ein Pickle ("Full model object") -> wird NIE ungeprueft geladen.
#: Text-Encoder (Qwen3-1.7B, bf16) = 3,44 + 0,62 GB -> Befund "Textencoder-Anteil".
MOSS_SFX_FILES: Dict[str, str] = {
    "vae/vae_128d_48k.pth": "07e6139ff33bd21ba8a7a7f40ed24aab13ac0d100cd686f8a9f3e03dc5251cb1",
    "transformer/diffusion_pytorch_model.safetensors": "bda86e4d6730ff47cea47851d219880191e9d21d4d264b21a6ffe7cb2db9dfb0",
    "text_encoder/model-00001-of-00002.safetensors": "169ad53ec313c3a34b06c0809216e4fc072cce444a5d4ff2b59690d064130ed5",
    "text_encoder/model-00002-of-00002.safetensors": "912becff8d60672aa8628ef08c05898d9adf17c2ad4ae3caf99b065622fdeff9",
}
MOSS_SFX_REVISION = "e35df4d82fbe87fcd5d14e5d100e349c0c3c076d"

#: ACE-Step-Kontext (LEGO): je Spur / gesamt (dekodierte Bytes) und Dauer.
CONTEXT_MAX_TRACKS = 8  # = comfyui_adapter.ACE_STEP_MAX_CONTEXT_TRACKS = AI_MUSIC_CONTEXT_MAX_TRACKS
CONTEXT_TRACK_MAX_BYTES = 64 * 1024 * 1024
CONTEXT_TOTAL_MAX_BYTES = 192 * 1024 * 1024
CONTEXT_MIN_SECONDS = 0.5
CONTEXT_MAX_SECONDS = 600.0  # ACE-Step `duration` 10 ~ 600
AUDIO_MIN_RATE = 8000
AUDIO_MAX_RATE = 192000
#: Base/SFT brauchen laut GenerationParams-Doku 32-100 Schritte (turbo: 8).
ACESTEP_DEFAULT_STEPS = 32
ACESTEP_MAX_STEPS = 100
ACESTEP_BASE_ONLY_TASKS = ("lego", "extract", "complete")
ACESTEP_LEGO_MODEL = "acestep-v15-xl-base"

#: Gesang (ACE-Step-Lyrics): GenerationParams `lyrics` < 4096 Zeichen.
SING_LYRICS_MAX_CHARS = 4096
SING_MIN_SECONDS = 10.0
SING_MAX_SECONDS = 240.0
SING_DEFAULT_SECONDS = 30.0
SING_DEFAULT_CAPTION = "solo vocal, clear expressive singing voice, sparse accompaniment"
#: acestep/constants.py VALID_LANGUAGES (Auszug, den wir abbilden).
ACESTEP_VOCAL_LANGUAGES = frozenset(
    {"de", "en", "es", "fr", "it", "ja", "ko", "nl", "pl", "pt", "ru", "sv", "tr", "uk", "zh", "unknown"}
)

#: VAE + Text-Encoder der XL-Modelle (Manifest-Eintrag, Repo ACE-Step/Ace-Step1.5).
ACESTEP_SHARED_MODEL_ID = "acestep-v15-shared"
ACESTEP_SHARED_COMPONENTS = ("vae", "Qwen3-Embedding-0.6B")
ACESTEP_SHARED_PATTERNS = tuple(f"{c}/*" for c in ACESTEP_SHARED_COMPONENTS)

#: vLLM/nano-vllm des 5Hz-LM-Planers: harter Deckel fuer gpu_memory_utilization.
#: GESCHAETZT (docs/AI_FLEET_STARTPLAN.md: ca. 15 GB von 44,4 GiB der A40), nicht
#: gemessen - nachziehen mit FLEET-P1-011. Eine Umgebung darf nur NACH UNTEN abweichen.
ACESTEP_LM_GPU_MEMORY_UTILIZATION = 0.33
ACESTEP_LM_GPU_MEMORY_UTILIZATION_STATUS = "geschaetzt"
LM_GPU_MEMORY_ENV = "ACESTEP_LM_GPU_MEMORY_UTILIZATION"


# ---------------------------------------------------------------------------
# JSON-Schemata (Teilmenge von JSON Schema, eigener Pruefer ohne Abhaengigkeit)
# ---------------------------------------------------------------------------
CLONE_SCHEMA: Dict[str, Any] = {
    "type": "object",
    "required": ["text", "refAudio"],
    "properties": {
        "text": {"type": "string", "minLength": 1, "maxLength": CLONE_TEXT_MAX_CHARS},
        "language": {"type": "string", "maxLength": 16},
        "refAudio": {"type": "string", "minLength": 16, "maxLength": (CLONE_REF_MAX_BYTES * 4) // 3 + 64},
        "refText": {"type": "string", "maxLength": CLONE_REF_TEXT_MAX_CHARS},
    },
}
SFX_SCHEMA: Dict[str, Any] = {
    "type": "object",
    "required": ["prompt"],
    "properties": {
        "prompt": {"type": "string", "minLength": 1, "maxLength": 500},
        "negativePrompt": {"type": "string", "maxLength": 300},
        "durationSeconds": {"type": "number", "minimum": SFX_MIN_SECONDS, "maximum": SFX_MAX_SECONDS},
        "steps": {"type": "integer", "minimum": 1, "maximum": 200},
        "cfgScale": {"type": "number", "minimum": 0.0, "maximum": 20.0},
        "sigmaShift": {"type": "number", "minimum": 0.1, "maximum": 20.0},
        "seed": {"type": "integer", "minimum": 0, "maximum": 2**31 - 1},
    },
}
CONTEXT_SCHEMA: Dict[str, Any] = {
    "type": "object",
    "required": ["aceTask", "contextAudio"],
    "properties": {
        "aceTask": {"type": "string", "enum": ["lego", "extract", "complete", "repaint"]},
        "contextAudio": {
            "type": "array",
            "minItems": 1,
            "maxItems": CONTEXT_MAX_TRACKS,
            "items": {
                "type": "object",
                "required": ["audioBase64"],
                "properties": {
                    "id": {"type": "string", "maxLength": 128},
                    "audioBase64": {"type": "string", "minLength": 16, "maxLength": (CONTEXT_TRACK_MAX_BYTES * 4) // 3 + 64},
                },
            },
        },
        "prompt": {"type": "string", "maxLength": 512},
        "inferenceSteps": {"type": "integer", "minimum": 1, "maximum": ACESTEP_MAX_STEPS},
        "guidanceScale": {"type": "number", "minimum": 1.0, "maximum": 15.0},
        "seed": {"type": "integer", "minimum": -1, "maximum": 2**31 - 1},
        "contextIds": {"type": "array", "maxItems": CONTEXT_MAX_TRACKS},
    },
}
SING_SCHEMA: Dict[str, Any] = {
    "type": "object",
    "required": ["lyrics"],
    "properties": {
        "lyrics": {"type": "string", "minLength": 1, "maxLength": SING_LYRICS_MAX_CHARS},
        "prompt": {"type": "string", "maxLength": 512},
        "language": {"type": "string", "maxLength": 16},
        "durationSeconds": {"type": "number", "minimum": SING_MIN_SECONDS, "maximum": SING_MAX_SECONDS},
        "bpm": {"type": "integer", "minimum": 30, "maximum": 300},
        "keyscale": {"type": "string", "maxLength": 32},
        "seed": {"type": "integer", "minimum": -1, "maximum": 2**31 - 1},
        "inferenceSteps": {"type": "integer", "minimum": 1, "maximum": ACESTEP_MAX_STEPS},
        "guidanceScale": {"type": "number", "minimum": 1.0, "maximum": 15.0},
    },
}

_JSON_TYPES: Dict[str, Callable[[Any], bool]] = {
    "object": lambda v: isinstance(v, dict),
    "array": lambda v: isinstance(v, list),
    "string": lambda v: isinstance(v, str),
    "boolean": lambda v: isinstance(v, bool),
    "integer": lambda v: isinstance(v, int) and not isinstance(v, bool),
    "number": lambda v: isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(float(v)),
}


def validate_schema(schema: Dict[str, Any], value: Any, path: str = "input") -> None:
    """Prueft `value` gegen das Schema; Fehler -> ModelUnavailableError mit Pfad.

    Zusaetzliche Felder sind erlaubt (der Server schickt z. B. contextIds, track),
    bekannte Felder muessen Typ und Grenzen einhalten.
    """
    expected = schema.get("type")
    if expected and not _JSON_TYPES[expected](value):
        raise ModelUnavailableError(f"{path}: erwartet {expected}, erhalten {type(value).__name__}")
    if "enum" in schema and value not in schema["enum"]:
        raise ModelUnavailableError(f"{path}: {value!r} nicht erlaubt (erlaubt: {', '.join(map(str, schema['enum']))})")
    if isinstance(value, str):
        if len(value) < schema.get("minLength", 0):
            raise ModelUnavailableError(f"{path}: zu kurz (mindestens {schema['minLength']} Zeichen)")
        if "maxLength" in schema and len(value) > schema["maxLength"]:
            raise ModelUnavailableError(f"{path}: zu lang (hoechstens {schema['maxLength']} Zeichen)")
    if expected in ("integer", "number"):
        if "minimum" in schema and value < schema["minimum"]:
            raise ModelUnavailableError(f"{path}={value} kleiner als {schema['minimum']}")
        if "maximum" in schema and value > schema["maximum"]:
            raise ModelUnavailableError(f"{path}={value} groesser als {schema['maximum']}")
    if isinstance(value, list):
        if len(value) < schema.get("minItems", 0):
            raise ModelUnavailableError(f"{path}: mindestens {schema['minItems']} Eintraege")
        if "maxItems" in schema and len(value) > schema["maxItems"]:
            raise ModelUnavailableError(f"{path}: hoechstens {schema['maxItems']} Eintraege")
        if "items" in schema:
            for i, item in enumerate(value):
                validate_schema(schema["items"], item, f"{path}[{i}]")
    if isinstance(value, dict):
        for key in schema.get("required", []):
            if value.get(key) in (None, ""):
                raise ModelUnavailableError(f"{path}.{key} erforderlich")
        for key, sub in (schema.get("properties") or {}).items():
            if key in value and value[key] is not None:
                validate_schema(sub, value[key], f"{path}.{key}")


# ---------------------------------------------------------------------------
# Gemeinsame Bausteine
# ---------------------------------------------------------------------------
def _require(import_name: str, pip_name: str) -> Any:
    try:
        return importlib.import_module(import_name)
    except Exception as exc:  # noqa: BLE001
        raise ModelUnavailableError(f"dependency missing for {import_name} (pip install {pip_name}): {exc}") from exc


def _torch_and_device() -> Tuple[Any, Any]:
    torch = _require("torch", "torch")
    return torch, torch.device("cuda" if torch.cuda.is_available() else "cpu")


def _dtype_for(torch: Any, device: Any) -> Any:
    """bf16 auf CUDA (Plan: bf16 erzwingen), fp32 auf CPU."""
    return torch.bfloat16 if device.type == "cuda" else torch.float32


def _cache_get(key: str, factory: Callable[[], Any]) -> Any:
    from handlers_runpod import _cache_get as cache_get

    return cache_get(key, factory)


def _check_revision(model_id: str, definition: ModelDefinition) -> Tuple[str, str]:
    repo = (definition.repository or "").strip()
    revision = (definition.revision or "").strip()
    if not revision or revision.upper() == _PIN_REQUIRED or not _SHA_RE.fullmatch(revision):
        raise ModelUnavailableError(f"{model_id}: Revision nicht gepinnt ({revision or '-'}) – kein Laden ohne Commit-Pin")
    if repo.count("/") != 1 or repo.startswith(("http:", "https:")):
        raise ModelUnavailableError(f"{model_id}: kein Hugging-Face-Repo ({repo or '-'})")
    return repo, revision


def _offline() -> bool:
    return os.environ.get("HF_HUB_OFFLINE", "").strip() in ("1", "true", "True")


def snapshot(model_id: str, repo: str, revision: str, patterns: Optional[Tuple[str, ...]] = None) -> str:
    """Pfad des HF-Snapshots (Repo + Revision aus dem Manifest). Offline nur Cache."""
    hub = _require("huggingface_hub", "huggingface_hub")
    try:
        path = hub.snapshot_download(
            repo_id=repo,
            revision=revision,
            allow_patterns=list(patterns) if patterns else None,
            local_files_only=_offline(),
        )
    except Exception as exc:  # noqa: BLE001
        raise ModelUnavailableError(
            f"{model_id}: Gewichte nicht verfuegbar ({repo}@{revision}: {type(exc).__name__}: {exc}). "
            "Pod-Start laedt sie aus dem Spiegel (scripts/weights-mirror.py) – kein Rueckfall auf ein anderes Modell."
        ) from exc
    return str(path)


_HASHES: Dict[Tuple[str, int, int], str] = {}
_HASHES_LOCK = threading.Lock()


def sha256_file(path: str) -> str:
    stat = os.stat(path)
    key = (os.path.realpath(path), int(stat.st_size), int(stat.st_mtime_ns))
    with _HASHES_LOCK:
        if key in _HASHES:
            return _HASHES[key]
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            digest.update(block)
    value = digest.hexdigest()
    with _HASHES_LOCK:
        _HASHES[key] = value
    return value


def _manifest_definition(model_id: str) -> ModelDefinition:
    from registry import read_manifest

    for entry in read_manifest().get("models", []):
        if entry.get("id") == model_id:
            return ModelDefinition.from_dict(entry)
    raise ModelUnavailableError(f"{model_id} fehlt im Manifest")


def decode_base64_audio(data: Any, *, max_bytes: int, label: str) -> bytes:
    """Base64/Data-URL -> Bytes. Groesse wird VOR dem Dekodieren begrenzt. Keine URLs."""
    if not isinstance(data, str) or not data.strip():
        raise ModelUnavailableError(f"{label}: Base64-Audio erforderlich (Upload ueber den Server)")
    text = data.strip()
    if text.startswith(("http://", "https://", "file:", "/")):
        raise ModelUnavailableError(f"{label}: URLs/Pfade werden nicht geladen – Audio als Base64 ueber den Server senden")
    if text.startswith("data:"):
        text = text.split(",", 1)[1] if "," in text else ""
    if (len(text) * 3) // 4 > max_bytes + 3:
        raise ModelUnavailableError(f"{label}: zu gross (hoechstens {max_bytes // (1024 * 1024)} MB)")
    try:
        raw = base64.b64decode(text, validate=True)
    except Exception as exc:  # noqa: BLE001
        raise ModelUnavailableError(f"{label}: ungueltiges Base64 ({exc})") from exc
    if len(raw) > max_bytes:
        raise ModelUnavailableError(f"{label}: zu gross (hoechstens {max_bytes // (1024 * 1024)} MB)")
    if len(raw) < 44:
        raise ModelUnavailableError(f"{label}: zu klein fuer eine Audiodatei")
    return raw


def read_audio(raw: bytes, *, label: str, min_seconds: float, max_seconds: float, max_channels: int = 2) -> Tuple[Any, int]:
    """Bytes -> (Samples (T, C) float32, Abtastrate) mit Pruefung von Rate, Dauer, Kanaelen, NaN/Inf."""
    import numpy as np

    sf = _require("soundfile", "soundfile")
    try:
        samples, sr = sf.read(io.BytesIO(raw), dtype="float32", always_2d=True)
    except Exception as exc:  # noqa: BLE001
        raise ModelUnavailableError(f"{label}: Audio nicht lesbar ({type(exc).__name__}: {exc})") from exc
    data = np.asarray(samples, dtype=np.float32)
    if data.ndim == 1:
        data = data[:, None]
    sr = int(sr)
    if not (AUDIO_MIN_RATE <= sr <= AUDIO_MAX_RATE):
        raise ModelUnavailableError(f"{label}: Abtastrate {sr} Hz ausserhalb [{AUDIO_MIN_RATE}, {AUDIO_MAX_RATE}]")
    if data.shape[1] > max_channels:
        raise ModelUnavailableError(f"{label}: {data.shape[1]} Kanaele, erlaubt sind hoechstens {max_channels}")
    seconds = data.shape[0] / float(sr)
    if seconds < min_seconds:
        raise ModelUnavailableError(f"{label}: {seconds:.2f} s zu kurz (mindestens {min_seconds:g} s)")
    if seconds > max_seconds:
        raise ModelUnavailableError(f"{label}: {seconds:.1f} s zu lang (hoechstens {max_seconds:g} s)")
    if not np.all(np.isfinite(data)):
        raise ModelUnavailableError(f"{label}: Audio enthaelt NaN/Inf")
    return data, sr


def encode_wav(samples: Any, sample_rate: int, subtype: str = "PCM_16") -> str:
    """(T,) oder (T, C) -> WAV-Base64. Werte werden auf [-1, 1] begrenzt (PCM)."""
    import numpy as np

    sf = _require("soundfile", "soundfile")
    data = np.clip(np.asarray(samples, dtype=np.float32), -1.0, 1.0)
    buf = io.BytesIO()
    sf.write(buf, data, int(sample_rate), format="WAV", subtype=subtype)
    return base64.b64encode(buf.getvalue()).decode()


def _to_numpy(value: Any) -> Any:
    import numpy as np

    if hasattr(value, "detach"):
        value = value.detach()
    if hasattr(value, "float") and hasattr(value, "cpu"):
        value = value.float().cpu()
    if hasattr(value, "numpy"):
        value = value.numpy()
    return np.asarray(value, dtype=np.float32)


# ---------------------------------------------------------------------------
# FLEET-P1-007: Qwen3-TTS-12Hz-0.6B-Base – Stimm-Cloning
# ---------------------------------------------------------------------------
def is_qwen3_tts_clone_model(model_id: str, definition: ModelDefinition) -> bool:
    repo = definition.repository or ""
    return model_id == "qwen3-tts-06b-base" or (repo.startswith("Qwen/Qwen3-TTS") and repo.endswith("-Base"))


def _clone_payload(payload: Dict[str, Any]) -> Dict[str, Any]:
    p = dict(payload)
    for alias in ("referenceAudio", "referenceAudioBase64", "speakerWav", "speakerAudio"):
        if not p.get("refAudio") and p.get(alias):
            p["refAudio"] = p[alias]
    if not p.get("refText") and p.get("referenceText"):
        p["refText"] = p["referenceText"]
    if isinstance(p.get("text"), str):
        p["text"] = p["text"].strip()
    if isinstance(p.get("refText"), str):
        p["refText"] = p["refText"].strip()
    validate_schema(CLONE_SCHEMA, p)
    return p


def qwen3_tts_clone(model_id: str, definition: ModelDefinition, payload: Dict[str, Any]) -> Any:
    """Stimm-Cloning: Text in der Stimme des Referenz-Audios (>= 3 s, <= 30 s).

    Mit ``refText`` (Transkript der Referenz) laeuft der ICL-Modus (bessere Qualitaet),
    ohne nur der Sprecher-Vektor (``x_vector_only_mode``). Referenz kommt als Base64
    vom Server (nichts vom Geraet, keine URL).
    """
    from handlers import normalize_tts_language

    p = _clone_payload(payload)
    language = normalize_tts_language(p.get("language"))
    raw = decode_base64_audio(p["refAudio"], max_bytes=CLONE_REF_MAX_BYTES, label="refAudio")
    ref, ref_sr = read_audio(raw, label="refAudio", min_seconds=CLONE_REF_MIN_SECONDS, max_seconds=CLONE_REF_MAX_SECONDS)
    import numpy as np

    mono = ref.mean(axis=1).astype(np.float32)
    if float(np.max(np.abs(mono))) < 1e-4:
        raise ModelUnavailableError("refAudio: Referenz ist stumm")
    repo, revision = _check_revision(model_id, definition)
    _require("qwen_tts", "qwen-tts")
    torch, device = _torch_and_device()
    device_map = f"cuda:{torch.cuda.current_device()}" if device.type == "cuda" else "cpu"
    dtype = _dtype_for(torch, device)

    def factory() -> Any:
        from qwen_tts import Qwen3TTSModel  # type: ignore

        model = Qwen3TTSModel.from_pretrained(repo, revision=revision, device_map=device_map, dtype=dtype)
        kind = getattr(getattr(model, "model", None), "tts_model_type", "base")
        if kind != "base":
            raise ModelUnavailableError(f"{model_id}: {repo} ist kein Base-Modell (tts_model_type={kind!r}) – kein Cloning")
        return model

    model = _cache_get(f"qwen3tts-clone:{model_id}@{revision}", factory)
    ref_text = p.get("refText") or None
    try:
        wavs, out_sr = model.generate_voice_clone(
            text=p["text"],
            language=language,
            ref_audio=(mono, int(ref_sr)),
            ref_text=ref_text,
            x_vector_only_mode=ref_text is None,
            non_streaming_mode=True,
        )
    except ModelUnavailableError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise ModelUnavailableError(f"qwen3-tts clone failed: {type(exc).__name__}: {exc}") from exc
    if not wavs:
        raise ModelUnavailableError("qwen3-tts clone: kein Audio im Ergebnis")
    audio = _to_numpy(wavs[0]).reshape(-1)
    return {
        "audioBase64": encode_wav(audio, int(out_sr)),
        "format": "wav",
        "sampleRate": int(out_sr),
        "durationSeconds": round(audio.shape[0] / float(out_sr), 3),
        "model": model_id,
        "revision": revision,
        "language": language,
        "cloneMode": "icl" if ref_text else "x-vector",
        "referenceSeconds": round(ref.shape[0] / float(ref_sr), 3),
        "dtype": "bf16" if device.type == "cuda" else "fp32",
    }


# ---------------------------------------------------------------------------
# FLEET-P1-008: MOSS-SoundEffect-v2.0 – SFX (48 kHz, <= 30 s)
# ---------------------------------------------------------------------------
MOSS_SFX_ROOT_ENV = "MOSS_SFX_ROOT"
MOSS_SFX_ROOT_DEFAULT = "/opt/moss-tts"


def is_moss_sfx_model(model_id: str, definition: ModelDefinition) -> bool:
    return model_id.startswith("moss-soundeffect") or "MOSS-SoundEffect" in (definition.repository or "")


def _import_moss_pipeline() -> Any:
    root = os.environ.get(MOSS_SFX_ROOT_ENV, "").strip() or MOSS_SFX_ROOT_DEFAULT
    if not os.path.isdir(os.path.join(root, MOSS_SFX_PIN["subdir"])):
        raise ModelUnavailableError(
            f"MOSS-SoundEffect-Code fehlt: {MOSS_SFX_PIN['repository']} @ {MOSS_SFX_PIN['commit']} nach {root} "
            f"auschecken (Umgebung {MOSS_SFX_ROOT_ENV}, Build-Arg AI_INSTALL_MOSS_SFX=1); kein Rueckfall"
        )
    if root not in sys.path:
        sys.path.insert(0, root)
    try:
        module = importlib.import_module(MOSS_SFX_PIN["subdir"])
        return getattr(module, "MossSoundEffectPipeline")
    except Exception as exc:  # noqa: BLE001
        raise ModelUnavailableError(f"MOSS-SoundEffect-Import fehlgeschlagen ({type(exc).__name__}: {exc})") from exc


def verify_moss_files(model_id: str, snapshot_dir: str, revision: str) -> None:
    """Prueft die gepinnten Dateien (Pickle-VAE, DiT, Text-Encoder) per SHA-256."""
    if revision != MOSS_SFX_REVISION:
        raise ModelUnavailableError(
            f"{model_id}: Revision {revision} hat keine Hash-Pins (gepinnt: {MOSS_SFX_REVISION}) – erst MOSS_SFX_FILES nachziehen"
        )
    for rel, expected in MOSS_SFX_FILES.items():
        path = os.path.join(snapshot_dir, rel)
        if not os.path.isfile(path):
            raise ModelUnavailableError(f"{model_id}: Datei {rel} fehlt im Snapshot – Spiegel unvollstaendig")
        actual = sha256_file(path)
        if actual != expected:
            raise ModelUnavailableError(
                f"{model_id}: SHA-256 von {rel} passt nicht (erwartet {expected[:12]}…, ist {actual[:12]}…) – Abbruch"
            )


def load_moss_pipeline(model_id: str, definition: ModelDefinition) -> Any:
    repo, revision = _check_revision(model_id, definition)

    def factory() -> Any:
        pipeline_cls = _import_moss_pipeline()
        snap = snapshot(model_id, repo, revision)
        verify_moss_files(model_id, snap, revision)
        torch, device = _torch_and_device()
        return pipeline_cls.from_pretrained(snap, torch_dtype=_dtype_for(torch, device), device=device.type)

    return _cache_get(f"moss-sfx:{model_id}@{revision}", factory)


def _sfx_payload(payload: Dict[str, Any]) -> Dict[str, Any]:
    p = dict(payload)
    if p.get("durationSeconds") is None and p.get("maxDuration") is not None:
        p["durationSeconds"] = p["maxDuration"]  # Feldname des bisherigen Stable-Audio-Pfads
    if isinstance(p.get("prompt"), str):
        p["prompt"] = p["prompt"].strip()
    validate_schema(SFX_SCHEMA, p)
    return p


def moss_soundeffect(model_id: str, definition: ModelDefinition, payload: Dict[str, Any]) -> Any:
    """SFX aus Text: WAV 48 kHz mono, Dauer 0,5-30 s (Pipeline denoist immer 30 s)."""
    p = _sfx_payload(payload)
    seconds = float(p.get("durationSeconds") or SFX_DEFAULT_SECONDS)
    pipe = load_moss_pipeline(model_id, definition)
    started = time.time()
    try:
        audio = pipe(
            prompt=p["prompt"],
            seconds=seconds,
            num_inference_steps=int(p.get("steps") or SFX_DEFAULT_STEPS),
            cfg_scale=float(p.get("cfgScale") if p.get("cfgScale") is not None else SFX_DEFAULT_CFG),
            sigma_shift=float(p.get("sigmaShift") or SFX_DEFAULT_SHIFT),
            seed=int(p.get("seed") or 0),
            negative_prompt=str(p.get("negativePrompt") or ""),
        )
    except Exception as exc:  # noqa: BLE001
        raise ModelUnavailableError(f"moss-soundeffect failed: {type(exc).__name__}: {exc}") from exc
    data = _to_numpy(audio)
    if data.ndim == 3:
        data = data[0]
    if data.ndim == 2:  # (C, T) -> (T, C)
        data = data.T
    rate = int(getattr(pipe, "sample_rate", SFX_SAMPLE_RATE) or SFX_SAMPLE_RATE)
    if rate != SFX_SAMPLE_RATE:
        raise ModelUnavailableError(f"moss-soundeffect: Abtastrate {rate} Hz statt {SFX_SAMPLE_RATE} Hz – Vertrag gebrochen")
    max_samples = int(round(SFX_MAX_SECONDS * rate))
    if data.shape[0] > max_samples:
        raise ModelUnavailableError(f"moss-soundeffect: {data.shape[0] / rate:.1f} s Ausgabe ueber {SFX_MAX_SECONDS:g} s")
    return {
        "audioBase64": encode_wav(data, rate, subtype="PCM_24"),
        "format": "wav",
        "sampleRate": rate,
        "durationSeconds": round(data.shape[0] / float(rate), 3),
        "model": model_id,
        "revision": definition.revision,
        "inferenceSeconds": round(time.time() - started, 3),
    }


def warmup_moss_soundeffect(model_id: str, definition: ModelDefinition) -> float:
    """Laedt die Pipeline und kompiliert den DiT (torch.compile + CUDA-Graph).

    Das Latent hat immer 30 s (feste Form), daher deckt ein kurzer Lauf mit 2
    Schritten die Kompilierung fuer alle spaeteren Anfragen ab. Liefert Sekunden.
    """
    started = time.time()
    pipe = load_moss_pipeline(model_id, definition)
    try:
        pipe(prompt="warmup: soft wind", seconds=1.0, num_inference_steps=2, cfg_scale=SFX_DEFAULT_CFG,
             sigma_shift=SFX_DEFAULT_SHIFT, seed=0, negative_prompt="")
    except Exception as exc:  # noqa: BLE001
        raise ModelUnavailableError(
            f"{model_id}: torch.compile-Warmup fehlgeschlagen ({type(exc).__name__}: {exc}); "
            "TORCHDYNAMO_DISABLE=1 nur bewusst setzen (dann ohne Kompilierung)"
        ) from exc
    return time.time() - started


#: Modelle mit Start-Warmup (Pod-Start, AI_STARTUP_WARMUP=1).
STARTUP_WARMUPS: Dict[str, Callable[[str, ModelDefinition], float]] = {
    "moss-soundeffect-v2.0": warmup_moss_soundeffect,
}


def run_startup_warmups(manager: Any, log: Callable[..., None] = lambda *a, **k: None) -> List[str]:
    """Warmup aller geladenen Modelle mit Eintrag in STARTUP_WARMUPS. -> Fehlerliste."""
    errors: List[str] = []
    for info in manager.get_model_info():
        model_id = info.get("id")
        warm = STARTUP_WARMUPS.get(model_id)
        if warm is None or not info.get("loaded"):
            continue
        definition = manager.get_definition(model_id)
        if definition is None:
            errors.append(f"warmup {model_id}: Definition fehlt")
            continue
        try:
            seconds = warm(model_id, definition)
            log("INFO", "startup warmup done", model=model_id, seconds=round(seconds, 1))
        except Exception as exc:  # noqa: BLE001
            errors.append(f"warmup {model_id}: {exc}")
            log("ERROR", "startup warmup failed", model=model_id, error=str(exc)[:300])
    return errors


# ---------------------------------------------------------------------------
# ACE-Step 1.5: Checkpoints (DiT + acestep-v15-shared), Laden, Abbruchpunkt
# ---------------------------------------------------------------------------
_COPY_SUFFIXES = (".py", ".json", ".txt", ".md", ".yaml", ".yml", ".model", ".tiktoken")
_WEIGHT_SUFFIXES = (".safetensors", ".bin", ".pt", ".pth", ".ckpt")
_ACESTEP_LOCK = threading.Lock()


def _has_weights(path: str) -> bool:
    for _root, _dirs, files in os.walk(path):
        if any(f.endswith(_WEIGHT_SUFFIXES) for f in files):
            return True
    return False


def _materialize(src: str, dst: str) -> None:
    """Spiegelt einen Snapshot: Text/Code als Kopie (ACE-Step synchronisiert .py-Dateien
    und darf dabei nie in den HF-Cache schreiben), Gewichte als Symlink."""
    for root, _dirs, files in os.walk(src):
        rel = os.path.relpath(root, src)
        target_dir = os.path.join(dst, rel) if rel != "." else dst
        os.makedirs(target_dir, exist_ok=True)
        for name in files:
            source = os.path.realpath(os.path.join(root, name))
            target = os.path.join(target_dir, name)
            if name.endswith(_COPY_SUFFIXES):
                shutil.copyfile(source, target)
            else:
                os.symlink(source, target)


def acestep_config_name(definition: ModelDefinition) -> str:
    return (definition.repository or "").split("/")[-1].strip().lower()


def acestep_checkpoints(model_id: str, definition: ModelDefinition) -> Tuple[str, str]:
    """Baut das ACE-Step-Checkpoint-Verzeichnis aus den gepinnten HF-Snapshots.

    Layout (ACE-Step model_downloader): <ckpt>/<config>, <ckpt>/vae,
    <ckpt>/Qwen3-Embedding-0.6B. Liefert (project_root, checkpoint_dir).
    """
    repo, revision = _check_revision(model_id, definition)
    shared = _manifest_definition(ACESTEP_SHARED_MODEL_ID)
    shared_repo, shared_rev = _check_revision(ACESTEP_SHARED_MODEL_ID, shared)
    config = acestep_config_name(definition)
    project_root = os.environ.get("ACESTEP_PROJECT_ROOT", "").strip() or os.path.join(
        tempfile.gettempdir(), "audiomonastry-acestep"
    )
    # ACE-Step bevorzugt ACESTEP_CHECKPOINTS_DIR vor project_root/checkpoints.
    ckpt = os.environ.get("ACESTEP_CHECKPOINTS_DIR", "").strip() or os.path.join(project_root, "checkpoints")
    dit_snap = snapshot(model_id, repo, revision)
    shared_snap = snapshot(ACESTEP_SHARED_MODEL_ID, shared_repo, shared_rev, ACESTEP_SHARED_PATTERNS)
    if not _has_weights(dit_snap):
        raise ModelUnavailableError(f"{model_id}: keine Gewichte im Snapshot {repo}@{revision}")
    for comp in ACESTEP_SHARED_COMPONENTS:
        if not _has_weights(os.path.join(shared_snap, comp)):
            raise ModelUnavailableError(
                f"{ACESTEP_SHARED_MODEL_ID}: {comp}/ fehlt ({shared_repo}@{shared_rev}) – VAE/Text-Encoder spiegeln "
                "(scripts/weights-mirror.py, EXTRA_MANIFEST_REPOS)"
            )
    with _ACESTEP_LOCK:
        os.makedirs(ckpt, exist_ok=True)
        stamp_path = os.path.join(ckpt, ".audiomonastry-pins")
        stamp = {config: f"{repo}@{revision}", "shared": f"{shared_repo}@{shared_rev}"}
        existing = {}
        if os.path.isfile(stamp_path):
            with open(stamp_path, "r", encoding="utf-8") as fh:
                for line in fh:
                    key, _, value = line.strip().partition("=")
                    if key:
                        existing[key] = value
        for name, src in ((config, dit_snap), *((c, os.path.join(shared_snap, c)) for c in ACESTEP_SHARED_COMPONENTS)):
            key = config if name == config else "shared"
            target = os.path.join(ckpt, name)
            if os.path.isdir(target) and existing.get(key) == stamp[key]:
                continue
            shutil.rmtree(target, ignore_errors=True)
            _materialize(src, target)
        existing.update(stamp)
        with open(stamp_path, "w", encoding="utf-8") as fh:
            fh.write("".join(f"{k}={v}\n" for k, v in sorted(existing.items())))
    return project_root, ckpt


def _offline_precheck(ckpt: str, config: str) -> Callable[..., Any]:
    """Ersatz fuer AceStepHandler._ensure_models_present: prueft, laedt NIE nach.

    ACE-Step verlangt sonst acestep-v15-turbo und lm-1.7B im Checkpoint-Ordner
    (MAIN_MODEL_COMPONENTS) und laedt sie ungepinnt nach – das waere ein stiller
    Modellzugang ausserhalb des Manifests.
    """

    def precheck(**_kwargs: Any) -> Optional[Tuple[str, bool]]:
        missing = [n for n in (config, *ACESTEP_SHARED_COMPONENTS) if not _has_weights(os.path.join(ckpt, n))]
        if missing:
            return f"ERROR: Checkpoints fehlen ({', '.join(missing)}) – kein Auto-Download", False
        return None

    return precheck


def acestep_dit(model_id: str, definition: ModelDefinition) -> Any:
    """AceStepHandler fuer ein XL-Modell (gecacht), bf16 auf CUDA geprueft."""
    project_root, ckpt = acestep_checkpoints(model_id, definition)
    config = acestep_config_name(definition)
    handler_mod = _require("acestep.handler", "acestep (ACE-Step-1.5)")
    torch, device = _torch_and_device()

    def factory() -> Any:
        dit = handler_mod.AceStepHandler()
        if hasattr(dit, "_ensure_models_present"):
            dit._ensure_models_present = _offline_precheck(ckpt, config)
        status, ok = dit.initialize_service(
            project_root=project_root,
            config_path=config,
            device=device.type,
            use_flash_attention=False,
            compile_model=False,
            offload_to_cpu=False,
            quantization=None,
        )
        if not ok:
            raise ModelUnavailableError(f"{model_id}: ACE-Step-Start fehlgeschlagen: {str(status)[:300]}")
        if device.type == "cuda" and getattr(dit, "dtype", None) != torch.bfloat16:
            raise ModelUnavailableError(f"{model_id}: ACE-Step laeuft in {getattr(dit, 'dtype', '?')} statt bf16")
        return dit

    return _cache_get(f"acestep-dit:{config}@{definition.revision}", factory)


def install_step_abort(dit: Any, token: Optional[CancelToken]) -> Tuple[Callable[[], None], Dict[str, Any]]:
    """Abbruchpunkt je Diffusionsschritt: Forward-Pre-Hook am DiT-Decoder.

    Die ACE-Step-Schleife (models/*/modeling_*.py) ruft ``self.decoder`` genau
    einmal pro Schritt; der Hook prueft das Job-Token und wirft ``JobCancelled``.
    -> (entfernen, Zaehler {"steps", "abortPoint"}).
    """
    info: Dict[str, Any] = {"steps": 0, "abortPoint": "none"}
    model = getattr(dit, "model", None)
    target = getattr(model, "decoder", None) or model
    if token is None or target is None or not hasattr(target, "register_forward_pre_hook"):
        info["abortPoint"] = "none" if token is None else "before-after-only"
        return (lambda: None), info

    def hook(_module: Any, _args: Any) -> None:
        info["steps"] += 1
        token.raise_if_cancelled(f"ACE-Step-Diffusionsschritt {info['steps']}")

    handle = target.register_forward_pre_hook(hook)
    info["abortPoint"] = "diffusion-step"
    return handle.remove, info


def run_acestep(
    model_id: str,
    definition: ModelDefinition,
    params: Dict[str, Any],
    *,
    seed: int,
    label: str,
    workdir: str,
) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    """generate_music ohne LM (llm_handler=None), 1 Ergebnis, WAV. -> (audio, info)."""
    inference_mod = _require("acestep.inference", "acestep (ACE-Step-1.5)")
    token = current_cancel_token()
    if token is not None:
        token.raise_if_cancelled(f"{label} vor dem Start")
    dit = acestep_dit(model_id, definition)
    params = dict(params, thinking=False, use_cot_metas=False, use_cot_caption=False, use_cot_language=False)
    config = inference_mod.GenerationConfig(
        batch_size=1,
        use_random_seed=seed < 0,
        seeds=[seed] if seed >= 0 else None,
        audio_format="wav",
    )
    remove, info = install_step_abort(dit, token)
    try:
        result = inference_mod.generate_music(
            dit, None, inference_mod.GenerationParams(**params), config, save_dir=workdir
        )
    except JobCancelled:
        raise
    except Exception as exc:  # noqa: BLE001
        if token is not None and token.cancelled:
            raise JobCancelled(f"{label} abgebrochen") from exc
        raise ModelUnavailableError(f"acestep {label} failed: {type(exc).__name__}: {exc}") from exc
    finally:
        remove()
    # ACE-Step faengt Fehler aus dem Diffusions-Thread ab (success=False) – ein
    # Abbruch kommt deshalb meist so zurueck.
    if token is not None and token.cancelled:
        raise JobCancelled(f"{label} abgebrochen nach {info['steps']} Schritten")
    if not getattr(result, "success", False):
        raise ModelUnavailableError(f"acestep {label} failed: {getattr(result, 'error', '?')}")
    audios = getattr(result, "audios", None) or []
    if not audios or not audios[0].get("path"):
        raise ModelUnavailableError(f"acestep {label}: kein Audio im Ergebnis")
    out_path = os.path.realpath(str(audios[0]["path"]))
    if not out_path.startswith(os.path.realpath(workdir) + os.sep):
        raise ModelUnavailableError(f"acestep {label}: Ergebnis liegt ausserhalb des Arbeitsordners")
    return audios[0], info


def _read_result(audio: Dict[str, Any]) -> Tuple[str, str]:
    path = str(audio["path"])
    with open(path, "rb") as fh:
        data = fh.read()
    return base64.b64encode(data).decode(), os.path.splitext(path)[1].lstrip(".").lower() or "wav"


# ---------------------------------------------------------------------------
# FLEET-P1-009: LEGO/extract/complete/repaint mit gehaertetem contextAudio
# ---------------------------------------------------------------------------
def decode_context_audio(items: List[Dict[str, Any]]) -> List[Tuple[Any, int]]:
    decoded: List[Tuple[Any, int]] = []
    total = 0
    for i, item in enumerate(items):
        label = f"contextAudio[{i}]" + (f" ({item.get('id')})" if item.get("id") else "")
        raw = decode_base64_audio(item.get("audioBase64"), max_bytes=CONTEXT_TRACK_MAX_BYTES, label=label)
        total += len(raw)
        if total > CONTEXT_TOTAL_MAX_BYTES:
            raise ModelUnavailableError(f"contextAudio: zusammen ueber {CONTEXT_TOTAL_MAX_BYTES // (1024 * 1024)} MB")
        samples, sr = read_audio(raw, label=label, min_seconds=CONTEXT_MIN_SECONDS, max_seconds=CONTEXT_MAX_SECONDS)
        decoded.append((samples, sr))
    return decoded


def acestep_context_task(model_id: str, definition: ModelDefinition, payload: Dict[str, Any]) -> Any:
    """lego/extract/complete (nur acestep-v15-xl-base) und repaint mit Vorspuren."""
    from comfyui_adapter import build_acestep_task_params
    from handlers_runpod import mix_context_audio

    validate_schema(CONTEXT_SCHEMA, payload)
    task = payload["aceTask"]
    if task in ACESTEP_BASE_ONLY_TASKS and acestep_config_name(definition) != ACESTEP_LEGO_MODEL:
        raise ModelUnavailableError(
            f"{task}: laeuft nur auf {ACESTEP_LEGO_MODEL} (RP4 voice), nicht auf {model_id} ({definition.repository})"
        )
    try:
        params = build_acestep_task_params(payload, model_id)
    except ValueError as exc:
        raise ModelUnavailableError(str(exc)) from exc
    params["inference_steps"] = int(payload.get("inferenceSteps") or ACESTEP_DEFAULT_STEPS)
    if payload.get("guidanceScale") is not None:
        params["guidance_scale"] = float(payload["guidanceScale"])
    mix, sr = mix_context_audio(decode_context_audio(payload["contextAudio"]))

    sf = _require("soundfile", "soundfile")
    workdir = tempfile.mkdtemp(prefix="acestep-ctx-")
    try:
        src_path = os.path.join(workdir, "context.wav")
        sf.write(src_path, mix, sr)
        params["src_audio"] = src_path
        audio, info = run_acestep(
            model_id, definition, params, seed=int(params.get("seed", -1)), label=params["task_type"], workdir=workdir
        )
        data, fmt = _read_result(audio)
        return {
            "audioBase64": data,
            "format": fmt,
            "sampleRate": int(audio.get("sample_rate", 48000) or 48000),
            "aceTask": task,
            "taskType": params["task_type"],
            "contextIds": payload.get("contextIds") or [],
            "contextSeconds": round(mix.shape[0] / float(sr), 3),
            "model": model_id,
            "revision": definition.revision,
            "abortPoint": info["abortPoint"],
            "steps": info["steps"],
        }
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


# ---------------------------------------------------------------------------
# FLEET-P1-010: Gesang ueber ACE-Step-Lyrics (Task sing, acestep-v15-xl-sft)
# ---------------------------------------------------------------------------
def is_acestep_dit_model(model_id: str, definition: ModelDefinition) -> bool:
    name = acestep_config_name(definition)
    return name.startswith("acestep-v15-") and model_id != ACESTEP_SHARED_MODEL_ID


def _sing_payload(payload: Dict[str, Any]) -> Dict[str, Any]:
    p = dict(payload)
    if not p.get("lyrics") and isinstance(p.get("text"), str):
        # Bark-Vertrag: der Server schickt "♪ text ♪" – fuer ACE-Step zaehlen nur die Worte.
        p["lyrics"] = p["text"].replace("♪", " ").strip()
    if isinstance(p.get("lyrics"), str):
        p["lyrics"] = p["lyrics"].strip()
    if not p.get("prompt") and p.get("caption"):
        p["prompt"] = p["caption"]
    validate_schema(SING_SCHEMA, p)
    return p


def acestep_vocal_language(value: Any) -> str:
    raw = str(value or "").strip().lower().replace("_", "-")
    if not raw:
        return "de"
    base = raw.split("-", 1)[0]
    aliases = {"deutsch": "de", "german": "de", "english": "en", "deu": "de", "ger": "de", "eng": "en"}
    base = aliases.get(base, base)
    if base not in ACESTEP_VOCAL_LANGUAGES:
        raise ModelUnavailableError(f"sing: Sprache {value!r} nicht unterstuetzt ({', '.join(sorted(ACESTEP_VOCAL_LANGUAGES))})")
    return base


def acestep_sing(model_id: str, definition: ModelDefinition, payload: Dict[str, Any]) -> Any:
    """Gesungene Stimme aus Lyrics (text2music mit lyrics, instrumental=False)."""
    if not is_acestep_dit_model(model_id, definition) or "lm" in acestep_config_name(definition).split("-"):
        raise ModelUnavailableError(f"sing: {model_id} ist kein ACE-Step-DiT-Modell (erwartet acestep-v15-xl-sft)")
    p = _sing_payload(payload)
    seed = int(p["seed"]) if p.get("seed") is not None else -1
    params: Dict[str, Any] = {
        "task_type": "text2music",
        "caption": str(p.get("prompt") or SING_DEFAULT_CAPTION).strip(),
        "lyrics": p["lyrics"],
        "instrumental": False,
        "vocal_language": acestep_vocal_language(p.get("language")),
        "duration": float(p.get("durationSeconds") or SING_DEFAULT_SECONDS),
        "inference_steps": int(p.get("inferenceSteps") or ACESTEP_DEFAULT_STEPS),
        "seed": seed,
    }
    if p.get("bpm") is not None:
        params["bpm"] = int(p["bpm"])
    if p.get("keyscale"):
        params["keyscale"] = str(p["keyscale"]).strip()
    if p.get("guidanceScale") is not None:
        params["guidance_scale"] = float(p["guidanceScale"])
    workdir = tempfile.mkdtemp(prefix="acestep-sing-")
    try:
        audio, info = run_acestep(model_id, definition, params, seed=seed, label="sing", workdir=workdir)
        data, fmt = _read_result(audio)
        return {
            "audioBase64": data,
            "format": fmt,
            "sampleRate": int(audio.get("sample_rate", 48000) or 48000),
            "model": model_id,
            "revision": definition.revision,
            "vocalLanguage": params["vocal_language"],
            "durationSeconds": params["duration"],
            "abortPoint": info["abortPoint"],
        }
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


# ---------------------------------------------------------------------------
# 5Hz-LM-Planer (nano-vllm): harter Deckel fuer gpu_memory_utilization
# ---------------------------------------------------------------------------
def lm_gpu_memory_utilization() -> float:
    """Deckel (GESCHAETZT 0,33). Umgebung darf nur senken, nie anheben."""
    raw = os.environ.get(LM_GPU_MEMORY_ENV, "").strip()
    if not raw:
        return ACESTEP_LM_GPU_MEMORY_UTILIZATION
    try:
        value = float(raw)
    except ValueError as exc:
        raise ModelUnavailableError(f"{LM_GPU_MEMORY_ENV}={raw!r} ist keine Zahl") from exc
    if not (0.05 <= value <= ACESTEP_LM_GPU_MEMORY_UTILIZATION):
        raise ModelUnavailableError(
            f"{LM_GPU_MEMORY_ENV}={value} ausserhalb [0.05, {ACESTEP_LM_GPU_MEMORY_UTILIZATION}] (harter Deckel, geschaetzt)"
        )
    return value


def cap_lm_gpu_memory(llm_handler: Any) -> float:
    """Deckelt ACE-Steps adaptive Wahl (LLMHandler.get_gpu_memory_utilization, bis 0,9)."""
    cap = lm_gpu_memory_utilization()
    original = getattr(llm_handler, "get_gpu_memory_utilization", None)
    if original is None:
        raise ModelUnavailableError("LLMHandler ohne get_gpu_memory_utilization – Deckel nicht setzbar, LM nicht starten")

    def capped(*args: Any, **kwargs: Any) -> Tuple[float, bool]:
        ratio, low = original(*args, **kwargs)
        return min(float(ratio), cap), low

    llm_handler.get_gpu_memory_utilization = capped
    return cap
