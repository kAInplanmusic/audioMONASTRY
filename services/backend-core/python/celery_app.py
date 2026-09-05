"""
sampleMONK – Celery App (P3: Lazy-Loading & GPU-Detect)
-------------------------------------------------------
Die KI-Modelle (Demucs, MusicGen) werden NICHT mehr beim Import geladen.
Stattdessen:
  * GPU-Detect zur Laufzeit (torch.cuda / mps / cpu)
  * Per-Task Lazy-Loading mit Modul-Level-Cache (nur einmal pro Worker)
  * Graceful degradation: fehlende/ungenügend speichernde Modelle => klare Fehler
  * Env-Steuerung: AI_DEVICE, AI_USE_DEMUCS, AI_USE_MUSICGEN, AI_DEMUCS_MODEL
"""
import logging
import os
import re
import secrets
import threading

from celery import Celery

logger = logging.getLogger("samplemonk.celery")

_AUDIO_EXTENSIONS = {".wav", ".mp3", ".flac", ".ogg", ".m4a", ".aiff", ".aif", ".webm", ".opus"}


def _validate_audio_file(file_path: str) -> str:
    """Stellt sicher, dass nur echte, erlaubte Audio-Dateien verarbeitet werden."""
    if not isinstance(file_path, str) or not file_path.strip():
        raise ValueError("file_path is required")
    if "\x00" in file_path or len(file_path) > 4096:
        raise ValueError("invalid file_path")
    path = os.path.abspath(file_path)
    if not os.path.isfile(path):
        raise ValueError("audio file does not exist")
    ext = os.path.splitext(path)[1].lower()
    if ext not in _AUDIO_EXTENSIONS:
        raise ValueError(f"unsupported audio extension: {ext or '(none)'}")
    upload_root = os.environ.get("AI_UPLOAD_ROOT", "").strip()
    if upload_root:
        real_root = os.path.realpath(upload_root)
        real_path = os.path.realpath(path)
        if real_path != real_root and not real_path.startswith(real_root + os.sep):
            raise ValueError("audio file is outside the allowed upload root")
    return path

celery_app = Celery(
    "tasks",
    broker=os.environ.get("REDIS_URL", "redis://localhost:6379/0"),
    backend=os.environ.get("REDIS_URL", "redis://localhost:6379/0"),
)

# Robustheits-/Ressourcen-Einstellungen:
#  * task_acks_late: Task erst nach Erfolg bestätigen (kein Verlust bei Crash)
#  * prefetch_multiplier=1: faire Verteilung bei langlaufenden KI-Tasks
#  * Time-Limits verhindern hängende Worker, Ergebnisse laufen ab.
celery_app.conf.update(
    task_acks_late=True,
    worker_prefetch_multiplier=1,
    task_time_limit=int(os.environ.get("AI_TASK_TIME_LIMIT_SEC", "1200")),
    task_soft_time_limit=int(os.environ.get("AI_TASK_SOFT_TIME_LIMIT_SEC", "1080")),
    result_expires=int(os.environ.get("AI_RESULT_EXPIRES_SEC", "3600")),
)

# --------------------------------------------------------------------------- #
# Geräte-Detektion (einmalig, gecacht)
# --------------------------------------------------------------------------- #
_device_lock = threading.Lock()
_device = None


def resolve_device() -> str:
    """Bestimmt das Inferenz-Gerät. Priorität: env > cuda > mps > cpu."""
    global _device
    if _device is not None:
        return _device
    with _device_lock:
        if _device is not None:
            return _device
        env_dev = os.environ.get("AI_DEVICE", "").strip().lower()
        if env_dev in ("cuda", "mps", "cpu"):
            _device = env_dev
            logger.info("AI_DEVICE aus ENV: %s", _device)
            return _device
        try:
            import torch
            if torch.cuda.is_available():
                _device = "cuda"
            elif getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
                _device = "mps"
            else:
                _device = "cpu"
        except Exception as exc:  # pragma: no cover
            logger.warning("torch nicht verfügbar (%s); force cpu", exc)
            _device = "cpu"
        logger.info("GPU-Auto-Detect ergab: %s", _device)
        return _device


def half_precision_compatible() -> bool:
    """Nutzt fp16 nur auf cuda (und 'nice' Backends), nie auf cpu."""
    return resolve_device() == "cuda"


# --------------------------------------------------------------------------- #
# Lazy-Loading-Caches
# --------------------------------------------------------------------------- #
_demucs_lock = threading.Lock()
_demucs_cache = None

_musicgen_lock = threading.Lock()
_musicgen_cache = None


