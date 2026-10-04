"""Gemeinsame Geräte-Detektion für KI-Inferenz (celery_app + stem-ai).

Ermittelt das Inferenz-Gerät einmalig pro Prozess (thread-sicher, gecacht).
Priorität: AI_DEVICE (env) > cuda > mps > cpu.
"""

import logging
import os
import threading
from typing import Optional

logger = logging.getLogger("audiomonastry.device")

_device_lock = threading.Lock()
_device: Optional[str] = None


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
    """Nutzt fp16 nur auf cuda (und 'nice' Backends), nie auf cpu."""
    return resolve_device() == "cuda"
