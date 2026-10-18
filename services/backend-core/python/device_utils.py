"""Gemeinsame Geräte-Detektion für KI-Inferenz (celery_app + stem-ai).

Ermittelt das Inferenz-Gerät einmalig pro Prozess (thread-sicher, gecacht).
Priorität: AI_DEVICE (env) > cuda > mps > cpu.

DA-2026-09-29-048: Diese Datei ist die EINE Quelle der Geräte-Wahl. Entfernt
sind (a) die zweite, kopierte Auswertung, die nach dem `return` in Zeile 111
nie mehr erreichbar war, und (b) der ungenutzte ID-Generator: Task-IDs vergibt
Celery selbst (`task.id`), lokal gebaute IDs gibt es im Runtime-Pfad nicht.
"""

import logging
import os
import threading
from typing import Optional

logger = logging.getLogger("audiomonastry.device")

_device_lock = threading.Lock()
_device: Optional[str] = None

#: Erlaubte Werte für AI_DEVICE (nach Normalisierung).
VALID_DEVICES = ("cuda", "mps", "cpu")


def normalize_env_device(raw: str) -> tuple[str, Optional[str]]:
    """Normalisiert AI_DEVICE und liefert (Wert, Warnung).

    DA-2026-09-29-048 (F80): Geräte-Indizes (`cuda:0`, `mps:1`) werden auf das
    Basis-Gerät reduziert - die Runtime kennt genau ein Gerät pro Prozess. Das
    geschieht NICHT still: die Rückgabe trägt die Warnung, die `resolve_device`
    protokolliert und die der Test prueft.

    DA-2026-09-29-048 (F77): Ein unbekannter Wert wird auf "" gesetzt
    (Auto-Detect) und ebenfalls mit Warnung gemeldet.
    """
    value = str(raw or "").strip().lower()
    if not value:
        return "", None

    if value.startswith(("cuda:", "mps:")):
        base = value.split(":", 1)[0]
        warning = f"AI_DEVICE={value}: Geräte-Index wird ignoriert, nutze {base}"
        value = base
    else:
        warning = None

    if value not in VALID_DEVICES:
        return "", (
            f"AI_DEVICE={value} ungültig (erwartet: {', '.join(VALID_DEVICES)}); "
            "falle auf Auto-Detect zurück"
        )
    return value, warning


def resolve_device() -> str:
    """Bestimmt das Inferenz-Gerät. Priorität: env > cuda > mps > cpu.

    Behandelt ungültige Werte, Geräte-Indizes und CUDA-spezifische Indizes.
    Thread-sicher durch Lock: der Lesezugriff auf `_device` passiert
    ausschliesslich innerhalb des Locks (DA-2026-09-29-048, F76).
    """
    global _device

    env_dev, env_warning = normalize_env_device(os.environ.get("AI_DEVICE", ""))
    if env_warning:
        logger.warning("%s", env_warning)

    with _device_lock:
        if _device is not None:
            return _device

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


def half_precision_compatible() -> bool:
    """Meldet, ob fp16 auf diesem Gerät sinnvoll ist - gesetzt wird hier nichts.

    DA-2026-09-29-049 (F82): Der alte Docstring behauptete "Nutzt fp16 auf CUDA
    und MPS" - die Funktion nutzt nichts, sie beantwortet nur die Frage. Die
    Aufrufer (celery_app.py:88 `half=`, :106 `torch_dtype=`) entscheiden damit.
    """
    dev = resolve_device()
    return dev in ("cuda", "mps")
