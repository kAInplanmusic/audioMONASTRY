"""Gemeinsame Geräte-Detektion für KI-Inferenz (celery_app + stem-ai).

Ermittelt das Inferenz-Gerät einmalig pro Prozess (thread-sicher, gecacht).
Priorität: AI_DEVICE (env) > cuda > mps > cpu.
"""

import logging
import os
import threading
from typing import Optional

logger = logging.getLogger("samplemonk.device")

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