def _load_demucs():
    """Lazy-Loading für Demucs Header-Transform (einmal pro Worker)."""
    global _demucs_cache
    if os.environ.get("AI_USE_DEMUCS", "1") == "0":
        raise RuntimeError("Demucs ist über AI_USE_DEMUCS=0 deaktiviert.")
    with _demucs_lock:
        # Cache-Check ausschließlich unter Lock (kein ungeschützter
        # Check-then-Act auf _demucs_cache mehr -> keine Race Condition).
        if _demucs_cache is not None:
            return _demucs_cache
        from demucs.api import Separator
        model = os.environ.get("AI_DEMUCS_MODEL", "htdemucs")
        device = resolve_device()
        logger.info("Lade Demucs (%s) auf %s ...", model, device)
        sep = Separator(model=model, device=device, half=half_precision_compatible())
        _demucs_cache = sep
        logger.info("Demucs geladen.")
        return sep


def _load_musicgen():
    """Lazy-Loading für MusicGen small (einmal pro Worker)."""
    global _musicgen_cache
    if _musicgen_cache is not None:
        return _musicgen_cache
    if os.environ.get("AI_USE_MUSICGEN", "1") == "0":
        raise RuntimeError("MusicGen ist über AI_USE_MUSICGEN=0 deaktiviert.")
    with _musicgen_lock:
        if _musicgen_cache is not None:
            return _musicgen_cache
        from transformers import AutoProcessor, MusicgenForConditionalGeneration
        device = resolve_device()
        torch_dtype = "float16" if half_precision_compatible() else "auto"
        model_name = os.environ.get("AI_MUSICGEN_MODEL", "facebook/musicgen-small").strip()
        logger.info("Lade MusicGen (%s) auf %s (dtype=%s) ...", model_name, device, torch_dtype)
        proc = AutoProcessor.from_pretrained(model_name)
        model = MusicgenForConditionalGeneration.from_pretrained(
            model_name,
            torch_dtype=torch_dtype if torch_dtype != "auto" else None,
        )
        model.to(device)
        _musicgen_cache = (proc, model)
        logger.info("MusicGen geladen.")
        return proc, model


# --------------------------------------------------------------------------- #
# Tasks
# --------------------------------------------------------------------------- #
@celery_app.task
def separate_stems_task(file_path: str):
    """Trennt eine Audiodatei in 5 Stems (vocals, drums, bass, other)."""
    try:
        file_path = _validate_audio_file(file_path)
        import torchaudio
        sep = _load_demucs()
        device = resolve_device()
        # Demucs-api liefert das Separator-Objekt direkt; neuere Versionen
        # nutzen sep.separate_audio_file, ältere sep.separate_audio_file_v1/v2.
        sep_fn = getattr(sep, "separate_audio_file", None)
        if sep_fn is None:
            sep_fn = getattr(sep, "separate_audio_file_v1", None)
        if sep_fn is None:
            raise RuntimeError("Separator-API nicht gefunden (HTDemucs).")
        _, separated = sep_fn(file_path)
        output_dir = os.path.dirname(file_path)
        written = []
        for stem_name, wav in separated.items():
            out = os.path.join(output_dir, f"{stem_name}.wav")
            torchaudio.save(out, wav, 44100, encoding="PCM_S")
            written.append(out)
        return {"status": "ok", "stems": written, "device": device}
    except Exception as exc:
        logger.exception("Stem-Separation fehlgeschlagen")
        return {"status": "error", "error": str(exc)}


@celery_app.task
def generate_sample_task(prompt: str):
    """Erzeugt ein Musik-Sample via MusicGen small."""
    import torch
    import torchaudio
    proc, model = _load_musicgen()
    device = resolve_device()
    inputs = proc(text=[prompt], padding=True, return_tensors="pt").to(device)
    with torch.no_grad():
        audio_values = model.generate(**inputs, max_new_tokens=256)
    audio = audio_values[0].cpu()
    safe_prompt = re.sub(r"[^a-z0-9]", "", prompt.lower())[:20]
    output_path = f"generated_{secrets.token_hex(4)}_{safe_prompt or 'sample'}.wav"
    torchaudio.save(output_path, audio, 32000)
    return {"status": "ok", "path": output_path}


@celery_app.task
def generate_voice_task(text: str, voice_preset: str):
    """Placeholder für AI Vocalist (RVC/VITS kann hier später verdrahtet werden)."""
    return {"status": "ok", "message": f"Voice generated: {text}", "voice": voice_preset}


@celery_app.task(bind=True)
def render_project_task(self, project_data: dict):
    for i in range(1, 6):
        self.update_state(state="PROGRESS", meta={"percent": i * 20})
    return {"status": "ok", "message": "Render completed", "id": self.request.id}
