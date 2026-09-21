#!/usr/bin/env python3
"""
Gemeinsames .env-Lesen fuer die Standalone-Skripte in scripts/.
==============================================================
Die Skripte sind bewusst einzeln aufrufbar (`python3 scripts/<name>.py`) und
haben keine Paketstruktur; sie bringen daher ihren eigenen Schluessel-Wert-Leser
mit. Der lag in vier Varianten vor (fleet-wire, fleet-wake-measure,
generate-mos-samples, verify-vision-endpoint, runpod-warm, runpod-lora-train,
visual-lora-curate) - jetzt genau einmal hier.

Benutzung in einem Skript (laeuft direkt UND per importlib aus den Tests):

    import pathlib, sys
    _LIB = pathlib.Path(__file__).resolve().parents[1] / "lib"
    if str(_LIB) not in sys.path:
        sys.path.insert(0, str(_LIB))
    from envfile import EnvSource, read_env_file  # noqa: E402

Vertrag (dotenv-Verhalten): die Prozessumgebung GEWINNT gegen die Datei; ein
fehlender Schluessel liefert den Default, nie eine Ausnahme.
"""
from __future__ import annotations

import os
import pathlib
from typing import Dict, Optional, Sequence


def read_env_file(path: Optional[pathlib.Path]) -> Dict[str, str]:
    """Liest KEY=VALUE-Zeilen (Kommentar mit `#`, Quotes werden entfernt).

    Fehlende Datei = leeres Dict (kein Fehler) - Aufrufer entscheiden, ob ein
    fehlender Schluessel ein Abbruch ist.
    """
    out: Dict[str, str] = {}
    if not path or not path.exists():
        return out
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, value = line.split("=", 1)
        out[name.strip()] = value.strip().strip('"').strip("'")
    return out


def read_required_env_file(path: pathlib.Path) -> Dict[str, str]:
    """Wie `read_env_file`, aber eine fehlende Datei ist ein Fehler.

    Fuer Werkzeuge, die ohne Deploy-Env nicht arbeiten koennen: ein stiller
    Leerlauf (Login scheitert erst spaeter) waere schwerer zu deuten als ein
    klarer FileNotFoundError.
    """
    if not path.exists():
        raise FileNotFoundError(str(path))
    return read_env_file(path)


def env_from_file(path: pathlib.Path, name: str, default: str = "") -> str:
    """Einzelner Schluessel aus einer .env-Datei (ohne Prozess-Env)."""
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line.startswith(f"{name}="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    return default


class EnvSource:
    """Prozess-Env schlaegt .env-Datei - so gewinnt ein einmaliger Shell-Aufruf."""

    def __init__(self, env_file: Optional[pathlib.Path]) -> None:
        self.file_env = read_env_file(env_file) if env_file else {}

    def get(self, name: str, default: str = "") -> str:
        value = os.environ.get(name)
        if value is None:
            value = self.file_env.get(name)
        return value.strip() if value is not None else default

    def first(self, names: Sequence[str], default: str = "") -> str:
        for name in names:
            value = self.get(name)
            if value:
                return value
        return default

    def flag(self, name: str, default: bool = False) -> bool:
        raw = self.get(name)
        if not raw:
            return default
        return raw.strip().lower() in ("1", "true", "yes", "on", "ja")
