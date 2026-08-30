"""
sampleMONK – stem-ai Service (Separater Container)
--------------------------------------------------
FastAPI-basierter Demucs-Service. Trennt eine Audiodatei in Stems und
liefert sie als herunterladbare WAV-Dateien aus.

Robustheit:
  * Upload-Limit (AI_MAX_UPLOAD_MB, Default 50 MB) + Typ-Prüfung
  * Lazy-Loading + GPU-Detect (einmalig pro Prozess)
  * Stems werden über /stem-file/{token}/{name} ausgeliefert (keine
    rohen Server-Pfade in der Antwort, kein Path-Traversal)
  * Temp-Verzeichnisse werden aufgeräumt (Ring-Puffer, max. 10 Sessions)
  * Fehlerantworten ohne Traceback (kein Information-Leak)
  * Separation mit konfigurierbarem Timeout
"""

import asyncio
import logging
import os
import secrets
import shutil
import tempfile
import threading
import time
from typing import Annotated, Optional

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("samplemonk.stem-ai")

app = FastAPI(title="sampleMONK stem-ai", version="2.0.0")

MAX_UPLOAD_BYTES = int(os.environ.get("AI_MAX_UPLOAD_MB", "50")) * 1024 * 1024
SEPARATION_TIMEOUT = float(os.environ.get("AI_SEPARATION_TIMEOUT_SEC", "900"))
ALLOWED_SUFFIXES = {".wav", ".mp3", ".flac", ".ogg", ".m4a", ".aiff", ".aif"}
STAGE_NAMES = {"vocals", "bass", "drums", "other"}

# --------------------------------------------------------------------------- #
# Geräte-Detektion + Lazy-Loading
# --------------------------------------------------------------------------- #
_device_lock = threading.Lock()
_device: Optional[str] = None
_separator_lock = threading.Lock()
_separator = None


def resolve_device() -> str:
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
            logger.warning("torch fehlt/%s; force cpu", exc)
            _device = "cpu"
        logger.info("GPU-Auto-Detect: %s", _device)
        return _device


def get_separator():
    global _separator
    if _separator is not None:
        return _separator
    with _separator_lock:
        if _separator is not None:
            return _separator
        from demucs.api import Separator
        model = os.environ.get("AI_DEMUCS_MODEL", "htdemucs")
        device = resolve_device()
        half = device == "cuda" and not os.environ.get("AI_NO_HALF")
        logger.info("Lade Demucs (%s) auf %s ...", model, device)
        _separator = Separator(model=model, device=device, half=half)
        logger.info("Demucs bereit.")
        return _separator


# --------------------------------------------------------------------------- #
# Temp-Session-Registry (token -> dir). Ring-Puffer mit Grace-Zeit.
# --------------------------------------------------------------------------- #
_sessions_lock = threading.Lock()
# P-15: token -> (tmp_dir, created_monotonic). Sessions werden erst nach Ablauf
# der Grace-Zeit verdrängt, damit laufende Downloads nicht ins Leere greifen.
_sessions: dict[str, tuple[str, float]] = {}
MAX_SESSIONS = int(os.environ.get("AI_MAX_STEM_SESSIONS", "10"))
SESSION_GRACE_SEC = float(os.environ.get("AI_STEM_SESSION_GRACE_SEC", "1800"))


def register_session(tmp_dir: str) -> str:
    token = secrets.token_urlsafe(12)
    now = time.monotonic()
    with _sessions_lock:
        _sessions[token] = (tmp_dir, now)
        # Älteste Sessions aufräumen – aber nur, wenn die Grace-Zeit um ist.
        while len(_sessions) > MAX_SESSIONS:
            oldest_token = next(iter(_sessions))
            oldest_dir, oldest_at = _sessions[oldest_token]
            if now - oldest_at < SESSION_GRACE_SEC:
                break
            _sessions.pop(oldest_token, None)
            shutil.rmtree(oldest_dir, ignore_errors=True)
    return token


def session_dir(token: str) -> str:
    with _sessions_lock:
        entry = _sessions.get(token)
        return entry[0] if entry else ""


def drop_session(token: str) -> None:
    with _sessions_lock:
        entry = _sessions.pop(token, None)
    if entry:
        shutil.rmtree(entry[0], ignore_errors=True)


# --------------------------------------------------------------------------- #
# Endpunkte
# --------------------------------------------------------------------------- #
@app.get("/health")
async def health():
    return {"status": "ok", "device": resolve_device()}


