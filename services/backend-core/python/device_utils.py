"""Gemeinsame Geräte-Detektion für KI-Inferenz (celery_app + stem-ai).

Ermittelt das Inferenz-Gerät einmalig pro Prozess (thread-sicher, gecacht).
Priorität: AI_DEVICE (env) > cuda > mps > cpu.
"""

import logging
import os
import threading
import time
import uuid
from typing import Optional

logger = logging.getLogger("audiomonastry.device")

_device_lock = threading.Lock()
_device: Optional[str] = None

# F65: ID-Generierung mit Format-Garantie
_id_counter = 0
_id_counter_lock = threading.Lock()


def generate_id(prefix: str = "id") -> str:
    """Generiert eine eindeutige ID mit Format-Garantie.
    
    Format: {prefix}-{timestamp}-{counter}-{random}
    Beispiel: req-1701234567-123-a1b2c3d4
    """
    global _id_counter
    with _id_counter_lock:
        _id_counter += 1
        counter = _id_counter
    timestamp = int(time.time() * 1000)
    random_part = uuid.uuid4().hex[:8]
    return f"{prefix}-{timestamp}-{counter}-{random_part}"


def resolve_device() -> str:
    """Bestimmt das Inferenz-Gerät. Priorität: env > cuda > mps > cpu.
    
    Behandelt ungültige Werte, Geräte-Indizes und CUDA-spezifische Indizes.
    Thread-sicher durch Lock.
    """
    global _device
    
    env_dev = os.environ.get("AI_DEVICE", "").strip().lower()
    
    # F80: Validiere und normalisiere AI_DEVICE - entferne Indizes
    if env_dev:
        # F80: Entferne Geräte-Indizes (cuda:0, cuda:1 -> cuda)
        if env_dev.startswith(("cuda:", "mps:")):
            base_device = env_dev.split(":")[0]
            logger.warning("AI_DEVICE=%s: Geräte-Index wird ignoriert, nutze %s", env_dev, base_device)
            env_dev = base_device
        
        # F77: Ungültige Werte erkennen und warnen
        if env_dev not in ("cuda", "mps", "cpu"):
            logger.warning(
                "AI_DEVICE=%s ungültig (erwartet: cuda, mps, cpu); "
                "falle auf Auto-Detect zurück",
                env_dev
            )
            env_dev = ""
    
    # F76: Thread-sicherer Zugriff auf _device
    with _device_lock:
        if _device is not None:
            return _device
        
        # F77: Ungültiger Wert -> Warnung und Auto-Detect
        if env_dev == "cpu":
            _device = "cpu"
        elif env_dev == "cuda":
            try:
                import torch
                if torch.cuda.is_available():
                    _device = "cuda"
                else:
                    logger.warning("AI_DEVICE=cuda angefordert, aber CUDA nicht verfügbar; force cpu")
                    _device = "cpu"
            except Exception as exc:
                logger.warning("AI_DEVICE=cuda angefordert, torch nicht verfügbar (%s); force cpu", exc)
                _device = "cpu"
        elif env_dev == "mps":
            try:
                import torch
                if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
                    _device = "mps"
                else:
                    logger.warning("AI_DEVICE=mps angefordert, aber MPS nicht verfügbar; force cpu")
                    _device = "cpu"
            except Exception as exc:
                logger.warning("AI_DEVICE=mps angefordert, torch Fehler (%s); force cpu", exc)
                _device = "cpu"
        else:
            # Auto-Detect
            try:
                import torch
                if torch.cuda.is_available():
                    _device = "cuda"
                elif getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
                    _device = "mps"
                else:
                    _device = "cpu"
            except Exception as exc:
                logger.warning("Auto-Detect fehlgeschlagen (%s); force cpu", exc)
                _device = "cpu"
        
        logger.info("AI_DEVICE final: %s (aus ENV: %s)", _device, os.environ.get("AI_DEVICE", "auto"))
        return _device
    with _device_lock:
        if _device is not None:
            return _device
        env_dev = os.environ.get("AI_DEVICE", "").strip().lower()
        if env_dev in ("cuda", "mps", "cpu"):
            # DA-2026-09-29-040/-041: Die ENV-Angabe wurde bisher ungeprueft uebernommen.
            # Auf einem Host ohne GPU (oder ohne Device-Passthrough) lief damit jede
            # Inferenz in ein hartes 'cuda'-Fehlschlag, obwohl 'cpu' funktioniert haette.
            # Deshalb: Verfuegbarkeit pruefen und mit Warnung auf cpu zurueckfallen.
            if env_dev == "cpu":
                _device = "cpu"
            else:
                try:
                    import torch
                    if env_dev == "cuda" and torch.cuda.is_available():
                        _device = "cuda"
                    elif env_dev == "mps" and getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
                        _device = "mps"
                    else:
                        logger.warning(
                            "AI_DEVICE=%s angefordert, aber nicht verfuegbar; falle auf cpu zurueck",
                            env_dev,
                        )
                        _device = "cpu"
                except Exception as exc:  # pragma: no cover
                    logger.warning("AI_DEVICE=%s angefordert, torch nicht verfuegbar (%s); force cpu", env_dev, exc)
                    _device = "cpu"
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
    """Nutzt fp16 auf CUDA und MPS (Apple Silicon), nie auf CPU."""
    dev = resolve_device()
    return dev in ("cuda", "mps")