@app.get(
    "/stem-file/{token}/{name}",
    responses={
        404: {"description": "Unbekannter Stem, Session oder Datei"},
    },
)
async def stem_file(token: str, name: str):
    """Liefert eine zuvor erzeugte Stem-Datei sicher aus (kein Path-Traversal)."""
    if name not in STAGE_NAMES:
        raise HTTPException(status_code=404, detail="Unbekannter Stem")
    base = session_dir(token)
    if not base:
        raise HTTPException(status_code=404, detail="Session unbekannt oder abgelaufen")
    path = os.path.join(base, "stems", f"{name}.wav")
    if not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="Stem nicht gefunden")
    return FileResponse(path, media_type="audio/wav", filename=f"{name}.wav")


@app.post(
    "/separate-stems",
    responses={
        415: {"description": "Nicht unterstütztes Audio-Format"},
        413: {"description": "Upload zu groß"},
        504: {"description": "Separation Timeout"},
        500: {"description": "Interner Fehler"},
    },
)
# NOSONAR
async def separate_stems(file: Annotated[UploadFile, File()]):
    """Trennt eine hochgeladene Audiodatei in Stems (vocals/bass/drums/other)."""
    tmp_dir = ""
    registered = False
    try:
        suffix = os.path.splitext(file.filename or "")[1].lower() or ".wav"
        if suffix not in ALLOWED_SUFFIXES:
            raise HTTPException(status_code=415, detail=f"Nicht unterstütztes Format: {suffix}")

        tmp_dir = tempfile.mkdtemp(prefix="stemai_")
        in_path = os.path.join(tmp_dir, "input" + suffix)

        # Upload mit Größenlimit streamen (Datei-Schreiben im Executor, S7493).
        chunks: list[bytes] = []
        written = 0
        while True:
            chunk = await file.read(1024 * 1024)
            if not chunk:
                break
            written += len(chunk)
            if written > MAX_UPLOAD_BYTES:
                raise HTTPException(status_code=413, detail=f"Upload zu groß (max. {MAX_UPLOAD_BYTES // (1024 * 1024)} MB)")
            chunks.append(chunk)
        await file.close()

        def _write_input() -> None:
            with open(in_path, "wb") as f:
                for chunk in chunks:
                    f.write(chunk)

        await asyncio.to_thread(_write_input)

        sep = get_separator()
        sep_fn = getattr(sep, "separate_audio_file", None) or \
                 getattr(sep, "separate_audio_file_v1", None)
        if sep_fn is None:
            raise RuntimeError("Separator-API nicht gefunden (HTDemucs).")

        # Separation mit Timeout (Demucs kann lange laufen).
        _, separated = await asyncio.wait_for(
            asyncio.to_thread(sep_fn, in_path), timeout=SEPARATION_TIMEOUT,
        )

        # Stems als WAV schreiben (soundfile blockiert -> Executor).
        def _write_stems() -> list[str]:
            import soundfile as sf
            sr = int(getattr(sep, "samplerate", 44100) or 44100)
            stems_dir = os.path.join(tmp_dir, "stems")
            os.makedirs(stems_dir, exist_ok=True)
            written_names: list[str] = []
            for stem_name, wav in separated.items():
                if stem_name not in STAGE_NAMES:
                    continue
                path = os.path.join(stems_dir, f"{stem_name}.wav")
                sf.write(path, wav, sr)
                written_names.append(stem_name)
            return written_names

        token = register_session(tmp_dir)
        registered = True
        stem_names = await asyncio.to_thread(_write_stems)
        raw_urls = {name: f"/stem-file/{token}/{name}.wav" for name in stem_names}

        # Kompatibel zur Frontend-Schnittstelle (5 semantische Stem-Keys).
        other = raw_urls.get("other", "")
        stems = {
            "vocals": raw_urls.get("vocals", ""),
            "lows": raw_urls.get("bass", other),
            "mids": other,
            "highs": other,
            "melody": other or raw_urls.get("drums", ""),
        }

        return JSONResponse({
            "status": "success",
            "stems": stems,
            "device": resolve_device(),
            "sampleRate": int(getattr(sep, "samplerate", 44100) or 44100),
        })

    except HTTPException:
        raise
    except asyncio.TimeoutError:
        logger.error("Stem-Separation Timeout nach %ss", SEPARATION_TIMEOUT)
        return JSONResponse({"status": "error", "error": f"Timeout nach {SEPARATION_TIMEOUT}s"}, status_code=504)
    except Exception as exc:
        logger.exception("Stem-Separation fehlgeschlagen")
        return JSONResponse({"status": "error", "error": str(exc)}, status_code=500)
    finally:
        # Fehlerpfad: Temp-Verzeichnis sofort aufräumen. Bei Erfolg ist es in
        # der Session-Registry registriert und wird über den Ring-Puffer bzw.
        # drop_session entfernt.
        if tmp_dir and not registered:
            shutil.rmtree(tmp_dir, ignore_errors=True)
